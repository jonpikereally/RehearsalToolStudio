import { useEffect, useRef, useState } from 'react';
import type { Song } from '../types';
import { useStore } from '../lib/store';
import { getShiftedBuffer, primeShiftedRender, shiftLanes } from '../lib/pitchService';
import { holdAwake } from '../lib/keepAwake';
import { useLiveOrder } from '../lib/useLiveOrder';
import { parseAls, type AlsProject, type AlsSong } from '../lib/alsParser';
import { describeParts, overallProgress, partFileName, partsFor, prepareSet, songFolderName, soundsInSong, submixPartsFor, type PrepareProgress, type PrepareResult, type SongPlan } from '../lib/prepare';
import type { MemberMix } from '../lib/members';
import { readBytes } from '../lib/source';
import { clearDecodedCache, releaseReady } from '../lib/songLoader';
import * as local from '../lib/localSource';
import { publishLibrary, type PublishResult } from '../lib/publish';
import { MANIFEST_NAME, type PreparedManifest } from '../lib/preparedSet';
import { SETS_FOLDER } from '../lib/prints';
import { resolveStemPath } from '../lib/alsImport';
import { setNameFor } from '../lib/setName';
import { songKey } from '../lib/alsParser';
import { locatePrepared } from '../lib/locatePrepared';
import { updatePrepared, type UpdateResult } from '../lib/updatePrepared';
import { audioKeysFor, bandMembers, removeSilentParts } from '../lib/prepareRun';

/**
 * One song, prepared for the band.
 *
 * The set's tracks for this song, each printed on its own, folded into one
 * "band" part with the others, or left out; rendered as the arrangement has
 * them, encoded small, and written into the band's folder under a name their
 * app reads without help — tempo and key in the folder, the part in
 * brackets — with the manifest and the library updated beside it.
 *
 * Every track is printed unless somebody says otherwise, which is what a
 * whole set does: a song prepared on its own and the same song prepared with
 * its set should come out the same.
 */

type Choice = 'print' | 'combine' | 'skip';

/**
 * The three jobs the buttons offer, the same three a whole set gets: render
 * the song (its parts and its submixes), write only the submixes from the
 * audio already there, or write only the words and sections beside it. A
 * song is behind in one way at a time as much as a set is.
 */
type Job = 'stems' | 'submixes' | 'info';

const JOBS: readonly [Job, string, string][] = [
  ['stems', 'Prepare stems', 'Render the song — its parts and its submixes. The slow one; writes the folder over.'],
  ['submixes', 'Prepare submixes', "Each member's submix, from the audio already in the folder. The stems are not touched."],
  ['info', 'Prepare info', 'The words and sections beside the audio: sections, chords, lyrics, patch changes. Nothing is rendered.'],
];

const CONFIRM_TITLE: Record<Job, string> = {
  stems: 'Render the stems?',
  submixes: 'Write the submixes?',
  info: 'Write the words and sections?',
};

const PrepareBar = ({ progress }: { progress: PrepareProgress }) => {
  const pct = Math.round(overallProgress(progress) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      aria-label="Preparing">
      <div className="progress-fill" style={{ width: `${pct}%` }} />
      <span className="progress-text">{pct}%</span>
    </div>
  );
};

