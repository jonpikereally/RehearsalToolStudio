import { useEffect, useRef, useState } from 'react';
import { inflateAls, parseAls, type AlsProject } from '../lib/alsParser';
import * as local from '../lib/localSource';
import { isFromMidiClip } from '../lib/alsImport';
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
import { abletReads, DEFAULT_INFO_FIELDS, DEFAULT_INFO_TRACK, INFO_FIELD_LABEL, infoClipsFor, infoLinesFor, type InfoFields } from '../lib/infoTrack';
import { keyRank, type SortSpec } from '../lib/songSort';
import { addThis } from '../lib/alsEdit';
import { runningOrderTitles } from '../lib/ableset';
import SortBar, { useSort } from './SortBar';
import { parseKey } from '../lib/nashville';
import { setlistText } from '../lib/setReview';
import { findLyricsStudio } from '../lib/lyricsStudio';


import SlatesPanel from './SlatesPanel';
import LyricClipsPanel from './LyricClipsPanel';
import UpdatePreparedPanel from './UpdatePreparedPanel';
import CheckSetPanel from './CheckSetPanel';
import { useStore } from '../lib/store';
import { addRigTracks, type RigTrackSpec } from '../lib/rigTrack';
import { parseMemberRig, rigTrackSpecFor, studioChanges, RIG_FILES_FOLDER } from '../lib/rigFiles';
import { locatePrepared } from '../lib/locatePrepared';

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
const LS_INFO = 'ls.settools.info';
const LS_INFO_TRACK = 'ls.settools.info.track';
const LS_INFO_SPAN = 'ls.settools.info.span';

