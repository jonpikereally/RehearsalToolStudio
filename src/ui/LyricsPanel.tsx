import { useRef, useState } from 'react';
import { keepOnlyAdded } from '../lib/alsEdit';
import { inflateAls, type AlsProject, type AlsSong } from '../lib/alsParser';
import { addChordTrack, type ChordClip } from '../lib/chordTrack';
import { FINENESS_LABEL, lyricClipsFrom, type LyricFineness } from '../lib/lyricClips';
import { engineStartedBy, ensureLyricsStudio, isFolderRefusal, restartLyricsStudio, transcribeTrack, type TranscribedSegment } from '../lib/lyricsStudio';
import * as local from '../lib/localSource';
import { remember } from '../lib/remember';

/**
 * Set tools ▸ Lyrics.
 *
 * Three things, in the order they are done. Which songs already have words:
 * clips on a `+LYRICS` track inside the song's stretch of the set. Words for
 * the songs ticked, heard from one of each song's own tracks — Ref Vox where
 * there is one. And those words written as MIDI clips on a `+LYRICS` track,
 * every song's at once, in a copy of the set beside it.
 *
 * The listening is Lyrics Studio's engine, started here when it is not up;
 * it reads the set file itself, so warping and the tempo map are its own.
 * What it hears can be read and corrected line by line before anything is
 * written.
 */

type Row =
  | { state: 'queued' }
  | { state: 'listening'; note: string }
  | { state: 'heard'; segments: TranscribedSegment[]; clips: ChordClip[]; missing: number }
  | { state: 'failed'; error: string };

/** The words a song already has: its +LYRICS clips, chord tracks aside. */
export function lyricClipCount(song: AlsSong): number {
  return song.lanes.filter((l) => l.kind === 'lyrics').reduce((n, l) => n + l.items.length, 0);
}

/*
 * The track to listen to, by name, which is all there is to go on: one
 * called "Ref Vox", else the record's own lead vocal, else any lead vocal,
 * else a backing vocal, else the first. LV and BV are a lead and a backing
 * vocal.
 */
const backing = (name: string) => /\b(bv|bvs|backing|harmony|harmonies|bgv)\b/i.test(name);
const vocalish = (name: string) => /\b(vox|vocal|vocals|voice|lead|lv|sing|singer|melody)\b/i.test(name) && !backing(name);

type Listenable = { trackId: string; name: string; reference: boolean; group: string | null };

/**
 * Every audio track with a clip inside the song, wherever it sits in the set:
 * the song's own group first, as the set orders them, then the rest. The
 * click and cues the studio makes up are not tracks of the set, so not here.
 */
export function listenableTracks(song: AlsSong): Listenable[] {
  const own = new Set(song.stems.map((st) => st.trackId).filter(Boolean));
  const all: Listenable[] =
    song.audioTracks ??
    song.stems.filter((st) => st.trackId).map((st) => ({ trackId: st.trackId!, name: st.name, reference: st.reference, group: null }));
  return [...all.filter((t) => own.has(t.trackId)), ...all.filter((t) => !own.has(t.trackId))];
}

export function vocalTrackFor(song: AlsSong) {
  const stems = listenableTracks(song);
  return (
    stems.find((st) => st.name.trim().toLowerCase().replace(/\s+/g, ' ') === 'ref vox') ??
    stems.find((st) => st.reference && vocalish(st.name)) ??
    stems.find((st) => vocalish(st.name)) ??
    stems.find((st) => backing(st.name)) ??
    stems[0] ??
    null
  );
}

function barLabel(bar: number): string {
  return Number.isInteger(bar) ? String(bar) : bar.toFixed(2).replace(/0$/, '');
}

