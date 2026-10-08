"""Where a song is sung, and words kept to it.

Whisper infers word times from attention, not from the waveform. Across a
stretch with no singing it is at its worst: the last word before a break is
held through it, the first after is pulled back into it, words are invented
in it ("Thank you."), and lyrics laid onto what it heard are spread across it.
Everything here takes the audio's own loudness — an envelope of the vocal
(or of the whole mix, where no vocal was isolated) — finds the runs that are
actually voiced, and keeps words inside them.

Pure Python, no audio libraries: the envelope is computed by the caller.
"""
from __future__ import annotations

# A break shorter than this inside a phrase is a breath or a consonant, not a gap.
CLOSE_GAP = 0.20
# A voiced blip shorter than this is a click or bleed, not singing.
MIN_RUN = 0.08
# A word spanning a silence longer than this was stretched across it.
STRETCH_GAP = 0.35
MIN_WORD = 0.05


def voiced_runs(envelope: list[float], frame_rate: float) -> list[tuple[float, float]]:
    """(start, end) seconds where the envelope says something is sounding.

    The threshold sits between the envelope's own floor and its peaks, so it
    follows the recording rather than a fixed loudness. A flat envelope
    (silence, or one steady tone) has no gaps to find and counts as voiced
    throughout only if it is above silence at all.
    """
    if not envelope or frame_rate <= 0:
        return []
    ranked = sorted(envelope)
    floor = ranked[int(0.10 * (len(ranked) - 1))]
    peak = ranked[int(0.95 * (len(ranked) - 1))]
    if peak <= 1e-9:
        return []
    if peak - floor < 0.05 * peak:        # no contrast: nothing to tell apart
        return [(0.0, len(envelope) / frame_rate)]
    threshold = floor + 0.15 * (peak - floor)

    runs: list[list[int]] = []
    for i, v in enumerate(envelope):
        if v > threshold:
            if runs and i == runs[-1][1]:
                runs[-1][1] = i + 1
            else:
                runs.append([i, i + 1])
    merged: list[list[float]] = []
    for a, b in runs:
        a, b = a / frame_rate, b / frame_rate
        if merged and a - merged[-1][1] < CLOSE_GAP:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged if b - a >= MIN_RUN]


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def near_voice(start: float, end: float, runs: list[tuple[float, float]], slack: float) -> bool:
    """Is there singing within `slack` seconds of this span?"""
    return any(b + slack > start and a - slack < end for a, b in runs)


def drop_unvoiced(segments: list[dict], runs: list[tuple[float, float]],
                  slack: float = 0.3) -> list[dict]:
    """Words Whisper put where nothing was sung are not words. Segments left
    with none go too. No runs known, nothing is judged."""
    if not runs:
        return segments
    kept = []
    for seg in segments:
        words = [w for w in seg.get("words", []) if near_voice(w["start"], w["end"], runs, slack)]
        if seg.get("words"):
            if not words:
                continue
            seg = {**seg, "words": words, "text": " ".join(w["text"] for w in words),
                   "start": words[0]["start"], "end": words[-1]["end"]}
        elif not near_voice(seg["start"], seg["end"], runs, slack):
            continue
        kept.append(seg)
    return kept


def _fit_word(start: float, end: float, runs: list[tuple[float, float]]) -> tuple[float, float]:
    """One word held to the singing it overlaps."""
    over = [(a, b) for a, b in runs if _overlap(start, end, a, b) > 0]
    if not over:
        return start, end
    # A word reaching across a real silence was stretched: it belongs to the
    # run it overlaps most.
    groups: list[list[tuple[float, float]]] = [[over[0]]]
    for run in over[1:]:
        if run[0] - groups[-1][-1][1] > STRETCH_GAP:
            groups.append([run])
        else:
            groups[-1].append(run)
    if len(groups) > 1:
        group = max(groups, key=lambda g: sum(_overlap(start, end, a, b) for a, b in g))
    else:
        group = groups[0]
    return max(start, group[0][0]), min(end, group[-1][1])


def fit_to_voice(segments: list[dict], runs: list[tuple[float, float]]) -> list[dict]:
    """Pull each word's start forward to where it is sung and its end back to
    where it stops, then make the words one ordered, non-overlapping line and
    each segment as long as its words. Words with no singing to hold them to
    (lyrics laid on a stretch that sounds empty) are left where they are."""
    if not runs:
        return segments
    prev_end = 0.0
    for seg in segments:
        words = seg.get("words") or []
        for w in words:
            s, e = _fit_word(w["start"], w["end"], runs)
            s = max(s, prev_end)
            e = max(e, s + MIN_WORD)
            w["start"], w["end"] = s, e
            prev_end = e
        if words:
            seg["start"], seg["end"] = words[0]["start"], words[-1]["end"]
    return segments


def spread_over_voice(t0: float, t1: float, count: int,
                      runs: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Where `count` words go in the span t0..t1: along the singing in it,
    not across the silences. With none to follow, evenly — as it always was."""
    if count <= 0:
        return []
    inside = [(max(a, t0), min(b, t1)) for a, b in runs if _overlap(a, b, t0, t1) > 0]
    total = sum(b - a for a, b in inside)
    if total < MIN_WORD * count:
        step = (t1 - t0) / count
        return [(t0 + step * k, t0 + step * (k + 1)) for k in range(count)]

    def at(v: float, is_start: bool) -> float:
        """Voiced seconds from t0 -> time. A word that begins exactly where a
        run ends begins in the next run; one that ends there ends in this."""
        for a, b in inside:
            if v < b - a or (v == b - a and not is_start):
                return a + v
            v -= b - a
        return inside[-1][1]

    step = total / count
    return [(at(step * k, True), at(step * (k + 1), False)) for k in range(count)]