export default function SetToolsView() {
  const [folder, setFolder] = useState<local.LocalFolder | null>(null);
  const [setPath, setSetPath] = useState<string | null>(null);
  const [project, setProject] = useState<AlsProject | null>(null);
  const [voices, setVoices] = useState<HelperVoice[] | null>(null);
  const [voice, setVoice] = useState(() => localStorage.getItem(LS_VOICE) ?? '');
  /** Where Lyrics Studio answers; null once looked for and not found. */
  const [lyricsUrl, setLyricsUrl] = useState<string | null | undefined>(undefined);
  const lyricsUp = lyricsUrl === undefined ? null : lyricsUrl !== null;
  const [lone, setLone] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const [outDir, setOutDir] = useState<local.FolderHandle | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const { library, currentSet, publishFolder, pickPublishFolder } = useStore();
  const [tool, setTool] = useState<
    'check' | 'slates' | 'lyrics' | 'chords' | 'info' | 'patches' | 'setlist' | 'update'
  >(currentSet ? 'check' : 'slates');
  /*
   * Song info clips: which facts, remembered on this device, and whether the
   * clip runs the song or only its first bar.
   */
  const [infoFields, setInfoFields] = useState<InfoFields>(() => {
    try {
      const raw = localStorage.getItem(LS_INFO);
      return raw ? { ...DEFAULT_INFO_FIELDS, ...(JSON.parse(raw) as Partial<InfoFields>) } : DEFAULT_INFO_FIELDS;
    } catch {
      return DEFAULT_INFO_FIELDS;
    }
  });
  const [infoTrack, setInfoTrack] = useState(() => localStorage.getItem(LS_INFO_TRACK) || DEFAULT_INFO_TRACK);
  const [infoWholeSong, setInfoWholeSong] = useState(() => localStorage.getItem(LS_INFO_SPAN) !== 'bar');
  const setInfoField = (key: keyof InfoFields, on: boolean) =>
    setInfoFields((was) => {
      const next = { ...was, [key]: on };
      try {
        localStorage.setItem(LS_INFO, JSON.stringify(next));
      } catch {
        /* not remembered, then */
      }
      return next;
    });
  /* The song picker: sorted, and narrowed by a few typed letters. */
  const [pickSort, setPickSort] = useSort('ls.sort.settools');
  const [pickFilter, setPickFilter] = useState('');
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
    setLyricsUrl(await findLyricsStudio());
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

  /*
   * The picker's rows: in the chosen order, narrowed by the filter. Set
   * order is the set's own; name, key and tempo read from the locators.
   */
  const shownTitles = (() => {
    const needle = pickFilter.trim().toLowerCase();
    // Set order is the running order — AbleSet's, as the library has it —
    // with the arrangement's order for a set the library has no setlist for.
    const running = setPath && !lone ? runningOrderTitles(library, setPath) : null;
    const place = new Map((running ?? []).map((t, i) => [t, i]));
    const info = new Map(project?.songs.map((sg, i) => [sg.title, { i: place.get(sg.title) ?? (running ? running.length + i : i), sg }]) ?? []);
    const rows = titles.filter((t) => !needle || t.toLowerCase().includes(needle));
    const sign = pickSort.dir === 'asc' ? 1 : -1;
    const value = (t: string): number | string | null => {
      const it = info.get(t);
      if (!it) return null;
      switch ((pickSort as SortSpec).key) {
        case 'set':
          return it.i;
        case 'name':
          return t.toLowerCase();
        case 'key':
          return keyRank(it.sg.key ?? undefined);
        case 'tempo':
          return it.sg.bpm ?? it.sg.startBpm ?? null;
      }
    };
    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null && vb === null) return a.localeCompare(b);
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : (va as number) - (vb as number);
      return cmp !== 0 ? sign * cmp : a.localeCompare(b);
    });
  })();
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
   * Song info, as one AbleSet lyrics clip per song in a copy of the set.
   */
  const addInfo = async () => {
    if (!project || (!setPath && !lone)) return;
    setError(null);
    setDone(null);
    try {
      const trackName = addThis(infoTrack.trim() || DEFAULT_INFO_TRACK);
      const { clips, songs, empty } = infoClipsFor(project, [...selected], infoFields, {
        wholeSong: infoWholeSong,
        keyFor,
        forAbleSet: abletReads(trackName),
      });
      if (!clips.length) {
        setError('Nothing to write — tick at least one kind of information, for songs that have it.');
        return;
      }
      setProgress('Writing song info…');
      const { dir, prefix, base } = await destination();
      const result = addChordTrack(await inflateAls(await setBytes()), clips, trackName, project);
      const gz = new Blob([result.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (info).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());
      setDone(
        `${result.clipsWritten} song info clip${result.clipsWritten === 1 ? '' : 's'} on a “${trackName}” track, ` +
          `${songs.length} song${songs.length === 1 ? '' : 's'}, in ${copyPath.split('/').pop()} — open that copy in Live. ` +
          'The original is untouched.' +
          (empty.length ? ` ${empty.length} song${empty.length === 1 ? ' had' : 's had'} nothing to say: ${empty.slice(0, 4).join(', ')}.` : ''),
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
  /**
   * Patch changes into a copy of the set, as MIDI clips.
   *
   * Two sources, one track each: what the band wrote for their own rigs on
   * the website, one file per member under the prepared set's rigs/
   * folder; and what was programmed in the player here, as the leader's
   * own. Changes the set already sends from its clips are left out, since
   * they are in the set. Each track is modelled on a rig track the set has,
   * so the routing and the controller numbering are the set's own.
   */
  const writePatches = async () => {
    if (!project || !setPath || !folder) return;
    setError(null);
    setDone(null);
    setProgress('Gathering patch changes…');
    try {
      const specs: RigTrackSpec[] = [];
      const notes: string[] = [];

      const band = (await publishFolder()) ?? (await pickPublishFolder());
      if (band) {
        const found = await locatePrepared(band, setPath);
        if (!('error' in found)) {
          const under = `${found.setFolder}/${RIG_FILES_FOLDER}/`.replace(/^\/+/, '').toLowerCase();
          const files = (await local.listFiles(band, '')).filter(
            (f) => f.path.replace(/^\/+/, '').toLowerCase().startsWith(under) && f.name.toLowerCase().endsWith('.json'),
          );
          for (const file of files) {
            const doc = await local.readJson<unknown>(band, '', file.path).catch(() => null);
            const rig = doc ? parseMemberRig(doc.data) : null;
            if (!rig) {
              notes.push(`${file.name} is not a rig file`);
              continue;
            }
            const { spec, unknownFolders } = rigTrackSpecFor(rig, project, selected);
            if (unknownFolders.length) notes.push(`${rig.member} names songs the set hasn't got: ${unknownFolders.slice(0, 3).join(', ')}`);
            if (spec.changes.length) specs.push(spec);
          }
        }
      }

      const mine: RigTrackSpec['changes'] = [];
      for (const song of library.songs) {
        if (!selected.has(song.title) || !song.patchClips?.length) continue;
        const als = project.songs.find((x) => x.title === song.title);
        if (als) mine.push(...studioChanges(song.patchClips, als.startBar, isFromMidiClip));
      }
      if (mine.length) specs.push({ member: 'Studio', changes: mine });

      if (!specs.length) {
        setError(
          'No patch changes to write: none programmed in the player for these songs, and no rig files from the band' +
            (band ? '.' : ' — choose the band’s folder to look for theirs.'),
        );
        return;
      }
      setProgress('Writing patch changes…');
      const result = addRigTracks(await inflateAls(await setBytes()), specs, project);
      const gz = new Blob([result.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const { dir, prefix, base } = await destination();
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (rig).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());
      const dropped = result.tracks.reduce((n, t) => n + t.dropped, 0);
      setDone(
        `${result.tracks.map((t) => `${t.clips} clip${t.clips === 1 ? '' : 's'} on “${t.name}”`).join(', ')} in ${copyPath.split('/').pop()} — ` +
          'drag the tracks into the set in Live. The original is untouched.' +
          (dropped ? ` ${dropped} CC${dropped === 1 ? '' : 's'} had no envelope target on the model track and were left out.` : '') +
          (notes.length ? ` ${notes.join('. ')}.` : ''),
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
      if (lyricsUrl) window.open(`${lyricsUrl}/?${query}`, '_blank');
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
                  : 'No set chosen. Slates and Lyrics work without one; the rest need a set, from the Songs tab or a single .als here.'}
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

        {!project && tool !== 'slates' && tool !== 'lyrics' && (
          <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            Choose a set above — this tool works on one. Slates and Lyrics work without.
          </div>
        )}

        {project && (
          <>
            <div className="notice">
              {titles.length} song{titles.length === 1 ? '' : 's'}: {titles.slice(0, 6).join(', ')}
              {titles.length > 6 ? '…' : ''}
            </div>

            <div className="field stacked">
              <label>
                What to work on
                <span className="hint">
                  The whole set, or the songs you tick. Every function below acts on this.
                </span>
              </label>
              <div className="picker-bar">
                <button className="btn" disabled={!!progress} onClick={() => setChosen(new Set(titles))}>
                  Whole set
                </button>
                <button className="btn" disabled={!!progress} onClick={() => setChosen(new Set())}>
                  Clear
                </button>
                {pickFilter.trim() && shownTitles.length > 0 && (
                  <>
                    <button
                      className="btn"
                      disabled={!!progress}
                      onClick={() => setChosen(new Set([...selected, ...shownTitles]))}
                      title="Tick every song the filter shows"
                    >
                      Tick shown
                    </button>
                    <button
                      className="btn"
                      disabled={!!progress}
                      onClick={() => setChosen(new Set([...selected].filter((t) => !shownTitles.includes(t))))}
                      title="Untick every song the filter shows"
                    >
                      Untick shown
                    </button>
                  </>
                )}
                <span className="picker-count">
                  {wholeSet ? `all ${titles.length} songs` : `${selected.size} of ${titles.length}`}
                </span>
                <input
                  className="text-input"
                  type="search"
                  value={pickFilter}
                  onChange={(e) => setPickFilter(e.target.value)}
                  placeholder="Find a song…"
                  aria-label="Find a song"
                  disabled={!!progress}
                />
                <SortBar sort={pickSort} onChange={setPickSort} />
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
                {shownTitles.map((title) => {
                  const sg = project.songs.find((x) => x.title === title);
                  return (
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
                      {sg && (
                        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 'auto' }}>
                          {[sg.key, sg.bpm ?? sg.startBpm ? `${Math.round((sg.bpm ?? sg.startBpm) * 10) / 10} BPM` : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </label>
                  );
                })}
                {shownTitles.length === 0 && (
                  <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>No song matches.</div>
                )}
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
              ['info', 'Song info'],
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
                      Lyrics Studio isn't running — open the Lyrics Studio app, or double-click{' '}
                      <span className="code">Start Lyrics Studio.command</span> first.
                    </div>
                  )}
                  <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                    Save and close the set in Live first. Lyrics Studio never touches the set itself:
                    it writes a copy beside it, named “… Lyrics.als”, for you to open in Live.
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

              {tool === 'info' && (
                <>
                  <div className="field stacked">
                    <label>
                      What each clip says
                      <span className="hint">
                        One MIDI clip at the top of each song, on a track of its own, named with these facts,
                        for reading on the timeline in Live.
                      </span>
                    </label>
                    <div className="controls flush" style={{ gap: 12 }}>
                      {(Object.keys(INFO_FIELD_LABEL) as (keyof InfoFields)[]).map((key) => (
                        <label key={key} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={infoFields[key]}
                            disabled={!!progress}
                            onChange={(e) => setInfoField(key, e.target.checked)}
                          />
                          <span style={{ fontSize: 14 }}>{INFO_FIELD_LABEL[key]}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="controls flush" style={{ alignItems: 'center' }}>
                    <span className="control-label">Track</span>
                    <input
                      className="text-input"
                      value={infoTrack}
                      onChange={(e) => {
                        setInfoTrack(e.target.value);
                        try {
                          localStorage.setItem(LS_INFO_TRACK, e.target.value);
                        } catch {
                          /* not remembered, then */
                        }
                      }}
                      placeholder={DEFAULT_INFO_TRACK}
                      aria-label="Track name for the song info clips"
                      disabled={!!progress}
                    />
                    <span className="control-note">
                      {abletReads(infoTrack.trim() || DEFAULT_INFO_TRACK)
                        ? 'AbleSet shows this track as lyrics; the clip is written in its markup'
                        : 'plain text, read in Live; add +LYRICS to the name for AbleSet to show it'}
                    </span>
                  </div>
                  <div className="controls flush" style={{ alignItems: 'center' }}>
                    <span className="control-label">Clip</span>
                    <div className="segmented" role="radiogroup" aria-label="How long each clip runs">
                      {([
                        [true, 'Whole song'],
                        [false, 'First bar only'],
                      ] as const).map(([whole, label]) => (
                        <button
                          key={label}
                          role="radio"
                          aria-checked={infoWholeSong === whole}
                          className={infoWholeSong === whole ? 'seg on' : 'seg'}
                          disabled={!!progress}
                          onClick={() => {
                            setInfoWholeSong(whole);
                            try {
                              localStorage.setItem(LS_INFO_SPAN, whole ? 'song' : 'bar');
                            } catch {
                              /* not remembered, then */
                            }
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <span className="control-note">
                      {infoWholeSong ? 'on screen for the whole song' : 'shown as the song starts, then gone'}
                    </span>
                  </div>
                  {(() => {
                    const first = project.songs.find((sg) => selected.has(sg.title));
                    const lines = first
                      ? infoLinesFor(first, project, infoFields, keyFor[first.title], abletReads(infoTrack.trim() || DEFAULT_INFO_TRACK))
                      : [];
                    return first && lines.length ? (
                      <div className="notice" style={{ whiteSpace: 'pre-line' }}>
                        {`For ${first.title}, the clip would be named:\n${lines.join(abletReads(infoTrack.trim() || DEFAULT_INFO_TRACK) ? '\n' : ' · ')}`}
                      </div>
                    ) : null;
                  })()}
                  <div className="btn-row">
                    <button className="btn primary" disabled={!!progress || selected.size === 0} onClick={() => void addInfo()}>
                      {wholeSet ? 'Write song info, whole set' : `Write song info, ${selected.size} song${selected.size === 1 ? '' : 's'}`}
                    </button>
                  </div>
                  <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                    Writes a copy of the set named “… (info).als” with the new track; the original is
                    never touched. Run it again after a change and the copy is rewritten.
                  </div>
                </>
              )}

              {tool === 'check' && <CheckSetPanel project={project} selected={selected} setPath={lone ? null : setPath} />}

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
                    Patch changes as MIDI clips, in a copy of the set: one “ADD THIS RIG …” track per band
                    member from the rig files the website writes under the prepared set’s rigs/ folder, and
                    one for what was programmed in the player here. Drag the tracks into the set in Live;
                    the next prepare reads them back as the set’s own.
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