export default function LyricsPanel({
  project,
  setPath,
  folder,
  hidden,
}: {
  project: AlsProject;
  setPath: string;
  folder: local.LocalFolder;
  hidden: boolean;
}) {
  const songs = project.songs.filter((s) => listenableTracks(s).length || lyricClipCount(s));
  const [picked, setPicked] = useState<string[]>([]);
  const [trackFor, setTrackFor] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [fineness, setFineness] = useState<LyricFineness>(() => {
    try {
      return (localStorage.getItem('ls.settools.lyricFineness') as LyricFineness) || 'line';
    } catch {
      return 'line';
    }
  });
  const [isolate, setIsolate] = useState(false);
  const [running, setRunning] = useState(false);
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  const without = songs.filter((s) => !lyricClipCount(s) && listenableTracks(s).length).map((s) => s.title);
  const trackOf = (song: AlsSong) =>
    listenableTracks(song).find((st) => st.trackId === trackFor[song.title]) ?? vocalTrackFor(song);
  const setRow = (title: string, row: Row) => setRows((prev) => ({ ...prev, [title]: row }));
  const heard = songs.filter((s) => rows[s.title]?.state === 'heard');
  const busy = running || writing;

  const toggle = (title: string) =>
    setPicked((prev) => (prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]));

  const chooseFineness = (f: LyricFineness) => {
    setFineness(f);
    remember('ls.settools.lyricFineness', f);
    // What was heard is cut again; corrections made to the old cut go with it.
    setRows((prev) => {
      const next = { ...prev };
      for (const [title, row] of Object.entries(prev)) {
        if (row.state === 'heard') next[title] = { ...row, clips: lyricClipsFrom(row.segments, project, f) };
      }
      return next;
    });
  };

  const detect = async () => {
    const queue = songs.filter((s) => picked.includes(s.title));
    if (!queue.length) return;
    stop.current = false;
    setRunning(true);
    setError(null);
    setDone(null);
    for (const s of queue) setRow(s.title, { state: 'queued' });
    try {
      setNote('Starting the listening engine…');
      let url = await ensureLyricsStudio((n) => setNote(n));
      /*
       * An engine an earlier build started — it outlives the app by twenty
       * minutes — has that build's folder permissions, which macOS takes back
       * once the app is updated: every file reads as unreadable. So one this
       * build didn't start is started again, under this build.
       */
      if ((await engineStartedBy(url)) !== __BUILD__) url = await restartLyricsStudio(url, (n) => setNote(n));
      const alsPath = await local.absolutePath(folder.handle, '', setPath);
      setNote(null);
      for (const [i, song] of queue.entries()) {
        if (stop.current) {
          for (const rest of queue.slice(i)) setRows((prev) => (prev[rest.title]?.state === 'queued' ? { ...prev, [rest.title]: { state: 'failed', error: 'Stopped before it was listened to.' } } : prev));
          break;
        }
        const track = trackOf(song);
        if (!track) {
          setRow(song.title, { state: 'failed', error: 'This song has no audio track to listen to.' });
          continue;
        }
        const listening = (n: string) => setRow(song.title, { state: 'listening', note: n });
        listening(`Listening to “${track.name}”…`);
        const listen = () =>
          transcribeTrack(
            url,
            { alsPath, trackId: track.trackId, startBar: song.startBar, endBar: song.endBar, isolate },
            (d, total, phase) => listening(`“${track.name}”: ${phase}, part ${Math.min(d + 1, total)} of ${total}…`),
          );
        try {
          let result;
          try {
            result = await listen();
          } catch (err) {
            /*
             * macOS grants a folder per app. An engine started from a Terminal
             * cannot read a set this studio can — so it is started again from
             * here, as the studio's own child, and asked once more.
             */
            if (!isFolderRefusal(err)) throw err;
            url = await restartLyricsStudio(url, (n) => listening(n));
            result = await listen();
          }
          const clips = lyricClipsFrom(result.segments, project, fineness);
          if (!clips.length) {
            setRow(song.title, { state: 'failed', error: `No words were heard on “${track.name}” inside the song.` });
          } else {
            setRow(song.title, { state: 'heard', segments: result.segments, clips, missing: result.regions.missing });
          }
        } catch (err) {
          setRow(song.title, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      // The engine itself would not start: every song still waiting says so.
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setRows((prev) => {
        const next = { ...prev };
        for (const s of queue) if (next[s.title]?.state === 'queued') next[s.title] = { state: 'failed', error: 'Not listened to: the engine did not start.' };
        return next;
      });
    } finally {
      setNote(null);
      setRunning(false);
    }
  };

  const editClip = (title: string, index: number, text: string | null) =>
    setRows((prev) => {
      const row = prev[title];
      if (row?.state !== 'heard') return prev;
      const clips = text === null ? row.clips.filter((_, i) => i !== index) : row.clips.map((c, i) => (i === index ? { ...c, text } : c));
      return { ...prev, [title]: { ...row, clips } };
    });

  const write = async () => {
    const clips = heard
      .flatMap((s) => (rows[s.title] as Extract<Row, { state: 'heard' }>).clips)
      .filter((c) => c.text.trim())
      .sort((a, b) => a.bar - b.bar);
    if (!clips.length) return;
    setWriting(true);
    setError(null);
    setDone(null);
    try {
      const at = setPath.lastIndexOf('/');
      const prefix = at < 0 ? '' : `${setPath.slice(0, at)}/`;
      const base = setPath.slice(at + 1).replace(/\.als$/i, '');
      const xml = await inflateAls((await local.readBytes(folder.handle, '', setPath)).bytes);
      const result = addChordTrack(xml, clips, 'LYRICS +LYRICS', project);
      const only = keepOnlyAdded(result.xml, [result.trackName]);
      const gz = new Blob([only.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const copyPath = `${prefix}${base} (lyrics).als`;
      await local.writeFile(folder.handle, '', copyPath, await new Response(gz).blob());
      setDone(
        `${clips.length} lyric clip${clips.length === 1 ? '' : 's'} for ${heard.length} song${heard.length === 1 ? '' : 's'}, ` +
          `on “${result.trackName}” in ${copyPath.split('/').pop()}: a copy holding only that track, on the set's own timeline. ` +
          'Open it beside the set and drag the track across. The original is untouched.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWriting(false);
    }
  };

  return (
    <div hidden={hidden} className="lyrics-panel">
      <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        {without.length
          ? `${songs.length - without.length} of ${songs.length} songs have lyrics on a +LYRICS track. Tick the songs to hear lyrics for.`
          : `Every song has lyrics on a +LYRICS track. Tick any to hear them again.`}
      </div>

      <div className="controls flush" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button className="chip" disabled={busy || !without.length} onClick={() => setPicked(without)}>
          Tick the {without.length} without lyrics
        </button>
        <button className="chip" disabled={busy || !picked.length} onClick={() => setPicked([])}>
          Untick all
        </button>
      </div>

      <div className="lyric-songs" role="list">
        {songs.map((song) => {
          const count = lyricClipCount(song);
          const tracks = listenableTracks(song);
          const track = trackOf(song);
          const row = rows[song.title];
          return (
            <div key={song.title} className="lyric-song" role="listitem">
              <label className="lyric-song-name">
                <input
                  type="checkbox"
                  checked={picked.includes(song.title)}
                  disabled={busy || !tracks.length}
                  onChange={() => toggle(song.title)}
                />
                <span>{song.title}</span>
              </label>
              {count ? (
                <span className="badge ok" title="Clips on a +LYRICS track inside this song">
                  {count} lyric clip{count === 1 ? '' : 's'}
                </span>
              ) : (
                <span className="badge warn">no lyrics</span>
              )}
              {tracks.length ? (
                <select
                  className="jump-select"
                  value={track?.trackId ?? ''}
                  disabled={busy}
                  onChange={(e) => setTrackFor((prev) => ({ ...prev, [song.title]: e.target.value }))}
                  title="The track to listen to"
                >
                  {tracks.map((st) => (
                    <option key={st.trackId} value={st.trackId}>
                      {st.name}
                      {st.group && tracks.some((o) => o !== st && o.name === st.name) ? ` (${st.group})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="lyric-song-note">no audio track</span>
              )}
              <span className="lyric-song-note">
                {row?.state === 'queued' && 'waiting…'}
                {row?.state === 'listening' && row.note}
                {row?.state === 'heard' && (
                  <button className="chip on" onClick={() => setOpen(open === song.title ? null : song.title)}>
                    {row.clips.length} line{row.clips.length === 1 ? '' : 's'} heard — {open === song.title ? 'hide' : 'read and correct'}
                  </button>
                )}
                {row?.state === 'failed' && <span className="lyric-song-error">{row.error}</span>}
              </span>
              {row?.state === 'heard' && open === song.title && (
                <div className="lyric-lines">
                  {row.missing > 0 && (
                    <div className="notice">
                      {row.missing} part{row.missing === 1 ? '' : 's'} of the track could not be read, so may have words missing.
                    </div>
                  )}
                  {row.clips.map((clip, i) => (
                    <div key={i} className="lyric-line">
                      <span className="lyric-bar" title="Bar in the set">
                        {barLabel(clip.bar)}
                      </span>
                      <input
                        className="text-input"
                        value={clip.text}
                        disabled={busy}
                        onChange={(e) => editClip(song.title, i, e.target.value)}
                      />
                      <button className="icon-btn" disabled={busy} onClick={() => editClip(song.title, i, null)} aria-label="Remove this line">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="controls flush" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['line', 'section', 'word'] as LyricFineness[]).map((f) => (
          <button key={f} className={fineness === f ? 'chip on' : 'chip'} aria-pressed={fineness === f} disabled={busy} onClick={() => chooseFineness(f)}>
            {FINENESS_LABEL[f]}
          </button>
        ))}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', marginLeft: 8 }}>
          <input type="checkbox" checked={isolate} disabled={busy} onChange={(e) => setIsolate(e.target.checked)} />
          <span style={{ fontSize: 14 }}>Isolate the voice first (slower; for a track with music on it)</span>
        </label>
      </div>

      <div className="btn-row">
        {running ? (
          <button className="btn" onClick={() => (stop.current = true)}>
            Stop after this song
          </button>
        ) : (
          <button className="btn primary" disabled={busy || !picked.length} onClick={() => void detect()}>
            {picked.length ? `Hear lyrics for ${picked.length} song${picked.length === 1 ? '' : 's'}` : 'Tick songs to hear lyrics for'}
          </button>
        )}
        <button className="btn primary" disabled={busy || !heard.length} onClick={() => void write()}>
          {heard.length ? `Write lyric clips for ${heard.length} song${heard.length === 1 ? '' : 's'}` : 'Write lyric clips'}
        </button>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
        Listening runs on this Mac, a minute or so per song. The clips go on a +LYRICS track in a copy of the set named
        “… (lyrics).als”. Save the set in Live first, so it is read as it stands.
      </div>

      {note && <div className="notice">{note}</div>}
      {writing && <div className="notice">Writing the set…</div>}
      {done && <div className="notice">{done}</div>}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
