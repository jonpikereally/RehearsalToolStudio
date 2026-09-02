import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { parseAls, type AlsProject } from '../lib/alsParser';
import { prepareSet, type PrepareProgress, type PrepareResult } from '../lib/prepare';
import { readBytes } from '../lib/source';
import * as local from '../lib/localSource';
import { publishLibrary, type PublishResult } from '../lib/publish';
import { MANIFEST_NAME, type PreparedManifest } from '../lib/preparedSet';
import { PREPARED_FOLDER, PRINTS_FOLDER } from '../lib/prints';
import { resolveStemPath } from '../lib/alsImport';
import SettingsSection from './SettingsSection';

/**
 * Turning a set into a folder of songs anyone can play.
 *
 * Deliberately a button rather than something the scan does on its own: it
 * reads every stem the set points at, which is gigabytes, and writes a whole
 * library back. That belongs to a moment you chose, on a machine that has the
 * files locally, not to opening the app.
 */
export default function PrepareSet() {
  const { currentSet, publishFolderName, pickPublishFolder, publishFolder } = useStore();
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [result, setResult] = useState<PrepareResult | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState<AlsProject | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);

  const setPath = currentSet;
  const alsName = setPath?.split('/').pop()?.replace(/\.als$/i, '') ?? null;

  /*
   * The song list comes from the set itself, so it has to be read before
   * anything can be chosen. That is a small gzipped file — the gigabytes are
   * the stems, and those are only touched once you press the button.
   */
  useEffect(() => {
    setProject(null);
    setChosen(null);
    if (!setPath) return;
    let live = true;
    void (async () => {
      try {
        const { bytes } = await readBytes(setPath);
        const parsed = await parseAls(bytes);
        if (live) setProject(parsed);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [setPath]);

  // Titles, deduped and in set order: a count-in locator repeats its song's.
  const titles: string[] = [];
  for (const song of project?.songs ?? []) {
    if (titles[titles.length - 1] !== song.title) titles.push(song.title);
  }
  // Nothing chosen yet means the whole set, which is what the button says.
  const selected = chosen ?? new Set(titles);
  const toggle = (title: string) => {
    const next = new Set(selected);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setChosen(next);
  };

  /**
   * Prepare, and hand the result to the band.
   *
   * Everything is written into the band's folder rather than beside the set it
   * came from: that folder is a different Dropbox app folder and the only one
   * they can read. The library goes with it, because a folder of files with no
   * library is a folder the band's app can make nothing of.
   *
   * The folder is asked for inside the click when it is not already granted —
   * a picker opened after an await is a picker the browser refuses.
   */
  const go = async (folder: local.FolderHandle) => {
    if (!setPath) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPublished(null);
    try {
      const { bytes } = await readBytes(setPath);
      const full = project ?? (await parseAls(bytes));
      const ctx = new AudioContext();
      const stamp = new Date().toISOString().slice(0, 10);
      const setName = `${alsName ?? 'Set'} ${stamp}`;

      const done = await prepareSet({
        project: full,
        alsPath: setPath,
        only: [...selected],
        /*
         * What is already in that folder, so a run of one song leaves the
         * songs prepared before it describing themselves as they did.
         */
        readManifest: async () => {
          const path = `${PRINTS_FOLDER}/${PREPARED_FOLDER}/${setName.replace(/[\\/:*?"<>|]/g, '')}/${MANIFEST_NAME}`;
          try {
            const { bytes: raw } = await local.readBytes(folder, '', path);
            return JSON.parse(new TextDecoder().decode(raw)) as PreparedManifest;
          } catch {
            return null; // nothing prepared here yet, which is the usual case
          }
        },
        // The band's folder is its own root; nothing of the studio's path
        // structure comes with it.
        root: '',
        setName,
        resolvePath: (relative) => resolveStemPath(setPath, relative),
        readFile: async (path) => (await readBytes(path)).bytes,
        writeFile: (path, data) => local.writeFile(folder, '', path, data),
        decode: (raw) => ctx.decodeAudioData(raw.slice(0)),
        onProgress: setProgress,
      });
      void ctx.close();
      setResult(done);
      setPublished(await publishLibrary(folder));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const start = async () => {
    try {
      const folder = (await publishFolder()) ?? (await pickPublishFolder());
      await go(folder);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    }
  };

  if (!setPath) return null;

  return (
    <SettingsSection
      id="prepare"
      title="Prepare for Rehearsal Tool"
      summary={busy ? 'preparing…' : alsName ?? 'no set chosen'}
    >
      <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>
        Reads the set's current arrangement and writes each song out as small files anyone can
        play — phones included, with no Ableton needed at the other end.
      </div>

      <div className="field">
        <label>
          Publish to
          <span className="hint">
            The band's own folder, which is the only one they can read. Asked for once.
          </span>
        </label>
        <span className="code">{publishFolderName ?? 'not chosen yet'}</span>
      </div>

      {titles.length > 0 && (
        <div className="field">
          <label>
            What to prepare
            <span className="hint">
              The whole setlist, or the songs you tick. Each song is written on its own, so a
              part-set run leaves the rest of the folder as it was.
            </span>
          </label>
          <div className="btn-row" style={{ marginBottom: 6 }}>
            <button className="btn" disabled={busy} onClick={() => setChosen(new Set(titles))}>
              Whole setlist
            </button>
            <button className="btn" disabled={busy} onClick={() => setChosen(new Set())}>
              Clear
            </button>
            <span style={{ color: 'var(--text-dim)', fontSize: 13, alignSelf: 'center' }}>
              {selected.size === titles.length
                ? `all ${titles.length} songs`
                : `${selected.size} of ${titles.length}`}
            </span>
          </div>
          <div
            style={{
              maxHeight: 220,
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
                  disabled={busy}
                  onChange={() => toggle(title)}
                />
                <span style={{ fontSize: 14 }}>{title}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {progress && (
        <div className="notice">
          {progress.stage === 'done'
            ? 'Finishing…'
            : `${progress.songTitle} · ${progress.partName} — ${progress.stage} (song ${progress.songIndex} of ${progress.songCount})`}
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      {published && (
        <div className="notice">
          Published to <span className="code">{published.folderName}</span> — the band now sees{' '}
          {published.songs} song{published.songs === 1 ? '' : 's'}.
        </div>
      )}

      {result && (
        <div className="notice">
          Wrote {result.partsWritten} part{result.partsWritten === 1 ? '' : 's'} across{' '}
          {result.songsWritten} song{result.songsWritten === 1 ? '' : 's'} to{' '}
          <span className="code">{result.folder}</span>.
          {result.skipped.length > 0 && (
            <>
              <br />
              {result.skipped.length} skipped — {result.skipped[0].part} in {result.skipped[0].song}:{' '}
              {result.skipped[0].reason}
              {result.skipped.length > 1 ? `, and ${result.skipped.length - 1} more.` : ''}
            </>
          )}
        </div>
      )}

      <div className="btn-row">
        <button
          className="btn primary"
          onClick={() => void start()}
          disabled={busy || !setPath || selected.size === 0}
        >
          {busy
            ? 'Preparing…'
            : selected.size === 0
              ? 'Nothing chosen'
              : `${publishFolderName ? 'Prepare' : 'Choose a folder and prepare'} ${
                  selected.size === titles.length && titles.length
                    ? 'the whole setlist'
                    : `${selected.size} song${selected.size === 1 ? '' : 's'}`
                }`}
        </button>
        {publishFolderName && (
          <button className="btn" onClick={() => void pickPublishFolder()} disabled={busy}>
            Change folder
          </button>
        )}
      </div>
      <div style={{ color: '#6b7789', fontSize: 12.5 }}>
        Reads every stem the set points at, which is gigabytes, so it wants the machine those files
        are actually on. What it writes is small enough for a phone.
      </div>
    </SettingsSection>
  );
}
