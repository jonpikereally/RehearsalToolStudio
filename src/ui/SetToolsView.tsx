import { useEffect, useRef, useState } from 'react';
import { inflateAls, parseAls, type AlsProject } from '../lib/alsParser';
import * as local from '../lib/localSource';
import {
  defaultVoice,
  helperVoices,
  slateFileName,
  slateTitles,
  speakable,
  synthesize,
  type HelperVoice,
} from '../lib/slates';
import { addSlatesTrack, type SlateClip } from '../lib/slateTrack';
import { addChordTrack, chordClipsFor } from '../lib/chordTrack';
import { parseKey } from '../lib/nashville';
import { checkSet, setlistText, type Severity } from '../lib/setReview';
import { LYRICS_STUDIO } from './LyricClipsPanel';


import SlatesPanel from './SlatesPanel';
import LyricClipsPanel from './LyricClipsPanel';
import UpdatePreparedPanel from './UpdatePreparedPanel';
import { useStore } from '../lib/store';
import { writeClipsToSet } from '../lib/alsWrite';

/**
 * Set tools: everything the studio does *to* an Ableton set.
 *
 * Once the Ableton Playback Helper, a tool of its own; now a screen here,
 * because the studio is the one workbench. Pick a set — from the studio's own
 * source folder, or a lone .als off another machine — and act on it: slates
 * spoken and wired onto their track, the missing chord language written in,
 * lyric clips via Lyrics Studio. Everything writes to a copy, never the
 * original.
 */

const LS_VOICE = 'ls.settools.voice';

