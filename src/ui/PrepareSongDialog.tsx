import { useEffect, useRef, useState } from 'react';
import type { Song } from '../types';
import { useStore } from '../lib/store';
import { getShiftedBuffer, primeShiftedRender, shiftLanes } from '../lib/pitchService';
import { holdAwake } from '../lib/keepAwake';
import { useLiveOrder } from '../lib/useLiveOrder';
import { parseAls, type AlsProject, type AlsSong } from '../lib/alsParser';
import { overallProgress, partFileName, prepareSet, songFolderName, type PrepareProgress, type PrepareResult, type SongPlan } from '../lib/prepare';
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

/**
 * One song, prepared for the band.
 *
 * The set's tracks for this song, each printed on its own, folded into one
 * "band" part with the others, or left out; rendered as the arrangement has
 * them, encoded small, and written into the band's folder under a name their
 * app reads without help — tempo and key in the folder, the part in
 * brackets — with the manifest and the library updated beside it.
 */

type Choice = 'print' | 'combine' | 'skip';

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
        // The band's own parts printed, the record's reference left out.
        const initial: Record<string, Choice> = {};
        for (const stem of mine.stems) initial[stem.name] = stem.reference ? 'skip' : 'print';
        setChoice(initial);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [song.setPath, song.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const stems = alsSong?.stems ?? [];
  const printing = stems.filter((s) => choice[s.name] === 'print');
  const combining = stems.filter((s) => choice[s.name] === 'combine');
  const partCount = printing.length + (combining.length ? 1 : 0);
  // The folder the rest of the set went into, if it was ever named; else today's.
  const setName = outputSet?.name ?? setNameFor(song.setPath ?? null);
  const folderName = alsSong ? songFolderName(alsSong) : '';

  const stop = () => running.current?.abort();

  const go = async () => {
    if (!alsSong || !project || !song.setPath) return;
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
      const plan: SongPlan = {
        print: printing.map((s) => s.name),
        combine: combining.length ? [{ name: combinedName || 'band', stems: combining.map((s) => s.name) }] : [],
      };
      // What is about to be written over is kept aside, as a set-wide run keeps it.
      const setFolder = `${SETS_FOLDER}/${setName.replace(/[\\/:*?"<>|]/g, '')}`;
      await local.undoBegin(folder, setFolder);
      const ctx = new AudioContext();
      const done = await prepareSet({
        songOrder: liveOrder?.titles,
        beforeSong: async (name, previous) => {
          if (previous) await local.undoKeep(folder, setFolder, previous);
          await local.undoKeep(folder, setFolder, name);
        },
        project,
        alsPath: setPath,
        only: [alsSong.title],
        plan: { [alsSong.title]: plan },
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
              Each track of the song as the set plays it. <strong>Print</strong> makes it a part of
              its own; <strong>Combine</strong> folds it into one part with the others marked the
              same; <strong>Skip</strong> leaves it out.
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
            Wrote {result.partsWritten} part{result.partsWritten === 1 ? '' : 's'} to{' '}
            <span className="code">{result.folder}/{folderName}</span>.
            {result.samplerParts > 0 && (
            <>
              {' '}
              {result.samplerParts} of them {result.samplerParts === 1 ? 'is a pattern' : 'are patterns'} striking{' '}
              {result.samplesShared} sample{result.samplesShared === 1 ? '' : 's'} in{' '}
              <span className="code">Resources/</span> — one kick for every song that fires it.
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

        <div className="btn-row">
          {result ? (
            // Finished: one thing left to do, and it is the plain one.
            <button className="btn primary" onClick={onClose} autoFocus>
              Close
            </button>
          ) : (
            <>
              <button
                className="btn primary"
                disabled={busy || !alsSong || partCount === 0}
                onClick={() => void go()}
              >
                {busy ? 'Preparing…' : publishFolderName ? 'Prepare' : 'Choose the band\'s folder and prepare'}
              </button>
              <button
                className="btn"
                disabled={busy || !alsSong}
                onClick={() => void updateWordsOnly()}
                title="Rewrite this song's sections, chords, lyrics and patch changes in the band's folder, leaving its audio exactly as it is"
              >
                Words and sections only
              </button>
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
