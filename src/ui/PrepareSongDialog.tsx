import { useEffect, useState } from 'react';
import type { Song } from '../types';
import { useStore } from '../lib/store';
import { getShiftedBuffer } from '../lib/pitchService';
import { parseAls, type AlsProject, type AlsSong } from '../lib/alsParser';
import { partFileName, prepareSet, songFolderName, type PrepareProgress, type PrepareResult, type SongPlan } from '../lib/prepare';
import { readBytes } from '../lib/source';
import * as local from '../lib/localSource';
import { publishLibrary, type PublishResult } from '../lib/publish';
import { MANIFEST_NAME, type PreparedManifest } from '../lib/preparedSet';
import { PREPARED_FOLDER, PRINTS_FOLDER } from '../lib/prints';
import { resolveStemPath } from '../lib/alsImport';
import { songKey } from '../lib/alsParser';

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

export default function PrepareSongDialog({ song, onClose }: { song: Song; onClose: () => void }) {
  const { publishFolderName, pickPublishFolder, publishFolder, settings } = useStore();
  const [project, setProject] = useState<AlsProject | null>(null);
  const [alsSong, setAlsSong] = useState<AlsSong | null>(null);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [combinedName, setCombinedName] = useState('band');
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [result, setResult] = useState<PrepareResult | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const alsName = song.setPath?.split('/').pop()?.replace(/\.als$/i, '') ?? 'Set';
  const setName = `${alsName} ${new Date().toISOString().slice(0, 10)}`;
  const folderName = alsSong && project ? songFolderName(alsSong, project) : '';

  const go = async () => {
    if (!alsSong || !project || !song.setPath) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPublished(null);
    try {
      // Asked for inside the click, where a dialog is allowed to open.
      const folder = (await publishFolder()) ?? (await pickPublishFolder());
      const setPath = song.setPath;
      const plan: SongPlan = {
        print: printing.map((s) => s.name),
        combine: combining.length ? [{ name: combinedName || 'band', stems: combining.map((s) => s.name) }] : [],
      };
      const ctx = new AudioContext();
      const done = await prepareSet({
        project,
        alsPath: setPath,
        only: [alsSong.title],
        plan: { [alsSong.title]: plan },
        readManifest: async () => {
          const path = `${PRINTS_FOLDER}/${PREPARED_FOLDER}/${setName.replace(/[\\/:*?"<>|]/g, '')}/${MANIFEST_NAME}`;
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
        writeFile: (path, data) => local.writeFile(folder, '', path, data),
        decode: (raw) => ctx.decodeAudioData(raw.slice(0)),
        shift: (buffer, semitones, speed) =>
          getShiftedBuffer({
            ctx,
            path: `prepare:${semitones}:${speed}`,
            rev: `${buffer.length}@${buffer.sampleRate}`,
            semitones,
            tempo: speed,
            source: buffer,
            budgetBytes: settings.cacheBudgetGB * 1e9,
          }),
        onProgress: setProgress,
      });
      void ctx.close();
      setResult(done);
      setPublished(await publishLibrary(folder));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    } finally {
      setBusy(false);
      setProgress(null);
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
                    {PRINTS_FOLDER}/{PREPARED_FOLDER}/{setName}/{folderName}/
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
          <div className="notice">
            {progress.stage === 'done'
              ? 'Finishing…'
              : `${progress.partName} — ${progress.stage}${progress.stage === 'encoding' ? ` ${Math.round(progress.ratio * 100)}%` : ''}`}
          </div>
        )}
        {error && <div className="notice error">{error}</div>}
        {result && (
          <div className="notice">
            Wrote {result.partsWritten} part{result.partsWritten === 1 ? '' : 's'} to{' '}
            <span className="code">{result.folder}/{folderName}</span>.
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

        <div className="btn-row">
          <button
            className="btn primary"
            disabled={busy || !alsSong || partCount === 0 || !!result}
            onClick={() => void go()}
          >
            {busy ? 'Preparing…' : publishFolderName ? 'Prepare' : 'Choose the band\'s folder and prepare'}
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>
            {result ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