export default function SetToolsView() {
  const [folder, setFolder] = useState<local.LocalFolder | null>(null);
  const [setPath, setSetPath] = useState<string | null>(null);
  const [project, setProject] = useState<AlsProject | null>(null);
  const [voices, setVoices] = useState<HelperVoice[] | null>(null);
  const [voice, setVoice] = useState(() => localStorage.getItem(LS_VOICE) ?? '');
  const [lyricsUp, setLyricsUp] = useState<boolean | null>(null);
  const [lone, setLone] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const [outDir, setOutDir] = useState<local.FolderHandle | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [tool, setTool] = useState<
    'check' | 'slates' | 'lyrics' | 'chords' | 'patches' | 'setlist' | 'update'
  >('check');
  const { library, currentSet } = useStore();
  const [askKeys, setAskKeys] = useState<string[] | null>(null);
  const [keyFor, setKeyFor] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const connectHelpers = async () => {
    const found = await helperVoices();
    setVoices(found);
    if (found && !found.some((v) => v.name === voice)) setVoice(defaultVoice(found));
    try {
      const res = await fetch(`${LYRICS_STUDIO}/api/version`, { signal: AbortSignal.timeout(2000) });
      setLyricsUp(res.ok);
    } catch {
      setLyricsUp(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void connectHelpers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * The set is the one chosen on opening; every tool here works on it. It is
   * read afresh whenever that choice changes, and a lone .als opened in the
   * meantime gives way to it.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const stored = await local.storedFolder('songs');
      if (!live) return;
      setFolder(stored);
      setLone(null);
      setChosen(null);
      if (stored && currentSet) await openSet(stored, currentSet);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSet]);

  const backToSet = () => {
    setLone(null);
    setChosen(null);
    if (folder && currentSet) void openSet(folder, currentSet);
  };

  /**
   * A set on its own, with none of its audio to hand.
   *
   * Usually it has come off another machine: the stems are elsewhere and the
   * point is to change the .als itself. Nothing here reads the audio, so that
   * costs nothing — but a file picked on its own grants nothing beside it, so
   * what comes out goes to a folder chosen for it.
   */
  const openLoneAls = async () => {
    setError(null);
    setDone(null);
    try {
      const file = await local.pickFile({ description: 'an Ableton Live set', extensions: ['als'] });
      setProject(await parseAls(file.bytes));
      setLone({ name: file.name, bytes: file.bytes });
      setSetPath(null);
      setChosen(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    }
  };

  /** Where results are written, and what to call them. */
  const destination = async (): Promise<{
    dir: local.FolderHandle;
    prefix: string;
    base: string;
  }> => {
    if (lone) {
      const dir = outDir ?? (await local.pickFolder(null)).handle;
      setOutDir(dir);
      return { dir, prefix: '', base: lone.name };
    }
    const path = setPath!;
    const at = path.lastIndexOf('/');
    return {
      dir: folder!.handle,
      prefix: at < 0 ? '' : `${path.slice(0, at)}/`,
      base: path.slice(at + 1),
    };
  };

  /** The set's bytes, from wherever it came. */
  const setBytes = async (): Promise<ArrayBuffer> =>
    lone ? lone.bytes : (await local.readBytes(folder!.handle, '', setPath!)).bytes;

  const openSet = async (from: local.LocalFolder, path: string) => {
    setError(null);
    setDone(null);
    setSetPath(path);
    setProject(null);
    try {
      const { bytes } = await local.readBytes(from.handle, '', path);
      setProject(await parseAls(bytes));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseVoice = (name: string) => {
    setVoice(name);
    try {
      localStorage.setItem(LS_VOICE, name);
    } catch {
      /* not worth failing over */
    }
  };

  /*
   * What the functions below act on. Nothing chosen yet means the whole set,
   * which is what the buttons say — a set is usually worked on entire, and
   * picking songs is for going back over one that came out wrong.
   */
  const titles = project ? slateTitles(project) : [];
  const selected = chosen ?? new Set(titles);
  const toggle = (title: string) => {
    const next = new Set(selected);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setChosen(next);
  };
  const wholeSet = selected.size === titles.length;

  /** Every song's first locator, deduped the way the slates are. */
  const slatePlan = (p: AlsProject): { title: string; startBar: number; bpm: number }[] => {
    const plan: { title: string; startBar: number; bpm: number }[] = [];
    for (const song of p.songs) {
      if (plan[plan.length - 1]?.title === song.title) continue;
      plan.push({ title: song.title, startBar: song.startBar, bpm: song.bpm ?? p.tempo });
    }
    return plan;
  };

  const addSlates = async () => {
    if (!project || (!setPath && !lone)) return;
    setError(null);
    setDone(null);
    try {
      const { dir, prefix, base } = await destination();
      const beatsPerBar = project.timeSigNum * (4 / project.timeSigDen);
      const plan = slatePlan(project).filter((entry) => selected.has(entry.title));
      if (!plan.length) {
        setError('No songs chosen.');
        return;
      }

      const slates: SlateClip[] = [];
      for (const [i, entry] of plan.entries()) {
        setProgress(`${i + 1} of ${plan.length} — ${entry.title}`);
        const wav = await synthesize(speakable(entry.title), voice);
        const fileName = slateFileName(entry.title);
        await local.writeFile(
          dir,
          '',
          `${prefix}Slates/${fileName}`,
          new Blob([wav as BlobPart], { type: 'audio/wav' }),
        );
        slates.push({
          title: entry.title,
          fileName,
          // Mono 16-bit at 48 kHz, straight from the helper: the data is
          // everything after the 44-byte header, two bytes a frame.
          durationSec: (wav.length - 44) / 2 / 48000,
          sizeBytes: wav.length,
          startBeat: (entry.startBar - 1) * beatsPerBar,
          bpm: entry.bpm,
        });
      }

      setProgress('Writing the set…');
      const xml = await inflateAls(await setBytes());
      const result = addSlatesTrack(xml, slates, Date.now() / 1000);
      const gz = new Blob([result.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (slates).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());
      setDone(
        `${slates.length} slates in ${prefix}Slates, and ${result.clipsWritten} clip` +
          `${result.clipsWritten === 1 ? '' : 's'} ${
            result.reusedTrack
              ? `on the set's own “${result.trackName}” track`
              : 'on a new Slates track'
          } in ${copyPath.split('/').pop()} — open that copy in Live. The original is untouched.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVoices(await helperVoices());
    } finally {
      setProgress(null);
    }
  };

  /**
   * The chords the set hasn't got, written into it.
   *
   * Numbers from names or names from numbers, each song in its own key, as a
   * +LYRICS track — how AbleSet spells a chord track and how this app reads
   * one back. Into a copy, like the slates: this is somebody's project file.
   */
  const addChords = async (force = false) => {
    if (!project || (!setPath && !lone)) return;
    setError(null);
    setDone(null);
    try {
      const { clips, trackName, converted, withoutKey } = chordClipsFor(project, keyFor, [
        ...selected,
      ]);

      /*
       * A song whose locator never named a key can still be converted — the
       * key just has to come from somewhere, and the person looking at the set
       * knows it. Asked for once, rather than the song being dropped quietly.
       */
      if (withoutKey.length && !force) {
        setAskKeys(withoutKey);
        return;
      }
      if (!clips.length) {
        setError('Nothing to convert — this set has no chord track, or already has both.');
        return;
      }
      setAskKeys(null);
      setProgress('Working out the chords…');

      const { dir, prefix, base } = await destination();
      const result = addChordTrack(await inflateAls(await setBytes()), clips, trackName, project);
      const gz = new Blob([result.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (chords).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());

      setDone(
        `${result.clipsWritten} chords on a “${trackName}” track across ${converted.length} song` +
          `${converted.length === 1 ? '' : 's'} in ${copyPath.split('/').pop()} — open that copy in Live. ` +
          `The original is untouched.` +
          (withoutKey.length
            ? ` ${withoutKey.length} song${withoutKey.length === 1 ? '' : 's'} skipped for want of a key: ${withoutKey.slice(0, 4).join(', ')}.`
            : ''),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  /**
   * The library's patch clips, written into the set as *rig locators — the
   * same commit the player offers per song, here for the set at once. Only
   * for a set from the folder: a lone .als was never scanned, so the library
   * has no songs of it to take patches from.
   */
  const writePatches = async () => {
    if (!project || !setPath || !folder) return;
    setError(null);
    setDone(null);
    setProgress('Writing patch changes…');
    try {
      const result = await writeClipsToSet({
        alsPath: setPath,
        project,
        songs: library.songs.filter((song) => selected.has(song.title)),
        readBytes: async (path) => (await local.readBytes(folder.handle, '', path)).bytes,
        writeFile: (path, data) => local.writeFile(folder.handle, '', path, data),
      });
      setDone(
        `${result.written} patch change${result.written === 1 ? '' : 's'} written into ` +
          `${result.path.split('/').pop()} — open that copy in Live.` +
          (result.missed.length
            ? ` Not in the library, so nothing to take: ${result.missed.slice(0, 3).join(', ')}${result.missed.length > 3 ? '…' : ''}.`
            : ''),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  const sendToLyricsStudio = async () => {
    if (!setPath || !folder) return;
    setError(null);
    try {
      const stat = await local.statFile(folder.handle, '', setPath);
      const query = new URLSearchParams({
        als_name: stat.name,
        als_size: String(stat.size),
        als_mtime: String(stat.modified),
      });
      window.open(`${LYRICS_STUDIO}/?${query}`, '_blank');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const ready = voices !== null && voices.length > 0 && !!voice;

  return (
    <div style={{ padding: '16px' }}>
      <div>
        <div style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 16 }}>
          Everything the studio does to an Ableton set: a preflight check, spoken slates, the
          missing chord language, timed lyric clips, patch changes, a printable setlist. Anything
          that writes writes to a copy, never the original.
        </div>

        {!lone && (
          <div className="field">
            <label>
              The set
              <span className="hint">
                {currentSet
                  ? 'The set chosen on opening — change it from the bar above.'
                  : 'No set chosen yet — pick one from the Songs tab.'}
              </span>
            </label>
            <div className="btn-row">
              {currentSet && <span className="code">{currentSet.split('/').pop()}</span>}
              <button className="btn" disabled={!!progress} onClick={() => void openLoneAls()}>
                Open a single .als…
              </button>
            </div>
          </div>
        )}

        {lone && (
          <div className="field">
            <label>
              The set
              <span className="hint">
                Opened on its own, so its audio isn't to hand — everything here changes the .als
                itself. What comes out goes to a folder you choose.
              </span>
            </label>
            <div className="btn-row">
              <span className="code">{lone.name}</span>
              <button className="btn" disabled={!!progress} onClick={() => void openLoneAls()}>
                Different .als…
              </button>
              {currentSet && (
                <button className="btn" disabled={!!progress} onClick={backToSet}>
                  Back to {currentSet.split('/').pop()?.replace(/\.als$/i, '')}
                </button>
              )}
            </div>
          </div>
        )}

        {!project && (
          <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            Choose a set above — every tool here works on one.
          </div>
        )}

        {project && (
          <>
            <div className="notice">
              {titles.length} song{titles.length === 1 ? '' : 's'}: {titles.slice(0, 6).join(', ')}
              {titles.length > 6 ? '…' : ''}
            </div>

            <div className="field">
              <label>
                What to work on
                <span className="hint">
                  The whole set, or the songs you tick. Every function below acts on this.
                </span>
              </label>
              <div className="btn-row" style={{ marginBottom: 6 }}>
                <button className="btn" disabled={!!progress} onClick={() => setChosen(new Set(titles))}>
                  Whole set
                </button>
                <button className="btn" disabled={!!progress} onClick={() => setChosen(new Set())}>
                  Clear
                </button>
                <span style={{ color: 'var(--text-dim)', fontSize: 13, alignSelf: 'center' }}>
                  {wholeSet ? `all ${titles.length} songs` : `${selected.size} of ${titles.length}`}
                </span>
              </div>
              <div
                style={{
                  maxHeight: 200,
                  overflowY: 'auto',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '6px 10px',
                }}
              >
                {titles.map((title) => (
                  <label
                    key={title}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(title)}
                      disabled={!!progress}
                      onChange={() => toggle(title)}
                    />
                    <span style={{ fontSize: 14 }}>{title}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        {/*
          The tools themselves. Below the set and the songs to work on, because
          those are the same whichever tool is chosen — a shared control under
          the tab bar would read as belonging to the tab.
        */}
        <nav className="subtabs" role="tablist" aria-label="Set tools">
          {(
            [
              ['check', 'Check set'],
              ['slates', 'Slates'],
              ['lyrics', 'Lyrics'],
              ['chords', 'Chords'],
              ['patches', 'Patch changes'],
              ['setlist', 'Setlist'],
              ['update', 'Update the band'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              id={`settool-${key}`}
              aria-selected={tool === key}
              aria-controls="settool-panel"
              onClick={() => setTool(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div id="settool-panel" role="tabpanel" aria-labelledby={`settool-${tool}`}>
          {project && (
            <>
              {tool === 'update' && (
                <UpdatePreparedPanel
                  project={project}
                  alsPath={lone ? null : setPath}
                  selected={selected}
                  titles={titles}
                />
              )}

              {tool === 'slates' && (
                <>
                  {voices === null && (
                    <div className="notice">
                      The voice helper isn't running — slates need it. In a terminal:
                      <br />
                      <span className="code">npm run slates:helper</span>
                      <div className="btn-row" style={{ marginTop: 8 }}>
                        <button className="btn" onClick={() => void connectHelpers()}>
                          Look again
                        </button>
                      </div>
                    </div>
                  )}
                  {ready && (
                    <div className="field">
                      <label htmlFor="playback-voice">Voice</label>
                      <select id="playback-voice" value={voice} onChange={(e) => chooseVoice(e.target.value)}>
                        {voices
                          .filter((v) => v.lang.startsWith('en'))
                          .map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}
                  <div className="btn-row">
                    <button
                      className="btn primary"
                      disabled={!ready || !!progress || !titles.length}
                      onClick={() => void addSlates()}
                    >
                      {wholeSet ? 'Add slates to the whole set' : `Add slates to ${selected.size} song${selected.size === 1 ? '' : 's'}`}
                    </button>
                  </div>
                  <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                    Spoken titles onto the set's Slate track, in a copy — never the original.
                  </div>
                </>
              )}

              {tool === 'lyrics' && (
                <>
                  <div className="btn-row">
                    <button className="btn primary" disabled={!lyricsUp} onClick={() => void sendToLyricsStudio()}>
                      Add lyric clips in Lyrics Studio
                    </button>
                  </div>
                  {lyricsUp === false && (
                    <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                      Lyrics Studio isn't running — double-click{' '}
                      <span className="code">Start Lyrics Studio.command</span> first.
                    </div>
                  )}
                  <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                    Save and close the set in Live first — Lyrics Studio writes to the .als itself,
                    keeping a backup beside it.
                  </div>
                </>
              )}

              {tool === 'chords' && (
                <>
                  <div className="btn-row">
                    <button className="btn primary" disabled={!!progress} onClick={() => void addChords()}>
                      {wholeSet ? 'Convert chords, whole set' : `Convert chords, ${selected.size} song${selected.size === 1 ? '' : 's'}`}
                    </button>
                  </div>
                  <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                    Writes the chord language the set is missing — names from numbers or numbers from
                    names, each song in its own key — as a +LYRICS track in a copy of the set.
                  </div>
                </>
              )}

              {tool === 'check' && <CheckPanel project={project} selected={selected} />}

              {tool === 'setlist' && <SetlistPanel project={project} selected={selected} />}

              {tool === 'patches' && (
                <>
                  <div className="btn-row">
                    <button
                      className="btn primary"
                      disabled={!!progress || !!lone}
                      onClick={() => void writePatches()}
                    >
                      {wholeSet
                        ? 'Write patch changes into the set'
                        : `Write patch changes, ${selected.size} song${selected.size === 1 ? '' : 's'}`}
                    </button>
                  </div>
                  <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                    The patch clips programmed in the player, written into a copy of the set as *rig
                    locators — visible in Ableton, read back on the next scan. Program them per song
                    in the player's patch lane.
                    {lone ? ' A lone .als was never scanned, so the library has no patches for it.' : ''}
                  </div>
                </>
              )}
            </>
          )}

          {askKeys && (
            <div className="notice">
              <div style={{ marginBottom: 8 }}>
                {askKeys.length} song{askKeys.length === 1 ? '' : 's'} have chords but no key in the
                set, so there is nothing to count from. Type the key and they come across too —
                anything like <span className="code">Eb</span>, <span className="code">F#m</span>,{' '}
                <span className="code">Am</span>. Leave one blank to skip it.
              </div>
              {askKeys.map((title) => {
                const typed = keyFor[title] ?? '';
                const good = !!parseKey(typed);
                return (
                  <div
                    key={title}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}
                  >
                    <span style={{ flex: 1, fontSize: 14 }}>{title}</span>
                    <input
                      type="text"
                      value={typed}
                      placeholder="key"
                      size={6}
                      style={{
                        width: 72,
                        borderColor: typed && !good ? 'var(--bad)' : undefined,
                      }}
                      onChange={(e) => setKeyFor({ ...keyFor, [title]: e.target.value })}
                    />
                    <span style={{ width: 60, fontSize: 12, color: 'var(--text-dim)' }}>
                      {typed ? (good ? 'ok' : 'not a key') : 'skipped'}
                    </span>
                  </div>
                );
              })}
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn primary" disabled={!!progress} onClick={() => void addChords(true)}>
                  Write the chords
                </button>
                <button className="btn" disabled={!!progress} onClick={() => setAskKeys(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {progress && <div className="notice">{progress}</div>}
          {done && <div className="notice">{done}</div>}
          {error && <div className="notice error">{error}</div>}

          {tool === 'slates' && <SlatesPanel />}
          {tool === 'lyrics' && <LyricClipsPanel />}
        </div>
      </div>
    </div>
  );
}

/**
 * The preflight: everything the parser can see that would go wrong live,
 * reported the moment a set is chosen rather than discovered at the gig.
 * Set-wide findings always show; per-song ones follow the tick list, so a
 * check can be narrowed to the song being worked on.
 */
function CheckPanel({ project, selected }: { project: AlsProject; selected: Set<string> }) {
  const findings = checkSet(project).filter((f) => !f.song || selected.has(f.song));
  const count = (severity: Severity) => findings.filter((f) => f.severity === severity).length;
  const problems = count('problem');
  const warnings = count('warning');

  const MARK: Record<Severity, { glyph: string; color: string }> = {
    problem: { glyph: '●', color: 'var(--bad)' },
    warning: { glyph: '●', color: 'var(--accent)' },
    info: { glyph: '○', color: 'var(--text-faint)' },
  };

  // Set-wide first, then song findings in set order — the order they'd bite.
  const order = new Map(project.songs.map((s, i) => [s.title, i]));
  const sorted = [...findings].sort(
    (a, b) => (a.song ? (order.get(a.song) ?? 0) : -1) - (b.song ? (order.get(b.song) ?? 0) : -1),
  );

  return (
    <div className="field">
      <label>
        What the checker sees
        <span className="hint">
          Red would go wrong at the gig, amber deserves a look, hollow is worth knowing.
        </span>
      </label>
      <div className="notice">
        {problems
          ? `${problems} problem${problems === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`
          : warnings
            ? `No problems, ${warnings} warning${warnings === 1 ? '' : 's'}.`
            : 'Nothing would go wrong live that this checker can see.'}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {sorted.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13.5 }}>
            <span aria-hidden style={{ color: MARK[f.severity].color }}>
              {MARK[f.severity].glyph}
            </span>
            <span>
              {f.song && <strong style={{ marginRight: 6 }}>{f.song}</strong>}
              <span style={{ color: f.severity === 'info' ? 'var(--text-dim)' : 'var(--text)' }}>
                {f.message}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The running order as text, ready for a green room door or a front desk. */
function SetlistPanel({ project, selected }: { project: AlsProject; selected: Set<string> }) {
  const [copied, setCopied] = useState(false);
  const text = setlistText(project, selected);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'setlist.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="field">
      <label>
        Setlist
        <span className="hint">
          Durations come from the arrangement and its tempo automation, not from what a locator
          claims — the total is what the set actually runs.
        </span>
      </label>
      <pre
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '10px 14px',
          fontSize: 13.5,
          lineHeight: 1.6,
          overflowX: 'auto',
        }}
      >
        {text}
      </pre>
      <div className="btn-row">
        <button className="btn primary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn" onClick={download}>
          Download .txt
        </button>
      </div>
    </div>
  );
}