export default function PrepareSongDialog({ song, onClose }: { song: Song; onClose: () => void }) {
  const { publishFolderName, pickPublishFolder, publishFolder, settings, outputSet } = useStore();
  const [project, setProject] = useState<AlsProject | null>(null);
  const liveOrder = useLiveOrder(project, song.setPath ?? null);
  const [alsSong, setAlsSong] = useState<AlsSong | null>(null);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [combinedName, setCombinedName] = useState('band');
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [result, setResult] = useState<PrepareResult | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState<UpdateResult | null>(null);
  /** The band, when its folder is already granted, so the submixes can be named before they are made. */
  const [members, setMembers] = useState<MemberMix[]>([]);
  /** The job a press has asked for and is waiting to be agreed to: the work starts on the second press. */
  const [confirming, setConfirming] = useState<Job | null>(null);
  /** The job that is running, for the button that says so. */
  const [job, setJob] = useState<Job | null>(null);
  /*
   * A run in progress, so it can be stopped. Preparing reads whole WAVs and
   * encodes them, which is minutes on a long song — and a dialog that offers
   * no way out of minutes is a dialog you reload the window to escape.
   */
  const running = useRef<AbortController | null>(null);

  // The set, read afresh: the tracks are its, not the library's.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (!song.setPath) throw new Error('This song did not come from an Ableton set.');
        const { bytes } = await readBytes(song.setPath);
        const parsed = await parseAls(bytes);
        const mine = parsed.songs.find((s) => songKey(s.title) === songKey(song.title));
        if (!mine) throw new Error(`“${song.title}” is not in the set any more.`);
        if (!live) return;
        setProject(parsed);
        setAlsSong(mine);
        /*
         * Every track printed, the record's reference tracks included.
         *
         * The references used to be left out here, where a whole set has
         * always printed them — so the same song came out with different
         * parts depending on which button was pressed, and a song prepared
         * on its own quietly lost the reference the band plays against.
         * Nothing is skipped unless somebody says to skip it.
         */
        const initial: Record<string, Choice> = {};
        for (const stem of mine.stems.filter(soundsInSong)) initial[stem.name] = 'print';
        setChoice(initial);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [song.setPath, song.title]);

  // The band, read from its folder when that is already granted; asked for otherwise on the press.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const folder = await publishFolder();
        if (!folder) return;
        const band = (await bandMembers(folder)).filter((m) => !m.off);
        if (live) setMembers(band);
      } catch {
        /* nobody in the band yet, or no folder: no submixes to name */
      }
    })();
    return () => {
      live = false;
    };
  }, [publishFolder]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  // Only the tracks that make a sound in this song: the rest cannot be
  // printed, and offering a choice over them is offering nothing.
  const stems = (alsSong?.stems ?? []).filter(soundsInSong);
  const printing = stems.filter((s) => choice[s.name] === 'print');
  const combining = stems.filter((s) => choice[s.name] === 'combine');
  const partCount = printing.length + (combining.length ? 1 : 0);
  const plan: SongPlan = {
    print: printing.map((s) => s.name),
    combine: combining.length ? [{ name: combinedName || 'band', stems: combining.map((s) => s.name) }] : [],
  };
  // The submixes the band's lists ask for, from the parts as chosen above.
  const submixNames = alsSong ? submixPartsFor(alsSong, partsFor(alsSong, plan), members).map((p) => p.name) : [];
  // The folder the rest of the set went into, if it was ever named; else today's.
  const setName = outputSet?.name ?? setNameFor(song.setPath ?? null);
  const folderName = alsSong ? songFolderName(alsSong) : '';

  const stop = () => running.current?.abort();

  /** What came of taking the silent parts away, once that has been asked for. */
  const [silentGone, setSilentGone] = useState<string | null>(null);

  /**
   * Take the silent parts away, having been asked to. Offered rather than
   * done: an empty part is usually a track nobody meant to print, and
   * sometimes a stem whose file has gone quiet by mistake — worth seeing
   * before it is thrown away, and written again by the next prepare if it
   * has anything in it.
   */
  const dropSilent = async () => {
    if (!result?.silent.length) return;
    setBusy(true);
    setError(null);
    try {
      const folder = (await publishFolder()) ?? (await pickPublishFolder());
      const out = await removeSilentParts(folder, setName.replace(/[\\/:*?"<>|]/g, ''), result.silent);
      setSilentGone(
        `${out.removed} silent part${out.removed === 1 ? '' : 's'} removed. The band now sees ${out.published.songs} song${out.published.songs === 1 ? '' : 's'}.`,
      );
      setResult((was) => (was ? { ...was, silent: [] } : was));
    } catch (err) {
      setError(`The silent parts could not be removed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const go = async (kind: Job) => {
    if (!alsSong || !project || !song.setPath) return;
    if (kind === 'info') return updateWordsOnly();
    setJob(kind);
    running.current = new AbortController();
    // Minutes of work nobody is touching is what a Mac calls idle; held
    // awake, or the display sleeps, the app naps and the run crawls.
    const releaseAwake = holdAwake('Preparing a song');
    setBusy(true);
    setError(null);
    setResult(null);
    setPublished(null);
    try {
      /*
       * Let go of what is only being held for listening. The player keeps the
       * song it has open decoded, and a run keeps every song of it — up to the
       * budget in Settings — while preparing needs the machine's memory for
       * source WAVs, a rendered part and the encoder's copy of it. Nobody
       * rehearses through a prepare, and the alternative is the browser
       * quietly killing the encoder's worker mid-song.
       */
      releaseReady();
      clearDecodedCache();

      // Asked for inside the click, where a dialog is allowed to open.
      const folder = (await publishFolder()) ?? (await pickPublishFolder());
      const setPath = song.setPath;
      // What is about to be written over is kept aside, as a set-wide run keeps it.
      const setFolder = `${SETS_FOLDER}/${setName.replace(/[\\/:*?"<>|]/g, '')}`;
      await local.undoBegin(folder, setFolder);
      /*
       * The song's audio as a key, for its entry. A whole set has always
       * written one, and it is how the next save knows whether this song's
       * audio has changed since; a song prepared here went without, so it
       * read as "prepared before this could be told" for ever after — and a
       * cut made in it afterwards was one more thing the key couldn't say.
       */
      const keys = await audioKeysFor(project, setPath);
      const ctx = new AudioContext();
      const done = await prepareSet({
        songOrder: liveOrder?.titles,
        /*
         * The band, so this song comes out with its submixes like any other.
         * A whole set has always written them; a song on its own wrote none,
         * so the same song had different parts depending on which button was
         * pressed — and the folder then said it was behind on submixes it had
         * just been asked to make.
         */
        members: (await bandMembers(folder)).filter((m) => !m.off),
        // Only the submixes, into the folder the song already has, its stems untouched.
        submixesOnly: kind === 'submixes',
        beforeSong: async (name, previous) => {
          if (previous) await local.undoKeep(folder, setFolder, previous);
          await local.undoKeep(folder, setFolder, name);
        },
        project,
        alsPath: setPath,
        only: [alsSong.title],
        plan: { [alsSong.title]: plan },
        audioKeys: keys.byTitle,
        readManifest: async () => {
          const path = `${SETS_FOLDER}/${setName.replace(/[\\/:*?"<>|]/g, '')}/${MANIFEST_NAME}`;
          try {
            const { bytes: raw } = await local.readBytes(folder, '', path);
            return JSON.parse(new TextDecoder().decode(raw)) as PreparedManifest;
          } catch {
            return null;
          }
        },
        root: '',
        setName,
        resolvePath: (relative) => resolveStemPath(setPath, relative),
        readFile: async (path) => (await readBytes(path)).bytes,
        readSlice: async (path, start, end) => {
          const got = await readBytes(path, undefined, undefined, { start, end });
          return { bytes: got.bytes, size: got.size };
        },
        writeFile: (path, data) => local.writeFile(folder, '', path, data),
        decode: (raw) => ctx.decodeAudioData(raw.slice(0)),
        // What everything is rendered at, so the lead-in is measured there too.
        sampleRate: ctx.sampleRate,
        // Cached under the file it came from: a key without it once served
        // one stem's render for every stem of the song.
        shift: ({ buffer, semitones, speed, source, prime, onProgress }) =>
          (prime ? primeShiftedRender : getShiftedBuffer)({
            ctx,
            path: source,
            rev: `prepare:${buffer.length}@${buffer.sampleRate}`,
            semitones,
            tempo: speed,
            source: buffer,
            budgetBytes: settings.cacheBudgetGB * 1e9,
            onProgress,
            signal: running.current?.signal,
          }),
        parallelShifts: shiftLanes(),
        onProgress: setProgress,
        signal: running.current.signal,
      });
      void ctx.close();
      setResult(done);
      setPublished(await publishLibrary(folder));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as { name?: string })?.name === 'AbortError') setError('Stopped. Parts already written are on disk; running it again rewrites the song from the top.');
      else if (!/abort/i.test(message)) setError(message);
    } finally {
      releaseAwake();
      running.current = null;
      setBusy(false);
      setProgress(null);
      setJob(null);
    }
  };

  /**
   * The words and sections, without the audio.
   *
   * Everything the set says *about* this song — its sections, chords, lyric
   * lanes, key and patch changes — lives in `set.json` and the `.lrc`/`.cho`
   * beside the parts, not inside them. Fixing a lyric should not mean encoding
   * the stems again, and after a rehearsal where three section names changed
   * it is the difference between the band having them tonight and next week.
   */
  const updateWordsOnly = async () => {
    if (!project || !alsSong || !song.setPath) return;
    setJob('info');
    setBusy(true);
    setError(null);
    setUpdated(null);
    setPublished(null);
    try {
      const folder = (await publishFolder()) ?? (await pickPublishFolder());
      const found = await locatePrepared(folder, song.setPath);
      if ('error' in found) throw new Error(found.error);

      const done = await updatePrepared({
        songOrder: liveOrder?.titles,
        project,
        alsPath: song.setPath,
        setFolder: found.setFolder,
        manifest: found.manifest,
        presentFolders: found.presentFolders,
        only: [alsSong.title],
        writeFile: (path, data) => local.writeFile(folder, '', path, data),
      });
      setUpdated(done);
      // The library carries the words and sections too, so it follows.
      setPublished(await publishLibrary(folder));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    } finally {
      setBusy(false);
      setJob(null);
    }
  };

  const pick = (name: string, value: Choice) => setChoice((prev) => ({ ...prev, [name]: value }));

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Prepare this song for Rehearsal Tool"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Prepare {song.title} for Rehearsal Tool</h3>

        {!alsSong && !error && <p className="dialog-note">Reading the set…</p>}

        {alsSong && (
          <>
            <p className="dialog-note">
              Each track of the song as the set plays it, all of them printed unless you say
              otherwise. <strong>Print</strong> makes it a part of its own; <strong>Combine</strong>{' '}
              folds it into one part with the others marked the same; <strong>Skip</strong> leaves it
              out.
            </p>

            <div className="prepare-tracks">
              {stems.map((stem) => (
                <div className="prepare-track" key={stem.name}>
                  <span className="prepare-track-name">
                    {stem.name}
                    {stem.reference && <span className="badge">ref</span>}
                  </span>
                  <div className="segmented" role="radiogroup" aria-label={`What to do with ${stem.name}`}>
                    {(['print', 'combine', 'skip'] as const).map((value) => (
                      <button
                        key={value}
                        role="radio"
                        aria-checked={choice[stem.name] === value}
                        className={choice[stem.name] === value ? 'seg on' : 'seg'}
                        disabled={busy}
                        onClick={() => pick(stem.name, value)}
                      >
                        {value === 'print' ? 'Print' : value === 'combine' ? 'Combine' : 'Skip'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {combining.length > 0 && (
              <div className="controls flush">
                <span className="control-label">Combined part</span>
                <input
                  className="text-input"
                  value={combinedName}
                  onChange={(e) => setCombinedName(e.target.value)}
                  placeholder="band"
                  aria-label="Name for the combined part"
                  disabled={busy}
                />
                <span className="control-note">{combining.map((s) => s.name).join(' + ')}</span>
              </div>
            )}

            <p className="dialog-note">
              {partCount
                ? `${partCount} part${partCount === 1 ? '' : 's'} as small MP3s into `
                : 'Nothing chosen. '}
              {partCount > 0 && (
                <>
                  <span className="code">
                    {SETS_FOLDER}/{setName}/{folderName}/
                  </span>{' '}
                  in {publishFolderName ? `“${publishFolderName}”` : "the band's folder, asked for first"}
                  {' — '}
                  {printing.map((s) => partFileName(song.title, s.name, s.reference)).join(', ')}
                  {combining.length ? `${printing.length ? ', ' : ''}${partFileName(song.title, combinedName || 'band')}` : ''}.
                  {submixNames.length > 0 && (
                    <>
                      {' '}
                      And {submixNames.length === 1 ? 'one submix' : `${submixNames.length} submixes`} for the band, into{' '}
                      <span className="code">submixes/</span> — {submixNames.map((n) => `[${n}]`).join(', ')}.
                    </>
                  )}{' '}
                  The tempo, key and time signature are in the folder name, the part in the
                  brackets, and the words and sections go beside them — nothing there needs this
                  app to read.
                </>
              )}
            </p>
          </>
        )}

        {progress && (
          <>
            <PrepareBar progress={progress} />
            <div className="notice">
              {progress.stage === 'done'
                ? 'Finishing…'
                : `${progress.partName} — ${progress.stage}${
                    progress.stage === 'shifting' || progress.stage === 'encoding' ? ` ${Math.round(progress.ratio * 100)}%` : ''
                  }${progress.stage === 'shifting' ? '' : ` (part ${progress.partIndex} of ${progress.partCount})`}`}
            </div>
          </>
        )}
        {error && <div className="notice error">{error}</div>}
        {result && (
          <div className="notice done" role="status">
            <strong>Done — the song is prepared.</strong>
            <br />
            Wrote {describeParts(result)} to{' '}
            <span className="code">{result.folder}/{folderName}</span>.
            {result.samplerParts > 0 && (
            <>
              {' '}
              {result.samplerParts === 1 ? 'The pattern strikes' : 'The patterns strike'} {result.samplesShared} sample
              {result.samplesShared === 1 ? '' : 's'} in <span className="code">Resources/</span> — one kick for every
              song that fires it.
            </>
          )}
          {result.records.length > 0 && (
            <>
              {' '}
              The record itself is among the parts — [{result.records[0].part}] — and is tagged so the band's
              player switches to it rather than mixing it in.
            </>
          )}
          {result.skipped.length > 0 && (
              <>
                {' '}
                {result.skipped.length} skipped — {result.skipped[0].part}: {result.skipped[0].reason}
                {result.skipped.length > 1 ? `, and ${result.skipped.length - 1} more.` : '.'}
              </>
            )}
          </div>
        )}
        {/* Parts with nothing in them: named, and taken away only if asked. */}
        {result && result.silent.length > 0 && (
          <div className="notice" role="status">
            <strong>
              {result.silent.length} part{result.silent.length === 1 ? '' : 's'} came out silent.
            </strong>{' '}
            {result.silent
              .slice(0, 4)
              .map((p) => `${p.part}${p.peak > 0 ? ` (peaks at ${Math.round(20 * Math.log10(p.peak))} dB)` : ''}`)
              .join(', ')}
            {result.silent.length > 4 ? `, and ${result.silent.length - 4} more` : ''}. They are written, and the band
            would download files with nothing in them.
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button className="btn" disabled={busy} onClick={() => void dropSilent()}>
                Remove the silent part{result.silent.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        )}
        {silentGone && (
          <div className="notice done" role="status">
            {silentGone}
          </div>
        )}
        {published && (
          <div className="notice">
            The band's library now names it — {published.songs} song{published.songs === 1 ? '' : 's'} in{' '}
            <span className="code">{published.folderName}</span>.
          </div>
        )}

        {updated && (
          <div className="notice done" role="status">
            {updated.updated.length ? (
              <>
                <strong>Words and sections updated.</strong> No audio was read or replaced.
              </>
            ) : (
              <>
                <strong>Nothing was updated.</strong>{' '}
                {updated.skipped.map((s) => s.reason).join('; ')}
              </>
            )}
            {updated.stale.length > 0 && (
              <>
                <br />
                It has no words now, and the old file is still there: {updated.stale.join(', ')}
              </>
            )}
          </div>
        )}

        {/* What the press just asked for, in the plain terms it will happen in. */}
        {confirming && !busy && !result && !updated && (
          <div className="notice" role="status">
            <strong>{CONFIRM_TITLE[confirming]}</strong>
            <div style={{ marginTop: 4 }}>
              {confirming === 'stems' && (
                <>
                  Render {partCount} part{partCount === 1 ? '' : 's'}
                  {submixNames.length ? ` and ${submixNames.length} submix${submixNames.length === 1 ? '' : 'es'}` : ''} of “
                  {song.title}” into “{setName}” in the band’s folder. Every stem the set points at is read, and the
                  song’s folder is written over — what it held is kept aside, so it can be undone; and it can be
                  stopped while it runs.
                </>
              )}
              {confirming === 'submixes' && (
                <>
                  Write {submixNames.length} submix{submixNames.length === 1 ? '' : 'es'} for “{song.title}” into “{setName}”,
                  from the audio already in the folder — {submixNames.map((n) => `[${n}]`).join(', ')}. The stems are
                  not touched.
                </>
              )}
              {confirming === 'info' && (
                <>
                  Write the sections, chords, lyrics and patch changes of “{song.title}” into “{setName}”. Nothing is
                  rendered and no audio is read.
                </>
              )}
            </div>
          </div>
        )}

        <div className="btn-row">
          {result ? (
            // Finished: one thing left to do, and it is the plain one.
            <button className="btn primary" onClick={onClose} autoFocus>
              Close
            </button>
          ) : (
            <>
              {/*
                Three jobs, as a set has. While one waits to be agreed to it is
                the only one offered: the other two would be a second question
                over the first.
              */}
              {JOBS.map(([kind, label, why]) =>
                confirming && confirming !== kind ? null : (
                  <button
                    key={kind}
                    className={kind === (confirming ?? 'stems') ? 'btn primary' : 'btn'}
                    title={why}
                    disabled={
                      busy || !alsSong || (kind === 'stems' && partCount === 0) || (kind === 'submixes' && submixNames.length === 0)
                    }
                    onClick={() => {
                      if (confirming === kind) {
                        setConfirming(null);
                        void go(kind);
                      } else {
                        setConfirming(kind);
                      }
                    }}
                  >
                    {busy && job === kind
                      ? `${label}…`
                      : confirming === kind
                        ? `Yes — ${label.toLowerCase()}`
                        : kind === 'stems' && !publishFolderName
                          ? "Choose the band's folder and prepare"
                          : label}
                  </button>
                ),
              )}
              {confirming && !busy && (
                <button className="btn" onClick={() => setConfirming(null)}>
                  Back
                </button>
              )}
              <button
                className={busy ? 'btn danger' : 'btn'}
                onClick={() => (busy ? stop() : onClose())}
                title={busy ? 'Stop preparing. What is already written stays.' : undefined}
              >
                {busy ? 'Stop' : 'Cancel'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
