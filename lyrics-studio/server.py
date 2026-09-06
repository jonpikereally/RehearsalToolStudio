# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "fastapi",
#   "uvicorn",
#   "python-multipart",
#   "mlx-whisper",
#   "mido",
#   "librosa",
#   "numpy",
# ]
# ///
"""Lyrics Studio — local webapp: transcribe song lyrics and export timed MIDI clips.

Run with:  uv run server.py   (serves on http://127.0.0.1:8765, or the next free port)
Everything runs on-device; nothing is uploaded anywhere.
"""
import copy
import difflib
import gzip
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import quoteattr

import mido
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from mido import MetaMessage, Message, MidiFile, MidiTrack
from pydantic import BaseModel

APP_DIR = Path(__file__).resolve().parent
# Where the log and the remembered paths live: beside the code, as they always
# have — or wherever LYRICS_STUDIO_DATA says, which the packaged app sets, since
# an app bundle is not a place to write into.
DATA_DIR = Path(os.environ.get("LYRICS_STUDIO_DATA") or APP_DIR)
DATA_DIR.mkdir(parents=True, exist_ok=True)
MODEL = "mlx-community/whisper-large-v3-turbo"

# Bump on every user-visible change; the page shows this number.
VERSION = "1.15.0"

app = FastAPI(title="Lyrics Studio", version=VERSION)

"""
Closing the window does not close this server — the page is only a client, and
the launcher starts the server detached so the next click is instant and a
long transcription survives a closed tab. Left alone it would sit there for
days holding the Whisper model's weights, which is a gigabyte of memory inside
an app you believe you quit. So it sees itself out: no request for
IDLE_EXIT_MINUTES, nothing in flight, and it exits. An open page heartbeats
once a minute, so "open" always means "alive"; the next click restarts it.
"""
IDLE_EXIT_MINUTES = float(os.environ.get("LYRICS_IDLE_MINUTES", "20"))
LAST_ACTIVITY = time.monotonic()
IN_FLIGHT = 0


def idle_watchdog() -> None:
    while True:
        time.sleep(30)
        if IN_FLIGHT or IDLE_EXIT_MINUTES <= 0:
            continue
        idle_for = time.monotonic() - LAST_ACTIVITY
        if idle_for > IDLE_EXIT_MINUTES * 60:
            try:
                with (DATA_DIR / "server.log").open("a") as f:
                    f.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] "
                            f"idle {idle_for / 60:.0f} min — exiting\n")
            except OSError:
                pass
            os._exit(0)

# Rehearsal Tool Studio pings /api/version to show whether this tool is up,
# then hands sets over by URL. Reads only — every write stays same-origin.
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5177",
    ],
    # The studio drives a transcription from its own page now, which is a POST.
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def surface_errors(request, call_next):
    """A crash must land somewhere readable: the launcher discards stderr, so
    tracebacks go to server.log and, trimmed, back to the page — a bare
    "Internal Server Error" helps nobody.

    Doubles as the idle watchdog's eyes: every request is a sign of life, and
    the in-flight count keeps a fifty-minute transcription from looking idle."""
    global LAST_ACTIVITY, IN_FLIGHT
    LAST_ACTIVITY = time.monotonic()
    IN_FLIGHT += 1
    try:
        return await call_next(request)
    except Exception:
        import traceback
        tb = traceback.format_exc()
        try:
            with (DATA_DIR / "server.log").open("a") as f:
                f.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] {request.url.path}\n{tb}")
        except OSError:
            pass
        return Response(tb[-1200:], status_code=500, media_type="text/plain")
    finally:
        IN_FLIGHT -= 1
        LAST_ACTIVITY = time.monotonic()


@app.get("/api/version")
def version():
    # Names itself, because the port is not proof: anything can hold 8765, and
    # for a while a light-control app did. Whoever is looking for Lyrics
    # Studio checks for this answer, not for a port that is merely busy.
    return {"version": VERSION, "app": "lyrics-studio"}


@app.get("/")
def index():
    return FileResponse(APP_DIR / "index.html")


HOP = 512


def refine_bpm(env, frame_rate: float, guess: float,
               span: float = 0.06, step: float = 0.01) -> float:
    """Score a perfectly periodic beat grid against the onset envelope and keep
    the best-fitting tempo.

    librosa's estimate comes from log-spaced tempogram bins, so it lands close
    but rarely exact (103.4 for a 103 BPM song), and its detected beats are
    placed to fit that same estimate — so measuring them just reproduces the
    error. Over a few minutes, however, a half-BPM error drifts a whole beat,
    so the true tempo gives a sharp peak here.
    """
    import numpy as np

    n = len(env)
    best_bpm, best_score = guess, -float("inf")
    for bpm in np.arange(guess * (1 - span), guess * (1 + span), step):
        period = 60.0 / bpm * frame_rate
        beats = np.arange(int((n - 1) / period))
        if len(beats) < 8:
            continue
        phases = np.arange(0, period, 1.0)
        idx = np.round(phases[:, None] + beats[None, :] * period).astype(int)
        np.clip(idx, 0, n - 1, out=idx)
        score = float(env[idx].mean(axis=1).max())
        if score > best_score:
            best_bpm, best_score = float(bpm), score
    return best_bpm


def detect_bpm(audio_path: str) -> float:
    import librosa
    import numpy as np

    y, sr = librosa.load(audio_path, mono=True, duration=180)
    tempo = librosa.beat.beat_track(y=y, sr=sr, trim=False)[0]
    guess = float(np.atleast_1d(tempo)[0])

    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    if len(env) < 64:
        return round(guess, 2)
    env = (env - env.mean()) / (env.std() + 1e-9)
    bpm = refine_bpm(env, sr / HOP, guess)

    # songs are almost always written at whole or half BPM values
    for grid in (1.0, 0.5):
        snapped = round(bpm / grid) * grid
        if abs(bpm - snapped) <= 0.2:
            return round(snapped, 2)
    return round(bpm, 2)


def isolate_vocals(audio_path: str, workdir: str) -> str:
    subprocess.run(
        ["uvx", "--from", "demucs", "demucs", "--two-stems=vocals", "-o", workdir, audio_path],
        check=True, capture_output=True, text=True, timeout=3600,
    )
    vocals = next(Path(workdir).rglob("vocals.wav"), None)
    if vocals is None:
        raise RuntimeError("demucs produced no vocals.wav")
    return str(vocals)


# ---------------------------------------------------------------------------
# Forced alignment: map the user's official lyrics onto Whisper's word timing
# ---------------------------------------------------------------------------

def _norm(word: str) -> str:
    return re.sub(r"[^\w']", "", word.lower())


def align_lyrics(whisper_segments: list[dict], lyrics_text: str) -> list[dict]:
    """Return new segments built from the user's lyric lines, with timing
    transferred from Whisper's recognized words via sequence alignment."""
    w_words = [w for s in whisper_segments for w in s.get("words", [])]
    if not w_words:
        raise HTTPException(400, "Transcription has no word timestamps to align to.")

    lines = [ln.strip() for ln in lyrics_text.splitlines() if ln.strip()]
    u_words = []  # {text, line_idx, start, end}
    for li, line in enumerate(lines):
        for tok in line.split():
            u_words.append({"text": tok, "line": li, "start": None, "end": None})
    if not u_words:
        raise HTTPException(400, "No words found in the pasted lyrics.")

    sm = difflib.SequenceMatcher(
        a=[_norm(w["text"]) for w in w_words],
        b=[_norm(w["text"]) for w in u_words],
        autojunk=False,
    )
    for op, a0, a1, b0, b1 in sm.get_opcodes():
        if op == "equal":
            for k in range(a1 - a0):
                u_words[b0 + k]["start"] = w_words[a0 + k]["start"]
                u_words[b0 + k]["end"] = w_words[a0 + k]["end"]
        elif op == "replace":
            # spread the user words evenly across the whisper block's time span
            t0, t1 = w_words[a0]["start"], w_words[a1 - 1]["end"]
            n = b1 - b0
            for k in range(n):
                u_words[b0 + k]["start"] = t0 + (t1 - t0) * k / n
                u_words[b0 + k]["end"] = t0 + (t1 - t0) * (k + 1) / n
        # "insert" (extra user words) handled by interpolation below;
        # "delete" (whisper words absent from lyrics) is simply ignored.

    # interpolate any user words that still lack timing
    n = len(u_words)
    for i, w in enumerate(u_words):
        if w["start"] is not None:
            continue
        j = i
        while j < n and u_words[j]["start"] is None:
            j += 1
        prev_end = u_words[i - 1]["end"] if i > 0 else 0.0
        next_start = u_words[j]["start"] if j < n else prev_end + 2.0 * (j - i)
        span = max(next_start - prev_end, 0.1 * (j - i))
        for k in range(i, j):
            w2 = u_words[k]
            w2["start"] = prev_end + span * (k - i) / (j - i)
            w2["end"] = prev_end + span * (k - i + 1) / (j - i)

    # enforce monotonic timing
    t = 0.0
    for w in u_words:
        w["start"] = max(w["start"], t)
        w["end"] = max(w["end"], w["start"] + 0.05)
        t = w["end"]

    # rebuild segments from the user's own line structure
    segments = []
    for li, line in enumerate(lines):
        lw = [w for w in u_words if w["line"] == li]
        if not lw:
            continue
        segments.append({
            "start": lw[0]["start"],
            "end": lw[-1]["end"],
            "text": line,
            "words": [{"text": w["text"], "start": w["start"], "end": w["end"]} for w in lw],
        })
    return segments


