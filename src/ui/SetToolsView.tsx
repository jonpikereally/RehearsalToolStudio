import { useEffect, useRef, useState } from 'react';
import { keepOnlyAdded } from '../lib/alsEdit';
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
import { addChordTrack, chordClipsFor, chordNotationsIn } from '../lib/chordTrack';
import { abletReads, DEFAULT_INFO_FIELDS, DEFAULT_INFO_TRACK, INFO_FIELD_LABEL, infoClipsFor, infoLinesFor, type InfoFields } from '../lib/infoTrack';
import { keyRank, type SortSpec } from '../lib/songSort';
import { addThis } from '../lib/alsEdit';
import { runningOrderTitles } from '../lib/ableset';
import SortBar, { useSort } from './SortBar';
import { NOTATION_LABEL, parseKey, type ChordNotation } from '../lib/nashville';
import { setlistText } from '../lib/setReview';
import { ensureLyricsStudio, findLyricsStudio, isFolderRefusal, restartLyricsStudio, transcribeTrack } from '../lib/lyricsStudio';
import { FINENESS_LABEL, lyricClipsFrom, type LyricFineness } from '../lib/lyricClips';


import SlatesPanel from './SlatesPanel';
import UpdatePreparedPanel from './UpdatePreparedPanel';
import CheckSetPanel from './CheckSetPanel';
import { useStore } from '../lib/store';
import { addRigTracks, type RigTrackSpec } from '../lib/rigTrack';
import { parseMemberRig, rigTrackSpecFor, studioChanges, RIG_FILES_FOLDER } from '../lib/rigFiles';
import { locatePrepared } from '../lib/locatePrepared';
import { remember } from '../lib/remember';

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
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const { library, currentSet, setSaved, publishFolder, pickPublishFolder } = useStore();
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
        remember(LS_INFO, next);
      } catch {
        /* not remembered, then */
      }
      return next;
    });
  /* The song picker: sorted, and narrowed by a few typed letters. */
  const [pickSort, setPickSort] = useSort('ls.sort.settools');
  const [pickFilter, setPickFilter] = useState('');
  /** The picker itself, shown only while songs are being chosen: a line otherwise. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [askKeys, setAskKeys] = useState<string[] | null>(null);
  const [keyFor, setKeyFor] = useState<Record<string, string>>({});
  /**
   * Which chord notations to write; remembered. More than one is allowed and
   * makes a track apiece in the one copy — a band that reads numbers and a
   * player who reads names want the same set, and dragging two tracks across
   * once beats preparing the same copy twice.
   */
  const [chordTargets, setChordTargets] = useState<ChordNotation[]>(() => {
    const saved = (localStorage.getItem('ls.settools.chordTargets') ?? localStorage.getItem('ls.settools.chordTarget') ?? '')
      .split(',')
      .filter((k): k is ChordNotation => k === 'names' || k === 'numbers' || k === 'roman');
    return saved.length ? saved : ['numbers'];
  });
  const toggleChordTarget = (kind: ChordNotation) => {
    // Never none: the button would have nothing to write.
    const next = chordTargets.includes(kind)
      ? chordTargets.filter((k) => k !== kind)
      : [...chordTargets, kind];
    const kept = next.length ? next : [kind];
    setChordTargets(kept);
    remember('ls.settools.chordTargets', kept.join(','));
  };
  const [progress, setProgress] = useState<string | null>(null);
  /* The lyrics tab: which song, which of its tracks, and how finely to cut the words. */
  const [lyricSong, setLyricSong] = useState('');
  const [lyricTrack, setLyricTrack] = useState('');
  const [lyricFineness, setLyricFineness] = useState<LyricFineness>(
    () => (localStorage.getItem('ls.settools.lyricFineness') as LyricFineness) || 'line',
  );
  const [lyricIsolate, setLyricIsolate] = useState(false);
  const [lyricKnown, setLyricKnown] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  /** When the set file was last written, as of the parse in hand. */
  const readAt = useRef<number | null>(null);

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
   * The set is the one chosen on opening; every tool here works on it, and it
   * is read afresh whenever that choice changes.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const stored = await local.storedFolder('songs');
      if (!live) return;
      setFolder(stored);
      setChosen(null);
      if (stored && currentSet) await openSet(stored, currentSet);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSet]);

  /** Where results are written, and what to call them. */
  const destination = async (): Promise<{
    dir: local.FolderHandle;
    prefix: string;
    base: string;
  }> => {
    const path = setPath!;
    const at = path.lastIndexOf('/');
    return {
      dir: folder!.handle,
      prefix: at < 0 ? '' : `${path.slice(0, at)}/`,
      base: path.slice(at + 1),
    };
  };

  /** The set's bytes, read from the session's own folder. */
  const setBytes = async (): Promise<ArrayBuffer> => (await local.readBytes(folder!.handle, '', setPath!)).bytes;

  const openSet = async (from: local.LocalFolder, path: string) => {
    setError(null);
    setDone(null);
    setSetPath(path);
    setProject(null);
    try {
      const { bytes } = await local.readBytes(from.handle, '', path);
      setProject(await parseAls(bytes));
      readAt.current = await modifiedAt(from, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const modifiedAt = async (from: local.LocalFolder, path: string): Promise<number | null> => {
    try {
      return (await local.statFile(from.handle, '', path)).modified;
    } catch {
      return null;
    }
  };

  /*
   * The set as it is now, not as it was when this tab was opened.
   *
   * Every tool here reads the set: which songs have chords, what key each is
   * in, what the info clips say. Somebody adds a key in Live, saves, comes
   * back — and was told the song still has no key, because the parse was an
   * hour old. So it is read again whenever Live saves it and whenever the
   * window comes back to the front, and only when the file has actually
   * moved: a stat is nothing, a parse of a big set is not.
   */
  const freshen = async () => {
    if (!folder || !setPath || progress) return;
    const at = await modifiedAt(folder, setPath);
    if (at === null || at === readAt.current) return;
    try {
      const { bytes } = await local.readBytes(folder.handle, '', setPath);
      const read = await parseAls(bytes);
      readAt.current = at;
      setProject(read);
      // Keys typed in for songs the set didn't name are the set's now, if it
      // names them; anything still missing stays as it was typed.
      const named = new Set(read.songs.filter((sg) => sg.key).map((sg) => sg.title));
      setKeyFor((was) => {
        const kept = { ...was };
        for (const title of named) delete kept[title];
        return kept;
      });
      // A song the set now names a key for is no longer being asked about;
      // with none left to ask, the prompt goes.
      setAskKeys((was) => {
        if (!was) return was;
        const left = was.filter((title) => !named.has(title));
        return left.length ? left : null;
      });
    } catch {
      /* the parse in hand is still the best there is */
    }
  };

  useEffect(() => {
    void freshen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSaved?.at, folder, setPath, progress]);

  useEffect(() => {
    const back = () => void freshen();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, setPath, progress]);

  const chooseVoice = (name: string) => {
    setVoice(name);
    try {
      remember(LS_VOICE, name);
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
    const running = setPath ? runningOrderTitles(library, setPath) : null;
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
    if (!project || !setPath) return;
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
      // Only the new track goes into the copy, on the set's own timeline.
      const only = keepOnlyAdded(result.xml, result.reusedTrack ? [result.trackName] : []);
      const gz = new Blob([only.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (slates).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());
      setDone(
        `${slates.length} slates in ${prefix}Slates, and ${result.clipsWritten} clip` +
          `${result.clipsWritten === 1 ? '' : 's'} ${
            result.reusedTrack
              ? `on the set's own “${result.trackName}” track`
              : 'on a new Slates track'
          } in ${copyPath.split('/').pop()} — a copy holding only that track, on the set's own timeline and locators. ` +
          'Open it beside the set and drag the track across. The original is untouched.',
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
    if (!project || !setPath) return;
    setError(null);
    setDone(null);
    try {
      /*
       * One conversion per kind asked for, and one track apiece in the same
       * copy: the set is read once, the copy is written once, and a band that
       * reads numbers while somebody else reads names drags two tracks over
       * together.
       */
      const asked = chordTargets.map((kind) => ({ kind, ...chordClipsFor(project, keyFor, [...selected], kind) }));

      /*
       * A song whose locator never named a key can still be converted — the
       * key just has to come from somewhere, and the person looking at the set
       * knows it. Asked for once, rather than the song being dropped quietly.
       */
      const withoutKey = [...new Set(asked.flatMap((a) => a.withoutKey))];
      if (withoutKey.length && !force) {
        setAskKeys(withoutKey);
        return;
      }
      const writing = asked.filter((a) => a.clips.length);
      if (!writing.length) {
        const had = [...new Set(asked.flatMap((a) => a.alreadyHad))];
        setError(
          had.length
            ? `Nothing to write — ${had.length === 1 ? 'the song' : `all ${had.length} songs`} with chords already ${had.length === 1 ? 'has' : 'have'} ` +
              `${chordTargets.map((k) => NOTATION_LABEL[k].toLowerCase()).join(' and ')}.`
            : 'Nothing to convert — these songs have no chord track.',
        );
        return;
      }
      setAskKeys(null);
      setProgress('Working out the chords…');

      const { dir, prefix, base } = await destination();
      let xml = await inflateAls(await setBytes());
      const wrote: { trackName: string; clipsWritten: number; songs: number }[] = [];
      for (const one of writing) {
        const result = addChordTrack(xml, one.clips, one.trackName, project);
        xml = result.xml;
        wrote.push({ trackName: result.trackName, clipsWritten: result.clipsWritten, songs: one.converted.length });
      }
      const only = keepOnlyAdded(xml, wrote.map((w) => w.trackName));
      const gz = new Blob([only.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (chords).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());

      const songs = Math.max(...wrote.map((w) => w.songs));
      setDone(
        `${wrote.map((w) => `${w.clipsWritten} chords on “${w.trackName}”`).join(', ')} across ${songs} song` +
          `${songs === 1 ? '' : 's'} in ${copyPath.split('/').pop()} — a copy holding only ` +
          `${wrote.length === 1 ? 'that track' : `those ${wrote.length} tracks`}, ` +
          `on the set's own timeline and locators. Open it beside the set and drag ` +
          `${wrote.length === 1 ? 'the track' : 'them'} across. The original is untouched.` +
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
    if (!project || !setPath) return;
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
      const only = keepOnlyAdded(result.xml, [result.trackName]);
      const gz = new Blob([only.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (info).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());
      setDone(
        `${result.clipsWritten} song info clip${result.clipsWritten === 1 ? '' : 's'} on a “${result.trackName}” track, ` +
          `${songs.length} song${songs.length === 1 ? '' : 's'}, in ${copyPath.split('/').pop()} — a copy holding only that track, ` +
          "on the set's own timeline and locators. Open it beside the set and drag the track across. The original is untouched." +
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
      const only = keepOnlyAdded(result.xml, result.tracks.map((t) => t.name));
      const gz = new Blob([only.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const { dir, prefix, base } = await destination();
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (rig).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());
      const dropped = result.tracks.reduce((n, t) => n + t.dropped, 0);
      setDone(
        `${result.tracks.map((t) => `${t.clips} clip${t.clips === 1 ? '' : 's'} on “${t.name}”`).join(', ')} in ${copyPath.split('/').pop()} — ` +
          "a copy holding only those tracks, on the set's own timeline and locators. Open it beside the set and drag them across. The original is untouched." +
          (dropped ? ` ${dropped} CC${dropped === 1 ? '' : 's'} had no envelope target on the model track and were left out.` : '') +
          (notes.length ? ` ${notes.join('. ')}.` : ''),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  /*
   * The lyrics tab's choices, made good: the song is the one chosen, else
   * the first being worked on; the track is the one chosen, else the
   * record's own vocal when the song has one, else any vocal, else the
   * first — a name is all there is to go on, and "REF VOX" is the surest.
   */
  const lyricSongObj =
    project?.songs.find((s) => s.title === lyricSong) ??
    project?.songs.find((s) => selected.has(s.title)) ??
    project?.songs[0] ??
    null;
  // Only tracks that are in the set: the click and cues the studio adds have no audio to listen to.
  const stemsOf = (lyricSongObj?.stems ?? []).filter((st) => st.trackId);
  const vocalish = (name: string) => /\b(vox|vocal|vocals|voice|lead|sing|singer|melody)\b/i.test(name);
  const lyricStem =
    stemsOf.find((st) => st.name === lyricTrack) ??
    stemsOf.find((st) => st.reference && vocalish(st.name)) ??
    stemsOf.find((st) => vocalish(st.name)) ??
    stemsOf[0] ??
    null;

  /**
   * Words for one song, from one of its tracks, into a copy of the set.
   *
   * Lyrics Studio does the listening — started here when it is not up — on
   * the set file itself, so warping and the tempo map are its own; what
   * comes back is placed on the set's ruler as clips on a +LYRICS track,
   * and the copy holds that track alone.
   */
  const transcribeLyrics = async () => {
    if (!project || !setPath || !folder || !lyricSongObj || !lyricStem?.trackId) return;
    setError(null);
    setDone(null);
    try {
      setProgress('Finding Lyrics Studio…');
      let url = await ensureLyricsStudio((note) => setProgress(note));
      setLyricsUrl(url);
      const alsPath = await local.absolutePath(folder.handle, '', setPath);
      const where = `“${lyricStem.name}” of ${lyricSongObj.title}`;
      const listen = () =>
        transcribeTrack(
          url,
          {
            alsPath,
            trackId: lyricStem.trackId!,
            startBar: lyricSongObj.startBar,
            endBar: lyricSongObj.endBar,
            isolate: lyricIsolate,
            lyrics: lyricKnown,
          },
          (done, total, phase) => setProgress(`Transcribing ${where} — ${phase}, region ${Math.min(done + 1, total)} of ${total}…`),
        );
      setProgress(`Transcribing ${where}… (listening on this Mac; a minute or so per region)`);
      let heard;
      try {
        heard = await listen();
      } catch (err) {
        /*
         * macOS grants a folder per app. A Lyrics Studio started from a
         * Terminal, or by an app without leave to read Downloads, cannot read
         * a set this studio can — so it is started again from here, as the
         * studio's own child, and asked once more.
         */
        if (!isFolderRefusal(err)) throw err;
        url = await restartLyricsStudio(url, (note) => setProgress(note));
        setLyricsUrl(url);
        setProgress(`Transcribing ${where}… (listening on this Mac; a minute or so per region)`);
        heard = await listen();
      }
      const clips = lyricClipsFrom(heard.segments, project, lyricFineness);
      if (!clips.length) throw new Error('Nothing came back to write: no words were heard on that track inside the song.');
      setProgress('Writing the set…');
      const { dir, prefix, base } = await destination();
      const result = addChordTrack(await inflateAls(await setBytes()), clips, 'LYRICS +LYRICS', project);
      const only = keepOnlyAdded(result.xml, [result.trackName]);
      const gz = new Blob([only.xml]).stream().pipeThrough(new CompressionStream('gzip'));
      const copyPath = `${prefix}${base.replace(/\.als$/i, '')} (lyrics).als`;
      await local.writeFile(dir, '', copyPath, await new Response(gz).blob());
      setDone(
        `${clips.length} lyric clip${clips.length === 1 ? '' : 's'} heard on ${where}, on “${result.trackName}” in ${copyPath.split('/').pop()} — ` +
          "a copy holding only that track, on the set's own timeline and locators. Open it beside the set and drag the track across. The original is untouched." +
          (heard.regions.missing ? ` ${heard.regions.missing} region${heard.regions.missing === 1 ? '' : 's'} of the track could not be read.` : ''),
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
    <>
      {/*
        The head says what these tools are pointed at: the session, and the
        songs of it they will act on. What they act on is a choice, and the
        commonest one to change, so it sits in the head beside the set rather
        than in a panel of its own below it.
      */}
      <div className="topbar tools-head">
        <h1>
          Set tools
          <span className="sub" style={{ display: 'block' }}>
            {currentSet
              ? `${currentSet.split('/').pop()}${project ? ` · ${titles.length} song${titles.length === 1 ? '' : 's'}` : ''}`
              : 'No set chosen — Slates and Lyrics work without one; the rest need a set'}
          </span>
        </h1>
        {project && (
          <div className={pickerOpen ? 'working on' : 'working'}>
            <span className="working-label">Working on</span>
            <strong>
              {wholeSet
                ? `all ${titles.length} songs`
                : selected.size === 0
                  ? 'no songs'
                  : `${selected.size} of ${titles.length} songs`}
            </strong>
            {!wholeSet && selected.size > 0 && (
              <span className="picker-names">
                {titles.filter((t) => selected.has(t)).slice(0, 4).join(', ')}
                {selected.size > 4 ? '…' : ''}
              </span>
            )}
            <button
              className={pickerOpen ? 'btn primary' : 'btn'}
              onClick={() => setPickerOpen((o) => !o)}
              aria-expanded={pickerOpen}
              disabled={!!progress}
            >
              {pickerOpen ? 'Done' : 'Choose songs'}
            </button>
          </div>
        )}
      </div>

      <div style={{ padding: '12px 16px 16px' }}>
        {!project && tool !== 'slates' && tool !== 'lyrics' && (
          <div className="notice quiet">
            Choose a set from the Songs tab — this tool works on one. Slates and Lyrics work without.
          </div>
        )}

        {project && (
          <>
            {pickerOpen && (
              <div className="picker-body">
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
            )}
          </>
        )}

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

        <div id="settool-panel" className="tool-panel" role="tabpanel" aria-labelledby={`settool-${tool}`}>
          {project && (
            <>
              {tool === 'update' && (
                <UpdatePreparedPanel
                  project={project}
                  alsPath={setPath}
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
                  <div className="controls flush" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <span className="control-label">Song</span>
                    <select
                      className="jump-select"
                      value={lyricSongObj?.title ?? ''}
                      disabled={!!progress}
                      onChange={(e) => {
                        setLyricSong(e.target.value);
                        setLyricTrack('');
                      }}
                      style={{ maxWidth: 320 }}
                    >
                      {titles.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <span className="control-label">Track</span>
                    <select
                      className="jump-select"
                      value={lyricStem?.name ?? ''}
                      disabled={!!progress || !stemsOf.length}
                      onChange={(e) => setLyricTrack(e.target.value)}
                      style={{ maxWidth: 320 }}
                    >
                      {stemsOf.map((st) => (
                        <option key={st.name} value={st.name}>
                          {st.name}
                          {st.reference ? ' · the record' : ''}
                        </option>
                      ))}
                      {!stemsOf.length && <option value="">no audio tracks in this song</option>}
                    </select>
                  </div>
                  <div className="controls flush" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {(['line', 'section', 'word'] as LyricFineness[]).map((f) => (
                      <button
                        key={f}
                        className={lyricFineness === f ? 'chip on' : 'chip'}
                        aria-pressed={lyricFineness === f}
                        disabled={!!progress}
                        onClick={() => {
                          setLyricFineness(f);
                          remember('ls.settools.lyricFineness', f);
                        }}
                      >
                        {FINENESS_LABEL[f]}
                      </button>
                    ))}
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', marginLeft: 8 }}>
                      <input type="checkbox" checked={lyricIsolate} disabled={!!progress} onChange={(e) => setLyricIsolate(e.target.checked)} />
                      <span style={{ fontSize: 14 }}>Isolate the voice first</span>
                    </label>
                  </div>
                  <div className="field stacked">
                    <label htmlFor="lyric-known">
                      Known words
                      <span className="hint">
                        Optional. The lyrics as you know them, pasted in: the listening is steered by them and the
                        lines aligned to them, which beats a guess at every mumbled word.
                      </span>
                    </label>
                    <textarea
                      id="lyric-known"
                      className="text-input"
                      rows={3}
                      value={lyricKnown}
                      disabled={!!progress}
                      onChange={(e) => setLyricKnown(e.target.value)}
                      placeholder="Paste the lyrics here, or leave it empty"
                      style={{ width: '100%', resize: 'vertical' }}
                    />
                  </div>
                  <div className="btn-row">
                    <button className="btn primary" disabled={!!progress || !lyricStem || !lyricSongObj} onClick={() => void transcribeLyrics()}>
                      {lyricStem && lyricSongObj
                        ? `Transcribe “${lyricStem.name}” of ${lyricSongObj.title} and write lyric clips`
                        : 'Choose a song with audio tracks'}
                    </button>
                    <button className="btn" disabled={!!progress} onClick={() => void sendToLyricsStudio()} title="The standalone Lyrics Studio page, for its own workflow">
                      Open Lyrics Studio instead
                    </button>
                  </div>
                  <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                    Listens to that track inside the song, on this Mac, and writes the words as timed clips on an
                    “ADD THIS LYRICS +LYRICS” track in a copy of the set named “… (lyrics).als” — the copy holds only
                    that track. Lyrics Studio is started here if it is not running
                    {lyricsUp ? ' (it is running now)' : ''}. Save the set in Live first, so it is read as it stands.
                  </div>
                </>
              )}

              {tool === 'chords' && (
                <>
                  <div className="field stacked">
                    <label>
                      Chords to write
                      <span className="hint">
                        Converted from whichever chords the set has, each song in its own key. Tick as many
                        kinds as you want: each becomes a track of its own in the one copy. A song that
                        already has a chosen kind is left out of that kind's track.
                      </span>
                    </label>
                    <div className="controls flush" style={{ gap: 8 }}>
                      {(() => {
                        const seen = project ? chordNotationsIn(project, [...selected]) : { withChords: 0, have: { names: 0, numbers: 0, roman: 0 }, mixed: 0 };
                        return (['names', 'numbers', 'roman'] as ChordNotation[]).map((kind) => {
                          const has = seen.have[kind];
                          const note =
                            !seen.withChords ? '' : has === seen.withChords ? ' · in the set' : has ? ` · in ${has} of ${seen.withChords}` : '';
                          return (
                            <button
                              key={kind}
                              className={chordTargets.includes(kind) ? 'chip on' : 'chip'}
                              aria-pressed={chordTargets.includes(kind)}
                              disabled={!!progress}
                              onClick={() => toggleChordTarget(kind)}
                              title={has === seen.withChords && seen.withChords ? 'Every chosen song with chords has these already' : undefined}
                            >
                              {NOTATION_LABEL[kind]}
                              {note && <span style={{ opacity: 0.6 }}>{note}</span>}
                            </button>
                          );
                        });
                      })()}
                    </div>
                  </div>
                  <div className="btn-row">
                    <button className="btn primary" disabled={!!progress} onClick={() => void addChords()}>
                      {`Write ${chordTargets.map((k) => NOTATION_LABEL[k].toLowerCase()).join(' and ')}, ${
                        wholeSet ? 'whole set' : `${selected.size} song${selected.size === 1 ? '' : 's'}`
                      }`}
                    </button>
                  </div>
                  <div style={{ color: '#6b7789', fontSize: 12.5 }}>
                    Classical names say what to play; Nashville numbers and Roman numerals say what a chord does,
                    and survive a change of key. Each chord is read for what it is, so a track that mixes kinds — or
                    a set whose songs are written differently — comes out as one kind.
                    {project && chordNotationsIn(project, [...selected]).mixed > 0
                      ? ` ${chordNotationsIn(project, [...selected]).mixed} of the chosen songs mix kinds on one track.`
                      : ''}{' '}
                    Written as a +LYRICS track per kind, in one copy of the set.
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
                          remember(LS_INFO_TRACK, e.target.value);
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
                              remember(LS_INFO_SPAN, whole ? 'song' : 'bar');
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

              {tool === 'check' && <CheckSetPanel project={project} selected={selected} setPath={setPath} />}

              {tool === 'setlist' && <SetlistPanel project={project} selected={selected} />}

              {tool === 'patches' && (
                <>
                  <div className="btn-row">
                    <button
                      className="btn primary"
                      disabled={!!progress}
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
        </div>
      </div>
    </>
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