class AlignRequest(BaseModel):
    segments: list[dict]
    lyrics: str


@app.post("/api/align")
def align(req: AlignRequest):
    segments = align_lyrics(req.segments, req.lyrics)
    return {"segments": segments, "duration": max(s["end"] for s in segments)}


def measure_onset_lag(audio_path: str, starts: list[float],
                      max_lag: float = 0.45, step: float = 0.01) -> float:
    """How far Whisper's word starts sit from the audio's actual onsets.

    Whisper infers word times from attention rather than from the waveform, and
    they land consistently a little early on sung vocals. Shifting the whole set
    of starts to where they best line up with onset peaks measures that bias
    instead of guessing a fudge factor. Returns seconds to add (0 if unclear).
    """
    import librosa
    import numpy as np

    if len(starts) < 5:
        return 0.0
    try:
        y, sr = librosa.load(audio_path, mono=True)
    except Exception:
        return 0.0
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    if len(env) < 32:
        return 0.0
    env = (env - env.mean()) / (env.std() + 1e-9)
    frame_rate = sr / HOP
    times = np.asarray(starts, dtype=float)

    def score(lag: float) -> float:
        idx = np.round((times + lag) * frame_rate).astype(int)
        idx = idx[(idx >= 0) & (idx < len(env))]
        return float(env[idx].mean()) if len(idx) >= 5 else -np.inf

    lags = np.arange(-max_lag, max_lag + 1e-9, step)
    scores = [score(l) for l in lags]
    best_i = int(np.argmax(scores))
    best_lag, best = float(lags[best_i]), scores[best_i]
    # only correct when the shift is a clear improvement on leaving it alone
    if not np.isfinite(best) or best - score(0.0) < 0.08:
        return 0.0
    return round(best_lag, 3)


def shift_segments(segments: list[dict], lag: float) -> list[dict]:
    if not lag:
        return segments
    for seg in segments:
        seg["start"] = max(0.0, seg["start"] + lag)
        seg["end"] = max(seg["start"] + 0.05, seg["end"] + lag)
        for w in seg.get("words", []):
            w["start"] = max(0.0, w["start"] + lag)
            w["end"] = max(w["start"] + 0.02, w["end"] + lag)
    return segments


def transcribe_file(audio_path: str, language: str, lyrics: str, isolate: bool,
                    workdir: str) -> dict:
    """Core transcription on a file already on disk; returns the response dict
    minus BPM (callers decide where tempo comes from)."""
    import mlx_whisper

    transcribe_path = audio_path
    if isolate:
        try:
            transcribe_path = isolate_vocals(audio_path, workdir)
        except Exception as e:
            raise HTTPException(500, f"Vocal isolation failed: {e}")

    result = mlx_whisper.transcribe(
        transcribe_path,
        path_or_hf_repo=MODEL,
        word_timestamps=True,
        language=language or None,
        # known lyrics bias Whisper toward the right vocabulary
        initial_prompt=(" ".join(lyrics.split())[:800] or None),
    )

    segments = [
        {
            "start": s["start"],
            "end": s["end"],
            "text": s["text"].strip(),
            "words": [
                {"text": w["word"].strip(), "start": w["start"], "end": w["end"]}
                for w in s.get("words", [])
                if w["word"].strip()
            ],
        }
        for s in result["segments"]
        if s["text"].strip()
    ]
    aligned = False
    if lyrics.strip() and segments:
        try:
            segments = align_lyrics(segments, lyrics)
            aligned = True
        except HTTPException:
            pass  # fall back to the raw transcription

    # correct Whisper's systematic early bias against the audio's own onsets
    starts = [w["start"] for s in segments for w in s.get("words", [])]
    lag = measure_onset_lag(transcribe_path, starts or [s["start"] for s in segments])
    segments = shift_segments(segments, lag)

    duration = max((s["end"] for s in segments), default=0)
    return {
        "text": result["text"].strip(),
        "language": result.get("language", ""),
        "duration": duration,
        "segments": segments,
        "aligned": aligned,
        "lag": lag,
    }


@app.post("/api/transcribe")
def transcribe(
    file: UploadFile = File(...),
    language: str = Form(""),
    isolate: bool = Form(False),
    lyrics: str = Form(""),
):
    suffix = Path(file.filename or "song.mp3").suffix or ".mp3"
    with tempfile.TemporaryDirectory() as tmp:
        audio_path = str(Path(tmp) / f"song{suffix}")
        with open(audio_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        bpm = detect_bpm(audio_path)
        out = transcribe_file(audio_path, language, lyrics, isolate, tmp)
    out["bpm"] = bpm
    return out


class MidiRequest(BaseModel):
    segments: list[dict]
    bpm: float = 120
    fineness: str = "word"  # word | line | section
    section_gap: float = 1.8
    offset: float = 0.0   # seconds; negative = lyrics earlier
    pitch: int = 60
    name: str = "lyrics"


def seg_span(seg: dict) -> tuple[float, float]:
    """When a line's word timings are available, use them: Whisper's segment
    boundaries usually start before the first word is actually sung, which
    makes lyric clips land early."""
    words = seg.get("words") or []
    if words:
        return words[0]["start"], words[-1]["end"]
    return seg["start"], seg["end"]


def shift_notes(notes: list[dict], offset: float) -> list[dict]:
    """Nudge every note by `offset` seconds (negative = earlier)."""
    if not offset:
        return notes
    shifted = []
    for n in notes:
        start = max(0.0, n["start"] + offset)
        shifted.append({**n, "start": start, "end": max(start + 0.05, n["end"] + offset)})
    return shifted


def group_notes(segments: list[dict], fineness: str, gap: float) -> list[dict]:
    if fineness == "word":
        return [w for s in segments for w in s.get("words", [])] or [
            {"text": s["text"], **dict(zip(("start", "end"), seg_span(s)))} for s in segments
        ]
    if fineness == "line":
        return [{"text": s["text"], "start": start, "end": end}
                for s in segments for start, end in [seg_span(s)]]
    sections: list[dict] = []
    for s in segments:
        start, end = seg_span(s)
        if sections and start - sections[-1]["end"] < gap:
            sections[-1]["end"] = end
            sections[-1]["text"] += " " + s["text"]
        else:
            sections.append({"text": s["text"], "start": start, "end": end})
    return sections


def build_midi(segments: list[dict], bpm: float, fineness: str, gap: float, pitch: int,
               offset: float = 0.0) -> bytes:
    notes = shift_notes(group_notes(segments, fineness, gap), offset)
    if not notes:
        raise HTTPException(400, "No notes to write.")

    TPB = 480
    sec2tick = lambda s: round(s * bpm / 60 * TPB)

    events = []
    for n in notes:
        start = sec2tick(n["start"])
        end = max(sec2tick(n["end"]), start + sec2tick(0.08))
        events.append((start, 0, MetaMessage("lyrics", text=n["text"])))
        events.append((start, 1, Message("note_on", note=pitch, velocity=100)))
        events.append((end, 2, Message("note_off", note=pitch, velocity=0)))
    events.sort(key=lambda e: (e[0], e[1]))

    mid = MidiFile(ticks_per_beat=TPB)
    track = MidiTrack()
    mid.tracks.append(track)
    track.append(MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0))
    track.append(MetaMessage("track_name", name="Lyrics", time=0))
    now = 0
    for tick, _, msg in events:
        msg.time = tick - now
        now = tick
        track.append(msg)
    track.append(MetaMessage("end_of_track", time=0))

    buf = io.BytesIO()
    mid.save(file=buf)
    return buf.getvalue()


@app.post("/api/midi")
def make_midi(req: MidiRequest):
    data = build_midi(req.segments, req.bpm, req.fineness, req.section_gap, req.pitch,
                      offset=req.offset)
    filename = f"{req.name}.{req.fineness}.mid"
    return Response(
        content=data,
        media_type="audio/midi",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Ableton Live Set export (AbleSet lyrics standard: a "+LYRICS" MIDI track,
# one clip per lyric line, the clip NAME is the lyric text).
# template.xml is AbleSet's own Lyrics Track Generator template (Live 10
# format, which current Live versions open and upgrade); we clone its
# prototype clip per lyric — the same thing their generator does.
# ---------------------------------------------------------------------------

# Elements whose Id lives in the set-wide "pointee" space and must be unique
POINTEE_TAGS = {
    "AutomationTarget", "ModulationTarget", "RemoteableTimeSignature",
    "VolumeModulationTarget", "TranspositionModulationTarget",
    "GrainSizeModulationTarget", "FluxModulationTarget",
    "SampleOffsetModulationTarget",
}


def renumber_pointees(elem, counter: int) -> int:
    for el in elem.iter():
        if el.tag in POINTEE_TAGS and "Id" in el.attrib:
            el.set("Id", str(counter))
            counter += 1
    return counter


def match_clip_slots(track, count: int) -> None:
    """Every track in a set must expose the same number of session clip slots
    as the other tracks; a mismatch crashes Live shortly after loading."""
    for list_path in ("DeviceChain/MainSequencer/ClipSlotList",
                      "DeviceChain/FreezeSequencer/ClipSlotList"):
        holder = track.find(list_path)
        if holder is None:
            continue
        slots = holder.findall("ClipSlot")
        if not slots:
            continue
        template_slot = slots[0]
        for extra in slots[count:]:
            holder.remove(extra)
        while len(holder.findall("ClipSlot")) < count:
            holder.append(copy.deepcopy(template_slot))
        for i, slot in enumerate(holder.findall("ClipSlot")):
            slot.set("Id", str(i))
            value = slot.find("Value")
            if value is not None:
                for c in list(value):
                    value.remove(c)


def build_audio_track(audio: dict, bpm: float, name: str):
    """Return an AudioTrack element with one arrangement clip spanning the
    song, warped 1:1 at the given BPM so it lines up with the lyric clips."""
    track = ET.fromstring((APP_DIR / "audiotrack.xml").read_bytes())
    clip = track.find("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")

    dur, sr = audio["duration"], audio["sample_rate"]
    beats = round(dur * bpm / 60, 6)
    clip.set("Id", "0")
    clip.set("Time", "0")
    clip.find("CurrentStart").set("Value", "0")
    clip.find("CurrentEnd").set("Value", f"{beats:g}")
    loop = clip.find("Loop")
    for tag, val in (("LoopStart", "0"), ("LoopEnd", f"{beats:g}"),
                     ("StartRelative", "0"), ("LoopOn", "false"),
                     ("OutMarker", f"{beats:g}"), ("HiddenLoopStart", "0"),
                     ("HiddenLoopEnd", f"{beats:g}")):
        el = loop.find(tag)
        if el is not None:
            el.set("Value", val)
    clip.find("Name").set("Value", name)
    clip.find("IsWarped").set("Value", "true")
    for tag in ("MarkersGenerated", "IsSongTempoMaster"):
        el = clip.find(tag)
        if el is not None:
            el.set("Value", "false")

    # linear 1:1 warp (two markers, exactly like the donor clip): at the export
    # BPM nothing is stretched, so the audio sits on the same grid as the lyrics
    wm = clip.find("WarpMarkers")
    for c in list(wm):
        wm.remove(c)
    for i, (sec, beat) in enumerate(((0.0, 0.0), (dur, beats))):
        ET.SubElement(wm, "WarpMarker",
                      {"Id": str(i + 1), "SecTime": f"{sec:g}", "BeatTime": f"{beat:g}"})

    sref = clip.find("SampleRef")
    sref.find("DefaultDuration").set("Value", str(round(dur * sr)))
    sref.find("DefaultSampleRate").set("Value", str(sr))
    sref.find("LastModDate").set("Value", str(int(time.time())))

    fr = sref.find("FileRef")
    fr.find("HasRelativePath").set("Value", "true")
    fr.find("RelativePathType").set("Value", "3")  # relative to the .als
    fr.find("Name").set("Value", audio["filename"])
    fr.find("Data").text = ""
    # rel_dirs: path components from the .als to the audio's folder
    # ([] = same folder); hint_dirs: the folder's absolute components,
    # used by Live's sample search if the relative lookup fails
    rel_dirs = audio.get("rel_dirs", ("Samples", "Imported"))
    hint_dirs = audio.get("hint_dirs", rel_dirs)
    for holder, dirs in ((fr.find("RelativePath"), rel_dirs),
                         (fr.find("SearchHint/PathHint"), hint_dirs)):
        if holder is None:
            continue
        for c in list(holder):
            holder.remove(c)
        for i, d in enumerate(dirs):
            ET.SubElement(holder, "RelativePathElement", {"Id": str(i + 1), "Dir": d})
    return track


MIN_CLIP_BEATS = 1 / 32


def sanitize_beat_spans(spans: list[tuple[float, float, str]]) -> list[tuple[float, float, str]]:
    """Force (start, end, text) beat spans to be strictly ordered and
    non-overlapping. Live deletes overlapping/out-of-order arrangement clips
    on load ("wrong clip order") and can crash doing it, so this is required:
    Whisper segments and aligned words can overlap slightly."""
    spans = sorted(spans, key=lambda s: (s[0], s[1]))
    out: list[tuple[float, float, str]] = []
    cursor = 0.0
    for i, (start, end, text) in enumerate(spans):
        start = max(start, cursor)
        next_start = spans[i + 1][0] if i + 1 < len(spans) else float("inf")
        end = max(end, start + MIN_CLIP_BEATS)
        if next_start > start + MIN_CLIP_BEATS:
            end = min(end, next_start)      # never run into the next clip
        out.append((round(start, 6), round(end, 6), text))
        cursor = end
    return out


def arrange_clips(notes: list[dict], bpm: float) -> list[tuple[float, float, str]]:
    return sanitize_beat_spans(
        [(n["start"] * bpm / 60, n["end"] * bpm / 60, n["text"]) for n in notes]
    )


def set_tempo(live_set, bpm: float) -> None:
    """Set the set's tempo. The manual value alone is not enough: the template
    also carries a tempo automation envelope, and the envelope wins — which is
    why exports used to open at the template's 120 BPM."""
    tempo = live_set.find("MasterTrack/DeviceChain/Mixer/Tempo")
    tempo.find("Manual").set("Value", f"{bpm:g}")

    target = tempo.find("AutomationTarget")
    target_id = target.get("Id") if target is not None else None
    envelopes = live_set.find("MasterTrack/AutomationEnvelopes/Envelopes")
    if target_id is None or envelopes is None:
        return
    for envelope in list(envelopes):
        pointee = envelope.find("EnvelopeTarget/PointeeId")
        if pointee is None or pointee.get("Value") != target_id:
            continue
        events = envelope.find("Automation/Events")
        if events is None:
            continue
        for event in events.findall("FloatEvent"):
            event.set("Value", f"{bpm:g}")


def build_als(segments: list[dict], bpm: float, fineness: str, gap: float,
              audio: dict | None = None, name: str = "Song", offset: float = 0.0) -> bytes:
    notes = shift_notes(group_notes(segments, fineness, gap), offset)
    if not notes:
        raise HTTPException(400, "No clips to write.")
    root = ET.fromstring((APP_DIR / "template.xml").read_bytes())
    ls = root.find("LiveSet")

    set_tempo(ls, bpm)
    track = ls.find("Tracks/MidiTrack")
    track.find("Name/EffectiveName").set("Value", "Lyrics +LYRICS")
    un = track.find("Name/UserName")
    if un is not None:
        un.set("Value", "Lyrics +LYRICS")

    events = track.find("DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events")
    proto = events.find("MidiClip")
    events.remove(proto)

    # Pointee-style Ids (e.g. RemoteableTimeSignature) must be unique across
    # the whole set — allocate fresh ones from the set's NextPointeeId counter.
    next_pointee = ls.find("NextPointeeId")
    id_counter = int(next_pointee.get("Value"))

    for i, (start, end, text) in enumerate(arrange_clips(notes, bpm)):
        dur = end - start
        clip = copy.deepcopy(proto)
        clip.set("Id", str(i))
        clip.set("Time", f"{start:g}")
        for el in clip.iter():
            if el is not clip and "Id" in el.attrib:
                el.set("Id", str(id_counter))
                id_counter += 1
        clip.find("CurrentStart").set("Value", f"{start:g}")
        clip.find("CurrentEnd").set("Value", f"{end:g}")
        loop = clip.find("Loop")
        for tag, val in (("LoopStart", "0"), ("LoopEnd", f"{dur:g}"),
                         ("StartRelative", "0"), ("OutMarker", f"{dur:g}"),
                         ("HiddenLoopStart", "0"), ("HiddenLoopEnd", f"{dur:g}")):
            el = loop.find(tag)
            if el is not None:
                el.set("Value", val)
        clip.find("Name").set("Value", text)
        events.append(clip)

    if audio is not None:
        audio_track = build_audio_track(audio, bpm, name)
        match_clip_slots(audio_track, len(track.findall(
            "DeviceChain/MainSequencer/ClipSlotList/ClipSlot")))
        id_counter = renumber_pointees(audio_track, id_counter)
        ls.find("Tracks").append(audio_track)

    next_pointee.set("Value", str(id_counter))
    xml_bytes = b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8")
    return gzip.compress(xml_bytes)


class AlsRequest(BaseModel):
    segments: list[dict]
    bpm: float = 120
    fineness: str = "line"
    section_gap: float = 1.8
    offset: float = 0.0   # seconds; negative = lyrics earlier
    name: str = "lyrics"


@app.post("/api/als")
def make_als(req: AlsRequest):
    data = build_als(req.segments, req.bpm, req.fineness, req.section_gap, name=req.name,
                     offset=req.offset)
    filename = f"{req.name} Lyrics.als"
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


SEARCH_ROOTS = ["Downloads", "Desktop", "Music", "Documents", "Movies",
                "Library/CloudStorage"]
SKIP_DIRS = {"node_modules", ".git", "Ableton Project Info", "Backup",
             ".Trash", "Library", "Applications"}


def _matches(p: Path, size: int) -> bool:
    try:
        return p.is_file() and p.stat().st_size == size
    except OSError:
        return False


# Folder names that suggest a copy rather than the file being worked on
ARCHIVE_HINTS = ("backup", "archive", "time machine", "masters", "storage",
                 "old ", ".trash")
WORKING_ROOTS = ("downloads", "desktop", "music", "documents", "movies")


def rank_candidate(path: Path, modified: float | None) -> tuple:
    """Sort key — lower is more likely to be the file the user actually dropped.
    Duplicates are the norm (backups, masters, external archives), so prefer the
    internal drive, a working folder, and a matching modification time."""
    parts = [p.lower() for p in path.parts]
    external = 1 if len(path.parts) > 2 and path.parts[1] == "Volumes" else 0
    archived = 1 if any(h in p for p in parts for h in ARCHIVE_HINTS) else 0
    stale = 1
    if modified is not None:
        try:
            stale = 0 if abs(path.stat().st_mtime - modified / 1000.0) <= 2 else 1
        except OSError:
            pass
    off_root = 0 if any(p in WORKING_ROOTS for p in parts) else 1
    return (external, archived, stale, off_root, len(path.parts))


def find_candidates(filename: str, size: int, modified: float | None = None) -> list[Path]:
    """Every file on disk matching the dropped file's name and exact byte size,
    best guess first. Browsers never expose the real path, so this is how the
    app finds it; the caller resolves ties by asking."""
    found: dict[str, Path] = {}

    query = 'kMDItemFSName == "%s"' % filename.replace('"', '\\"')
    try:
        out = subprocess.run(["mdfind", query], capture_output=True,
                             text=True, timeout=15).stdout
        for line in out.splitlines():
            p = Path(line)
            if ".Trash" not in p.parts and _matches(p, size):
                found[str(p)] = p
    except Exception:
        pass

    home = Path.home()
    deadline = time.monotonic() + 20
    for root_name in SEARCH_ROOTS:
        root = home / root_name
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            if time.monotonic() > deadline:
                break
            dirnames[:] = [d for d in dirnames
                           if d not in SKIP_DIRS and not d.startswith(".")]
            if filename in filenames:
                candidate = Path(dirpath) / filename
                if _matches(candidate, size):
                    found[str(candidate)] = candidate

    return sorted(found.values(), key=lambda p: rank_candidate(p, modified))


# Paths this session has written. Only these can be opened from the page, so a
# stray request can't make the app open arbitrary files.
SAVED_PATHS: set[str] = set()


class RevealRequest(BaseModel):
    path: str
    reveal: bool = False   # True = show in Finder, False = open the file


@app.post("/api/reveal")
def reveal(req: RevealRequest):
    if req.path not in SAVED_PATHS:
        raise HTTPException(403, "That file wasn't saved by Lyrics Studio.")
    if not Path(req.path).exists():
        raise HTTPException(404, "That file no longer exists — it may have been moved.")
    subprocess.run(["open", "-R", req.path] if req.reveal else ["open", req.path],
                   check=False)
    return {"ok": True}


class AlsLocalRequest(BaseModel):
    filename: str
    size: int
    segments: list[dict]
    bpm: float = 120
    fineness: str = "line"
    section_gap: float = 1.8
    offset: float = 0.0   # seconds; negative = lyrics earlier
    name: str = "Song"
    modified: float | None = None   # File.lastModified (ms), helps pick the right copy
    path: str | None = None         # explicit choice when several copies matched


@app.post("/api/als_local")
def make_als_local(req: AlsLocalRequest):
    if req.path:
        path = Path(req.path)
        if path.name != req.filename or not _matches(path, req.size):
            raise HTTPException(400, "That file no longer matches the song you loaded.")
    else:
        candidates = find_candidates(req.filename, req.size, req.modified)
        if not candidates:
            raise HTTPException(404, "Could not locate the original audio file on disk.")
        if len(candidates) > 1:
            # Copies in backups/archives are common; let the user choose rather
            # than silently writing the set next to the wrong one.
            raise HTTPException(409, {
                "message": f"Found {len(candidates)} copies of {req.filename}.",
                "candidates": [str(p) for p in candidates[:8]],
            })
        path = candidates[0]
    try:
        duration, sample_rate = probe_audio(str(path))
    except Exception as e:
        raise HTTPException(400, f"Could not read audio file: {e}")
    safe_name = re.sub(r"[/\\:]", "-", req.name).strip() or "Song"
    audio = {
        "filename": path.name,
        "duration": duration,
        "sample_rate": sample_rate,
        # Live's standard in-project location; the file itself is not copied,
        # a symlink there points at the original (see below)
        "rel_dirs": ("Samples", "Imported"),
        "hint_dirs": tuple(path.parent.parts[1:]),  # absolute hint for Live's search
    }
    als = build_als(req.segments, req.bpm, req.fineness, req.section_gap,
                    audio=audio, name=safe_name, offset=req.offset)

    # a real Ableton project folder, laid out the way Live itself does it
    project = path.parent / f"{safe_name} Lyrics Project"
    project.mkdir(exist_ok=True)
    (project / "Ableton Project Info").mkdir(exist_ok=True)  # marks it a project
    imported = project / "Samples" / "Imported"
    imported.mkdir(parents=True, exist_ok=True)
    # reference the song where it already lives — a symlink in Live's standard
    # sample location, so no copy of the audio is made
    link = imported / path.name
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(path)
    out_path = project / f"{safe_name} Lyrics.als"
    if out_path.exists():
        backup_dir = project / "Backup"
        backup_dir.mkdir(exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H%M%S")
        shutil.copy2(out_path, backup_dir / f"{safe_name} Lyrics [{stamp}].als")
    out_path.write_bytes(als)
    SAVED_PATHS.add(str(out_path))
    save_state()
    return {"saved_to": str(out_path), "audio_path": str(path)}


def probe_audio(path: str) -> tuple[float, int]:
    import json as jsonlib

    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate:format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    info = jsonlib.loads(out)
    duration = float(info["format"]["duration"])
    sample_rate = int(info["streams"][0]["sample_rate"])
    return duration, sample_rate


@app.post("/api/als_project")
def make_als_project(
    file: UploadFile = File(...),
    segments: str = Form(...),
    bpm: float = Form(120),
    fineness: str = Form("line"),
    section_gap: float = Form(1.8),
    name: str = Form("Song"),
    offset: float = Form(0.0),
):
    import json as jsonlib

    segs = jsonlib.loads(segments)
    safe_name = re.sub(r"[/\\:]", "-", name).strip() or "Song"
    audio_name = re.sub(r"[/\\:]", "-", Path(file.filename or "song.mp3").name)

    with tempfile.TemporaryDirectory() as tmp:
        audio_path = str(Path(tmp) / audio_name)
        with open(audio_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        try:
            duration, sample_rate = probe_audio(audio_path)
        except Exception as e:
            raise HTTPException(400, f"Could not read audio file: {e}")
        als = build_als(
            segs, bpm, fineness, section_gap,
            audio={"filename": audio_name, "duration": duration, "sample_rate": sample_rate},
            name=safe_name, offset=offset,
        )
        audio_bytes = Path(audio_path).read_bytes()

    folder = f"{safe_name} Lyrics Project"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{folder}/{safe_name} Lyrics.als", als)
        z.writestr(f"{folder}/Samples/Imported/{audio_name}", audio_bytes)
        # marks the folder as a Live project so relative sample paths resolve
        z.writestr(zipfile.ZipInfo(f"{folder}/Ableton Project Info/"), b"")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{folder}.zip"'},
    )


def srt_timecode(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{round(s % 1 * 1000):03d}"


class BatchRequest(BaseModel):
    songs: list[dict]  # each: {name, segments, bpm}
    fineness: str = "word"
    section_gap: float = 1.8
    offset: float = 0.0   # seconds; negative = lyrics earlier
    pitch: int = 60


@app.post("/api/batch")
def batch_zip(req: BatchRequest):
    if not req.songs:
        raise HTTPException(400, "No songs.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for song in req.songs:
            name = song.get("name") or "song"
            segments = song["segments"]
            bpm = float(song.get("bpm") or 120)
            z.writestr(
                f"{name}.lyrics.{req.fineness}.mid",
                build_midi(segments, bpm, req.fineness, req.section_gap, req.pitch,
                           offset=req.offset),
            )
            z.writestr(
                f"{name} Lyrics.als",
                build_als(segments, bpm, req.fineness, req.section_gap, offset=req.offset),
            )
            z.writestr(
                f"{name}.lyrics.txt",
                "\n".join(s["text"] for s in segments) + "\n",
            )
            z.writestr(
                f"{name}.srt",
                "\n".join(
                    f"{i + 1}\n{srt_timecode(s['start'])} --> {srt_timecode(s['end'])}\n{s['text']}\n"
                    for i, s in enumerate(segments)
                ),
            )
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="lyrics-batch.zip"'},
    )


# ---------------------------------------------------------------------------
# Working directly on an existing Ableton set: read the song audio from one
# of its tracks, write the lyric clips onto another.
# ---------------------------------------------------------------------------

INSPECTED_ALS: set[str] = set()      # sets the user has opened
SERVABLE_AUDIO: set[str] = set()     # sample files the player may stream

# These allowlists must survive a server restart: the app is restarted often,
# and losing them mid-job used to reject the write of an already-transcribed
# track ("that set wasn't opened through Lyrics Studio").
STATE_FILE = DATA_DIR / ".state.json"


def load_state() -> None:
    try:
        data = json.loads(STATE_FILE.read_text())
    except Exception:
        return
    INSPECTED_ALS.update(data.get("als", []))
    SERVABLE_AUDIO.update(data.get("audio", []))
    SAVED_PATHS.update(data.get("saved", []))


def save_state() -> None:
    try:
        STATE_FILE.write_text(json.dumps({
            "als": sorted(INSPECTED_ALS)[-300:],
            "audio": sorted(SERVABLE_AUDIO)[-300:],
            "saved": sorted(SAVED_PATHS)[-300:],
        }, indent=1))
    except Exception:
        pass


def ensure_known_als(path: str) -> None:
    """Allow work on a set this app has opened. A server restart used to wipe
    that memory and strand an already-transcribed track, so a real, parseable
    Live set on disk is re-admitted rather than refused."""
    if path in INSPECTED_ALS:
        return
    p = Path(path)
    if p.suffix.lower() != ".als" or not p.is_file():
        raise HTTPException(403, "That isn't a Live set this app can work on.")
    INSPECTED_ALS.add(path)
    save_state()


def load_als(path: str):
    raw = Path(path).read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return ET.fromstring(raw)


def save_als(path: str, root) -> None:
    xml_bytes = b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8")
    Path(path).write_bytes(gzip.compress(xml_bytes))


def set_tempo_value(ls) -> float:
    for master in ("MasterTrack", "MainTrack"):
        el = ls.find(f"{master}/DeviceChain/Mixer/Tempo/Manual")
        if el is not None:
            return float(el.get("Value"))
    return 120.0


def automation_tempo_points(ls) -> list[tuple[float, float]]:
    """Tempo over time from the master track: the automation envelope if there
    is one, else the manual value. The envelope wins over the manual value —
    that is why exports used to open at the template's 120."""
    manual = set_tempo_value(ls)
    for master in ("MasterTrack", "MainTrack"):
        tempo = ls.find(f"{master}/DeviceChain/Mixer/Tempo")
        if tempo is None:
            continue
        target = tempo.find("AutomationTarget")
        target_id = target.get("Id") if target is not None else None
        envelopes = ls.find(f"{master}/AutomationEnvelopes/Envelopes")
        if not target_id or envelopes is None:
            break
        points: list[tuple[float, float]] = []
        for envelope in envelopes:
            pointee = envelope.find("EnvelopeTarget/PointeeId")
            if pointee is None or pointee.get("Value") != target_id:
                continue
            events = envelope.find("Automation/Events")
            for ev in (events if events is not None else []):
                if ev.tag != "FloatEvent":
                    continue
                # Live marks "from the beginning" with a large negative time
                beat = max(0.0, float(ev.get("Time", 0)))
                points.append((beat, float(ev.get("Value"))))
        if points:
            points.sort()
            if points[0][0] > 0:
                points.insert(0, (0.0, points[0][1]))
            return points
        break
    return [(0.0, manual)]


def interp_tempo(points, beat: float) -> float:
    """Tempo at a beat, interpolating between automation breakpoints."""
    if beat <= points[0][0]:
        return points[0][1]
    for (b0, v0), (b1, v1) in zip(points, points[1:]):
        if beat <= b1:
            if b1 <= b0:
                return v1
            return v0 + (v1 - v0) * (beat - b0) / (b1 - b0)
    return points[-1][1]


def leader_segments(ls) -> list[tuple[float, float, float]]:
    """Tempo dictated by "tempo leader" clips, as (start_beat, end_beat, bpm).

    A warped clip set as tempo leader drives the song tempo while it plays, and
    that tempo lives in the clip's warp markers — not in the master track. A set
    built by dropping in warped songs works this way, so without reading it the
    reported tempo (and every time shown) belongs to whatever the master track
    happens to say."""
    segments: list[tuple[float, float, float]] = []
    tracks = ls.find("Tracks")
    for track in (tracks if tracks is not None else []):
        if track.tag != "AudioTrack":
            continue
        for clip in audio_clips(track):
            leader = clip.find("IsSongTempoMaster")
            warped = clip.find("IsWarped")
            if leader is None or leader.get("Value") != "true":
                continue
            if warped is None or warped.get("Value") != "true":
                continue
            wm = clip.find("WarpMarkers")
            markers = sorted((float(m.get("SecTime")), float(m.get("BeatTime")))
                             for m in wm) if wm is not None else []
            if len(markers) < 2:
                continue
            time_beat = float(clip.get("Time"))
            loop = clip.find("Loop")
            offset = 0.0
            if loop is not None:
                offset = float(loop.find("LoopStart").get("Value"))
                rel = loop.find("StartRelative")
                if rel is not None:
                    offset += float(rel.get("Value"))
            span_start = float(clip.find("CurrentStart").get("Value"))
            span_end = float(clip.find("CurrentEnd").get("Value"))
            for (s0, b0), (s1, b1) in zip(markers, markers[1:]):
                if s1 <= s0 or b1 <= b0:
                    continue
                bpm = (b1 - b0) / (s1 - s0) * 60.0
                a0 = max(time_beat + (b0 - offset), span_start)
                a1 = min(time_beat + (b1 - offset), span_end)
                if a1 > a0 and 10.0 <= bpm <= 400.0:
                    segments.append((a0, a1, bpm))

    segments.sort()
    # a later leader takes over from an earlier one
    resolved: list[tuple[float, float, float]] = []
    for seg in segments:
        while resolved and seg[0] < resolved[-1][1]:
            prev = resolved.pop()
            if prev[0] < seg[0]:
                resolved.append((prev[0], seg[0], prev[2]))
                break
        resolved.append(seg)
    # collapse runs of equal tempo — an auto-warped song has a marker per beat
    merged: list[tuple[float, float, float]] = []
    for a0, a1, bpm in resolved:
        if merged and abs(merged[-1][2] - bpm) < 1e-6 and abs(merged[-1][1] - a0) < 1e-6:
            merged[-1] = (merged[-1][0], a1, merged[-1][2])
        else:
            merged.append((a0, a1, bpm))
    return merged


def tempo_map(ls) -> tuple:
    """The set's tempo over time as ((beat, bpm), ...), combining tempo-leader
    clips (which win while they play) with the master track's automation."""
    baseline = automation_tempo_points(ls)
    leaders = leader_segments(ls)
    if not leaders:
        return tuple(baseline)

    EPS = 1e-6
    points: list[tuple[float, float]] = []
    cursor = 0.0
    for a0, a1, bpm in leaders:
        a0 = max(a0, 0.0)
        if a1 <= a0:
            continue
        if a0 > cursor:                       # gap: fall back to the master track
            points.append((cursor, interp_tempo(baseline, cursor)))
            points.append((a0 - EPS, interp_tempo(baseline, a0)))
        points.append((a0, bpm))              # constant across the leader's span
        points.append((max(a1 - EPS, a0), bpm))
        cursor = a1
    points.append((cursor, interp_tempo(baseline, cursor)))
    if points[0][0] > 0:
        points.insert(0, (0.0, interp_tempo(baseline, 0.0)))
    points.sort(key=lambda p: p[0])
    return tuple(points)


def _segment_seconds(b0: float, v0: float, b1: float, v1: float) -> float:
    """Seconds to travel beats b0->b1 while bpm ramps linearly v0->v1."""
    span = b1 - b0
    if span <= 0:
        return 0.0
    if abs(v1 - v0) < 1e-9:
        return span * 60.0 / v0
    return 60.0 * span / (v1 - v0) * math.log(v1 / v0)


def beats_to_seconds(tmap: list[tuple[float, float]], beat: float) -> float:
    if beat <= 0:
        return 0.0
    total = 0.0
    for (b0, v0), (b1, v1) in zip(tmap, tmap[1:]):
        if beat <= b0:
            return total
        if b1 <= b0:
            continue
        end = min(beat, b1)
        v_end = v0 + (v1 - v0) * ((end - b0) / (b1 - b0))
        total += _segment_seconds(b0, v0, end, v_end)
        if beat <= b1:
            return total
    last_beat, last_bpm = tmap[-1]
    if beat > last_beat:
        total += (beat - last_beat) * 60.0 / last_bpm
    return total


def seconds_to_beats(tmap: list[tuple[float, float]], sec: float) -> float:
    if sec <= 0:
        return 0.0
    elapsed = 0.0
    for (b0, v0), (b1, v1) in zip(tmap, tmap[1:]):
        if b1 <= b0:
            continue
        span = _segment_seconds(b0, v0, b1, v1)
        if elapsed + span >= sec:
            remaining = sec - elapsed
            dv, db = v1 - v0, b1 - b0
            if abs(dv) < 1e-9:
                return b0 + remaining * v0 / 60.0
            bpm_at = v0 * math.exp(remaining * dv / (60.0 * db))
            return b0 + (bpm_at - v0) * db / dv
        elapsed += span
    last_beat, last_bpm = tmap[-1]
    return last_beat + (sec - elapsed) * last_bpm / 60.0


def audio_clips(track) -> list:
    """A track's arrangement regions, in timeline order. Both the region list
    shown in the page and the transcriber index into this, so the numbering
    the user picks always refers to the same region."""
    clips = track.findall(
        "DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
    return sorted(clips, key=lambda c: float(c.find("CurrentStart").get("Value")))


def tempo_at(tmap: list[tuple[float, float]], beat: float) -> float:
    """The tempo in force at an arrangement position."""
    bpm = tmap[0][1]
    for b, v in tmap:
        if b > beat:
            break
        bpm = v
    return round(bpm, 2)


def region_mapper(clip, tmap: list[tuple[float, float]]):
    """For one arrangement region: which slice of its audio file it plays, and
    how to put a time inside that file onto the arrangement timeline (seconds).
    Handles warped and unwarped clips, and tempo changes underneath them."""
    start_beat = float(clip.find("CurrentStart").get("Value"))
    end_beat = float(clip.find("CurrentEnd").get("Value"))
    time_beat = float(clip.get("Time"))
    loop = clip.find("Loop")
    loop_start = 0.0
    if loop is not None:
        loop_start = float(loop.find("LoopStart").get("Value"))
        # a trimmed region starts this far into its clip, not at the loop start
        rel = loop.find("StartRelative")
        if rel is not None:
            loop_start += float(rel.get("Value"))
    warped_el = clip.find("IsWarped")
    markers = []
    if warped_el is not None and warped_el.get("Value") == "true":
        wm = clip.find("WarpMarkers")
        if wm is not None:
            markers = sorted((float(m.get("SecTime")), float(m.get("BeatTime")))
                             for m in wm)

    if len(markers) >= 2:
        def beat_to_file(beat: float) -> float:
            clip_beat = beat - time_beat + loop_start
            for (s0, b0), (s1, b1) in zip(markers, markers[1:]):
                if clip_beat <= b1 or (s1, b1) == markers[-1]:
                    if b1 == b0:
                        continue
                    return s0 + (clip_beat - b0) * (s1 - s0) / (b1 - b0)
            return markers[0][0]

        def file_to_arrangement(t: float) -> float:
            for (s0, b0), (s1, b1) in zip(markers, markers[1:]):
                if t <= s1 or (s1, b1) == markers[-1]:
                    if s1 == s0:
                        continue
                    clip_beat = b0 + (t - s0) * (b1 - b0) / (s1 - s0)
                    break
            else:
                clip_beat = markers[0][1]
            return beats_to_seconds(tmap, time_beat + (clip_beat - loop_start))

        return start_beat, end_beat, beat_to_file, file_to_arrangement

    # unwarped: plays at file rate from its arrangement position
    origin = beats_to_seconds(tmap, time_beat)
    return (start_beat, end_beat,
            lambda b: loop_start + (beats_to_seconds(tmap, b) - origin),
            lambda t: origin + (t - loop_start))


def resolve_sample(fileref, als_dir: Path) -> Path | None:
    """Find the audio file an AudioClip references, trying the absolute path
    (Live 11+), the relative path (string in 11+, elements in 10), and the
    project-standard Samples folders."""
    name_el = fileref.find("Name")
    name = name_el.get("Value") if name_el is not None else None

    p = fileref.find("Path")
    if p is not None and p.get("Value"):
        cand = Path(p.get("Value"))
        if cand.is_file():
            return cand
        if name is None:
            name = cand.name

    rp = fileref.find("RelativePath")
    if rp is not None:
        if rp.get("Value"):                       # Live 11+: one string
            cand = (als_dir / rp.get("Value")).resolve()
            if cand.is_file():
                return cand
        else:                                     # Live 10: Dir elements + Name
            # an empty Dir means "up one level"
            dirs = [(e.get("Dir") or "..") for e in rp.findall("RelativePathElement")]
            if name:
                cand = als_dir.joinpath(*dirs, name)
                try:
                    cand = cand.resolve()
                except OSError:
                    pass
                if cand.is_file():
                    return cand

    if name:
        for sub in ("Samples/Imported", "Samples/Recorded", "Samples/Processed", "."):
            cand = als_dir / sub / name
            if cand.is_file():
                return cand
    return None



def clips_across(tracks) -> list:
    """Every audio clip on the given tracks, in timeline order.

    This is the one order a region index means — the description and the
    transcription both go through here, so the checkboxes on the page and the
    regions the server cuts can never drift apart, whether one track is being
    read or every track sharing a name."""
    keyed = [(float(c.find("CurrentStart").get("Value")), t.get("Id"), c)
             for t in tracks for c in audio_clips(t)]
    keyed.sort(key=lambda k: (k[0], k[1]))
    return [c for _, _, c in keyed]


def source_entry(name: str, track_id: str, clips, als_dir, label_extra: str = "") -> dict:
    samples = [resolve_sample(c.find("SampleRef/FileRef"), als_dir) for c in clips]
    found = [s for s in samples if s is not None]
    for s in found:
        SERVABLE_AUDIO.add(str(s))
    first = min(float(c.find("CurrentStart").get("Value")) for c in clips)
    last = max(float(c.find("CurrentEnd").get("Value")) for c in clips)
    first_bar = int(first // 4) + 1
    last_bar = int(last // 4) + 1
    return {
        "track_id": track_id,
        "name": name,
        "label": f"{name}{label_extra} — {len(clips)} region{'' if len(clips) == 1 else 's'}"
                 f", bars {first_bar}–{last_bar}",
        "regions": len(clips),
        "resolved": len(found),
        "sample": str(found[0]) if found else None,
        "first_bar": first_bar,
        "last_bar": last_bar,
        "region_list": [
            {
                "index": i,
                "name": (c.find("Name").get("Value") or "")
                        or (samples[i].name if samples[i] else "region"),
                "start_bar": int(float(c.find("CurrentStart").get("Value")) // 4) + 1,
                "end_bar": int(float(c.find("CurrentEnd").get("Value")) // 4) + 1,
                "resolved": samples[i] is not None,
            }
            for i, c in enumerate(clips)
        ],
    }


def describe_set(root, als_path: str) -> dict:
    ls = root.find("LiveSet")
    als_dir = Path(als_path).parent
    tmap = tempo_map(ls)
    tempo = tmap[0][1]
    sources, targets = [], []
    audio_tracks: list[tuple[str, str]] = []   # (name, track_id), for grouping
    tracks_by_id = {}
    for track in ls.find("Tracks"):
        tid = track.get("Id")
        name_el = track.find("Name/EffectiveName")
        name = name_el.get("Value") if name_el is not None else track.tag
        if track.tag == "AudioTrack":
            clips = clips_across([track])
            if not clips:
                continue
            audio_tracks.append((name, tid))
            tracks_by_id[tid] = track
            sources.append(source_entry(name, tid, clips, als_dir))
        elif track.tag == "MidiTrack":
            n_clips = len(track.findall(
                "DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events/MidiClip"))
            targets.append({"track_id": tid, "label": name, "existing_clips": n_clips})

    # Several tracks sharing a name — one VOCALS per song is a common rig
    # shape — get a combined source reading all of them, in timeline order.
    by_name: dict[str, list[str]] = {}
    for name, tid in audio_tracks:
        by_name.setdefault(name.strip().lower(), []).append(tid)
    for ids in by_name.values():
        if len(ids) < 2:
            continue
        tracks = [tracks_by_id[t] for t in ids]
        name = next(n for n, t in audio_tracks if t == ids[0])
        entry = source_entry(name, f"all::{ids[0]}", clips_across(tracks), als_dir,
                             label_extra=f" (all {len(ids)} tracks with this name)")
        entry["track_ids"] = ids
        sources.append(entry)

    return {"path": als_path, "tempo": tempo, "sources": sources, "targets": targets,
            "tempo_changes": len(tmap) - 1,
            "tempo_range": [min(v for _, v in tmap), max(v for _, v in tmap)],
            "tempo_source": "leader" if leader_segments(ls) else "master"}


class AlsInspectRequest(BaseModel):
    filename: str
    size: int
    modified: float | None = None
    path: str | None = None


@app.post("/api/als_inspect")
def als_inspect(req: AlsInspectRequest):
    if req.path:
        # explicit path: from the duplicate picker or the native file dialog
        path = Path(req.path)
        if path.suffix.lower() != ".als" or not path.is_file():
            raise HTTPException(400, "That path is not a Live set.")
    else:
        candidates = find_candidates(req.filename, req.size, req.modified)
        if not candidates:
            raise HTTPException(404, "Could not locate the .als on disk — the tool "
                                     "needs its real location to resolve the samples "
                                     "it references and to write lyrics back.")
        if len(candidates) > 1:
            raise HTTPException(409, {
                "message": f"Found {len(candidates)} copies of {req.filename}.",
                "candidates": [str(p) for p in candidates[:8]],
            })
        path = candidates[0]
    try:
        root = load_als(str(path))
    except Exception as e:
        raise HTTPException(400, f"Could not read the Live set: {e}")
    INSPECTED_ALS.add(str(path))
    save_state()
    info = describe_set(root, str(path))
    if not info["sources"]:
        raise HTTPException(400, "No audio clips with locatable files found in this set.")
    if not info["targets"]:
        raise HTTPException(400, "This set has no MIDI track to write lyrics to — "
                                 "add an empty MIDI track in Live and save first.")
    return info


MIN_REGION_SECONDS = 0.3

# live progress for the region-by-region pass, polled by the page
TRANSCRIBE_PROGRESS: dict[str, dict] = {}


@app.get("/api/als_progress")
def als_progress(als_path: str, track_id: str):
    return TRANSCRIBE_PROGRESS.get(f"{als_path}::{track_id}",
                                   {"done": 0, "total": 0, "phase": "idle"})


def extract_region(sample: str, start: float, dur: float, dest: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.4f}", "-t", f"{dur:.4f}",
         "-i", sample, "-ac", "1", "-ar", "16000", dest],
        check=True, capture_output=True, timeout=600,
    )


BEATS_PER_BAR = 4          # bar numbering assumes 4/4, as Live's ruler does


class AlsTranscribeRequest(BaseModel):
    als_path: str
    track_id: str
    track_ids: list[str] | None = None   # a combined source: read all of these
    language: str = ""
    lyrics: str = ""
    isolate: bool = False
    start_bar: float | None = None   # limit transcription to this bar range
    end_bar: float | None = None
    region_indexes: list[int] | None = None   # limit to these regions (timeline order)


@app.post("/api/als_transcribe")
def als_transcribe(req: AlsTranscribeRequest):
    """Transcribe every region on the chosen track, placing each region's words
    on the arrangement timeline via that region's own position and warping."""
    ensure_known_als(req.als_path)
    root = load_als(req.als_path)
    ls = root.find("LiveSet")
    tempo = set_tempo_value(ls)
    wanted = set(req.track_ids) if req.track_ids else {req.track_id}
    tracks = [t for t in ls.find("Tracks")
              if t.tag == "AudioTrack" and t.get("Id") in wanted]
    if not tracks:
        raise HTTPException(404, "Audio track not found in the set.")
    clips = clips_across(tracks)
    if not clips:
        raise HTTPException(404, "That track has no audio regions.")
    chosen = set(req.region_indexes) if req.region_indexes else None

    tmap = tempo_map(ls)
    als_dir = Path(req.als_path).parent
    segments: list[dict] = []
    songs: list[dict] = []          # one entry per region on the track
    text_parts: list[str] = []
    language = ""
    done = skipped_missing = skipped_short = skipped_range = 0
    first_sample = None

    # optional bar range: only the part of the track inside it is transcribed
    range_start = ((req.start_bar - 1) * BEATS_PER_BAR
                   if req.start_bar is not None else -float("inf"))
    range_end = (req.end_bar * BEATS_PER_BAR
                 if req.end_bar is not None else float("inf"))
    if range_end <= range_start:
        raise HTTPException(400, "The end bar must be after the start bar.")

    progress_key = f"{req.als_path}::{req.track_id}"
    TRANSCRIBE_PROGRESS[progress_key] = {"done": 0, "total": len(clips),
                                         "phase": "transcribing"}
    with tempfile.TemporaryDirectory() as tmp:
        for i, clip in enumerate(clips):
            TRANSCRIBE_PROGRESS[progress_key] = {"done": i, "total": len(clips),
                                                 "phase": "transcribing"}
            if chosen is not None and i not in chosen:
                skipped_range += 1
                continue
            sample = resolve_sample(clip.find("SampleRef/FileRef"), als_dir)
            if sample is None:
                skipped_missing += 1
                continue
            clip_start, clip_end, beat_to_file, to_arrangement_sec = region_mapper(clip, tmap)
            # clamp this region to the requested bar range
            a_start = max(clip_start, range_start)
            a_end = min(clip_end, range_end)
            if a_end <= a_start:
                skipped_range += 1
                continue
            f_start, f_end = beat_to_file(a_start), beat_to_file(a_end)
            if f_end < f_start:
                f_start, f_end = f_end, f_start
            f_start = max(0.0, f_start)
            if f_end - f_start < MIN_REGION_SECONDS:
                skipped_short += 1
                continue

            region = str(Path(tmp) / f"region{i}.wav")
            try:
                extract_region(str(sample), f_start, f_end - f_start, region)
            except Exception:
                skipped_missing += 1
                continue

            out = transcribe_file(region, req.language, req.lyrics, req.isolate, tmp)
            language = language or out.get("language", "")
            if out["text"]:
                text_parts.append(out["text"])

            start_beat, end_beat = a_start, a_end
            name_el = clip.find("Name")
            songs.append({
                "index": len(songs) + 1,
                "name": (name_el.get("Value") if name_el is not None else "") or Path(sample).stem,
                "file": Path(sample).name,
                "tempo": tempo_at(tmap, start_beat),
                "start_bar": int(start_beat // 4) + 1,
                "end_bar": int(end_beat // 4) + 1,
                "start_sec": beats_to_seconds(tmap, start_beat),
                "end_sec": beats_to_seconds(tmap, end_beat),
                "lag_ms": round(out.get("lag", 0.0) * 1000),
                "lines": [s["text"] for s in out["segments"] if s["text"]],
            })

            # region-relative seconds -> file seconds -> arrangement seconds,
            # so every region shares one timeline regardless of tempo changes
            def to_arrangement(t: float, base=f_start, fn=to_arrangement_sec) -> float:
                return fn(base + t)

            # Beats beside the seconds, through the set's tempo map, so a
            # reader placing clips on the ruler needn't carry the map itself.
            def at(t: float) -> dict:
                sec = to_arrangement(t)
                return {"start": sec, "start_beat": seconds_to_beats(tmap, sec)}

            for seg in out["segments"]:
                s_at, e_at = at(seg["start"]), at(seg["end"])
                segments.append({
                    "start": s_at["start"],
                    "end": e_at["start"],
                    "start_beat": s_at["start_beat"],
                    "end_beat": e_at["start_beat"],
                    "text": seg["text"],
                    "words": [{"text": w["text"],
                               "start": at(w["start"])["start"],
                               "end": at(w["end"])["start"],
                               "start_beat": at(w["start"])["start_beat"],
                               "end_beat": at(w["end"])["start_beat"]}
                              for w in seg.get("words", [])],
                })
            first_sample = first_sample or str(sample)
            done += 1

    if not segments:
        TRANSCRIBE_PROGRESS.pop(progress_key, None)
        raise HTTPException(400, "No lyrics found on that track "
                                 f"({done} regions transcribed, "
                                 f"{skipped_missing} unreadable, {skipped_short} too short"
                                 + (f", {skipped_range} outside the chosen bars"
                                    if skipped_range else "") + ").")

    TRANSCRIBE_PROGRESS.pop(progress_key, None)
    segments.sort(key=lambda s: s["start"])
    if first_sample:
        SERVABLE_AUDIO.add(first_sample)
        save_state()
    return {
        "text": "\n".join(text_parts),
        "language": language,
        "bpm": tempo,
        "tempo_changes": len(tmap) - 1,
        "tempo_range": [min(v for _, v in tmap), max(v for _, v in tmap)],
        "tempo_source": "leader" if leader_segments(ls) else "master",
        "duration": max(s["end"] for s in segments),
        "segments": segments,
        "aligned": False,
        # times are arrangement seconds; als_write converts them back to beats
        # through the set's own tempo map
        "mapping": {"type": "arrangement_seconds"},
        "sample": first_sample,
        "songs": songs,
        "lag_ms": (round(sum(s["lag_ms"] for s in songs) / len(songs)) if songs else 0),
        "regions": {"transcribed": done, "missing": skipped_missing, "short": skipped_short,
                    "out_of_range": skipped_range, "total": len(clips)},
        "range": ({"start_bar": req.start_bar, "end_bar": req.end_bar}
                  if (req.start_bar is not None or req.end_bar is not None) else None),
    }


def midi_clip_prototype(root):
    """A MidiClip element matching this set's schema: preferably cloned from
    the set itself, else a shipped per-schema asset. Never mix schema
    generations — that segfaults Live."""
    clip = root.find(".//MidiClip")
    if clip is not None:
        proto = copy.deepcopy(clip)
        for tag in ("Notes/KeyTracks", "Notes/PerNoteEventStore", "Envelopes/Envelopes"):
            el = proto.find(tag)
            if el is not None:
                for c in list(el):
                    el.remove(c)
        gid = proto.find("GrooveSettings/GrooveId")
        if gid is not None:
            gid.set("Value", "-1")
        return proto
    major = (root.get("MinorVersion") or "").split("_")[0]
    asset = APP_DIR / f"midiclip-{major.split('.')[0]}.xml"
    if major == "10.0":
        tpl = ET.fromstring((APP_DIR / "template.xml").read_bytes())
        return copy.deepcopy(tpl.find(".//MidiClip"))
    if asset.is_file():
        return ET.fromstring(asset.read_bytes())
    raise HTTPException(400, "This set has no MIDI clip to model the lyric clips on "
                             f"and no template ships for schema {major} — add one "
                             "empty MIDI clip anywhere in the set and save first.")


def fit_into_gaps(spans: list[tuple[float, float, str]],
                  occupied: list[tuple[float, float]]) -> list[tuple[float, float, str]]:
    """Trim new clips so they don't overlap clips already on the track — Live
    refuses overlapping arrangement clips. A new clip with no room left is
    dropped rather than displacing what is already there."""
    kept = []
    for start, end, text in spans:
        s, e = start, end
        for o_start, o_end in occupied:
            if o_end <= s or o_start >= e:
                continue
            if o_start <= s and o_end >= e:          # fully covered
                s = e = 0.0
                break
            if o_start <= s:
                s = o_end
            elif o_end >= e:
                e = o_start
            elif (o_start - s) >= (e - o_end):       # keep the longer free side
                e = o_start
            else:
                s = o_end
        if e - s >= MIN_CLIP_BEATS:
            kept.append((round(s, 6), round(e, 6), text))
    return kept


class AlsWriteRequest(BaseModel):
    als_path: str
    target_track_id: str
    segments: list[dict]
    mapping: dict
    fineness: str = "line"
    section_gap: float = 1.8
    offset: float = 0.0
    keep_existing: bool = False      # merge alongside the track's current clips


@app.post("/api/als_write")
def als_write(req: AlsWriteRequest):
    ensure_known_als(req.als_path)
    root = load_als(req.als_path)
    ls = root.find("LiveSet")
    track = next((t for t in ls.find("Tracks")
                  if t.tag == "MidiTrack" and t.get("Id") == req.target_track_id), None)
    if track is None:
        raise HTTPException(404, "Target MIDI track not found in the set.")
    events = track.find("DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events")
    if events is None:
        raise HTTPException(400, "Target track has no arrangement lane.")

    notes = shift_notes(group_notes(req.segments, req.fineness, req.section_gap), req.offset)
    if not notes:
        raise HTTPException(400, "No clips to write.")
    # segment times are arrangement seconds; convert through the set's own
    # tempo map so clips stay put across tempo changes
    tmap = tempo_map(ls)
    spans = sanitize_beat_spans([
        (seconds_to_beats(tmap, n["start"]), seconds_to_beats(tmap, n["end"]), n["text"])
        for n in notes
    ])

    proto = midi_clip_prototype(root)
    next_pointee = ls.find("NextPointeeId")
    id_counter = int(next_pointee.get("Value")) if next_pointee is not None else 100000

    existing = list(events.findall("MidiClip"))
    kept_existing = existing if req.keep_existing else []
    dropped = 0
    if kept_existing:
        occupied = sorted((float(c.find("CurrentStart").get("Value")),
                           float(c.find("CurrentEnd").get("Value")))
                          for c in kept_existing)
        before = len(spans)
        spans = fit_into_gaps(spans, occupied)
        dropped = before - len(spans)
        if not spans:
            raise HTTPException(400, "Every lyric clip overlapped a clip already on "
                                     f"that track ({len(kept_existing)} of them), so "
                                     "nothing could be added without deleting them.")

    for c in list(events):
        events.remove(c)

    # Clip ids need only be unique within this list — but that includes the
    # kept clips, which already own the low numbers. Live refuses the whole
    # set over one duplicate ("Non-unique list ids").
    def clip_id(c) -> int:
        try:
            return int(c.get("Id", "0"))
        except ValueError:
            return 0
    base = 1 + max((clip_id(c) for c in kept_existing), default=-1)

    written = []
    for i, (start, end, text) in enumerate(spans):
        dur = end - start
        clip = copy.deepcopy(proto)
        clip.set("Id", str(base + i))
        clip.set("Time", f"{start:g}")
        for el in clip.iter():
            if el is not clip and "Id" in el.attrib:
                el.set("Id", str(id_counter))
                id_counter += 1
        for tag, val in (("CurrentStart", f"{start:g}"), ("CurrentEnd", f"{end:g}")):
            clip.find(tag).set("Value", val)
        loop = clip.find("Loop")
        for tag, val in (("LoopStart", "0"), ("LoopEnd", f"{dur:g}"),
                         ("StartRelative", "0"), ("LoopOn", "false"),
                         ("OutMarker", f"{dur:g}"), ("HiddenLoopStart", "0"),
                         ("HiddenLoopEnd", f"{dur:g}")):
            el = loop.find(tag)
            if el is not None:
                el.set("Value", val)
        clip.find("Name").set("Value", text)
        written.append(clip)

    # Live requires arrangement clips in timeline order, so merge and re-sort
    for clip in sorted(kept_existing + written,
                       key=lambda c: float(c.find("CurrentStart").get("Value"))):
        events.append(clip)
    if next_pointee is not None:
        next_pointee.set("Value", str(id_counter))

    # never touch the set that was dropped in — write a new copy beside it, so
    # its relative sample paths still resolve
    src = Path(req.als_path)
    stem = re.sub(r"\s*\+?\s*Lyrics$", "", src.stem).rstrip()
    out_path = src.parent / f"{stem} + Lyrics.als"
    if out_path == src or (out_path.exists() and str(out_path) not in SAVED_PATHS):
        # don't clobber something this app didn't create
        n = 2
        while True:
            candidate = src.parent / f"{stem} + Lyrics {n}.als"
            if not candidate.exists() or str(candidate) in SAVED_PATHS:
                out_path = candidate
                break
            n += 1
    save_als(str(out_path), root)
    SAVED_PATHS.add(str(out_path))
    INSPECTED_ALS.add(str(out_path))
    save_state()
    return {"saved_to": str(out_path), "source": str(src), "clips": len(spans),
            "kept_existing": len(kept_existing), "dropped_overlapping": dropped}


@app.post("/api/restart")
def restart():
    """Re-exec the server in place so code changes load without losing the
    process's context (it must not run inside Claude's sandbox)."""
    import threading

    def _re():
        time.sleep(0.5)
        os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=_re, daemon=True).start()
    return {"ok": True}


class PickRequest(BaseModel):
    prompt: str = "Choose a file"
    types: list[str] = []          # e.g. ["als"]


@app.post("/api/pick_file")
def pick_file(req: PickRequest):
    """Native macOS file dialog — the reliable way to get a real path, since
    browsers hide the location of dropped files."""
    type_clause = ""
    if req.types:
        quoted = ",".join('"%s"' % t.replace('"', "") for t in req.types)
        type_clause = f" of type {{{quoted}}}"
    prompt = req.prompt.replace('"', "'")
    script = (f'POSIX path of (choose file{type_clause} '
              f'with prompt "{prompt}")')
    try:
        out = subprocess.run(["osascript", "-e", script],
                             capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        raise HTTPException(408, "File dialog timed out.")
    if out.returncode != 0:
        raise HTTPException(410, "Cancelled.")
    path = out.stdout.strip()
    if not Path(path).is_file():
        raise HTTPException(404, "Chosen file not found.")
    return {"path": path}


@app.get("/api/audio")
def serve_audio(path: str):
    if path not in SERVABLE_AUDIO:
        raise HTTPException(403, "Not an audio file opened through Lyrics Studio.")
    if not Path(path).is_file():
        raise HTTPException(404, "File no longer exists.")
    return FileResponse(path)


load_state()


"""
Which port to serve on.

8765 is home, and for a long time was simply assumed. Then another app on the
same Mac took to listening there, and every launcher — seeing the port busy —
decided Lyrics Studio was already up and opened a browser at a stranger's
JSON. So the port is found, not assumed: the first of a short run that is
either free or already ours. A stranger on a port is stepped past; a Lyrics
Studio already on one means this copy has nothing to do and says so. The port
chosen is written beside the log so a launcher can find it without guessing.
"""
PORTS = range(8765, 8776)


def holder_of(port: int) -> str:
    """'free', 'ours' or 'stranger' — who has this port."""
    import socket
    import urllib.request
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
            return "free"
        except OSError:
            pass
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=1) as res:
            answer = json.loads(res.read().decode("utf-8", "replace"))
        return "ours" if answer.get("app") == "lyrics-studio" else "stranger"
    except Exception:
        return "stranger"


def choose_port() -> int | None:
    for port in PORTS:
        who = holder_of(port)
        if who == "free":
            return port
        if who == "ours":
            print(f"Lyrics Studio is already running on http://127.0.0.1:{port}")
            return None
        print(f"port {port} is taken by something else; trying the next")
    print(f"no free port between {PORTS.start} and {PORTS.stop - 1}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    import threading
    import uvicorn

    port = int(sys.argv[1]) if len(sys.argv) > 1 else choose_port()
    if port is None:
        sys.exit(0)
    try:
        (DATA_DIR / "port").write_text(str(port))
    except OSError:
        pass
    threading.Thread(target=idle_watchdog, daemon=True).start()
    print(f"Lyrics Studio on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)
