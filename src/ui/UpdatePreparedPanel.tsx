import { useState } from 'react';
import { useLiveOrder } from '../lib/useLiveOrder';
import type { AlsProject } from '../lib/alsParser';
import * as local from '../lib/localSource';
import { useStore } from '../lib/store';
import { publishLibrary, type PublishResult } from '../lib/publish';
import { locatePrepared } from '../lib/locatePrepared';
import { updatePrepared, type UpdateResult } from '../lib/updatePrepared';

/**
 * Publishing what a set says about a song, without re-publishing the song.
 *
 * The sections, chords, lyric lanes, key and patch changes are all metadata
 * beside the audio, not in it. Adding a section name should cost a file write,
 * not an afternoon of encoding — and the band should have it before the next
 * rehearsal rather than after the next full prepare.
 */
export default function UpdatePreparedPanel({
  project,
  alsPath,
  selected,
  titles,
}: {
  project: AlsProject | null;
  /** The set being worked on, which decides which prepared folder is updated. */
  alsPath: string | null;
  /** The songs ticked above; every function in Set tools acts on these. */
  selected: Set<string>;
  titles: string[];
}) {
  const { publishFolderName, pickPublishFolder, publishFolder } = useStore();
  const liveOrder = useLiveOrder(project, alsPath);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const whole = selected.size === titles.length && titles.length > 0;

  const go = async (folder: local.FolderHandle) => {
    if (!project || !alsPath) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPublished(null);
    try {
      setProgress('Looking for the prepared set…');
      const found = await locatePrepared(folder, alsPath);
      if ('error' in found) throw new Error(found.error);

      const done = await updatePrepared({
        project,
        alsPath,
        setFolder: found.setFolder,
        manifest: found.manifest,
        presentFolders: found.presentFolders,
        only: [...selected],
        songOrder: liveOrder?.titles,
        writeFile: (path, data) => local.writeFile(folder, '', path, data),
        onProgress: (p) => setProgress(`${p.title} — ${p.index} of ${p.count}`),
      });
      setResult(done);

      // The band's library carries the sections and words too, so it is
      // rebuilt from the folder exactly as a full prepare would.
      setProgress('Rebuilding the band’s library…');
      setPublished(await publishLibrary(folder));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
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

  return (
    <>
      <div className="field">
        <label>
          Update without re-rendering
          <span className="hint">
            Writes what the set says <em>about</em> each song — sections, chords, lyric lanes, key
            and patch changes — into the prepared set the band already has. Not a note of audio is
            read, encoded or replaced, so it takes seconds rather than an afternoon.
          </span>
        </label>
        <div className="btn-row">
          <span className="code">{publishFolderName ?? 'no band folder chosen yet'}</span>
        </div>
      </div>

      <div className="notice">
        A song whose <strong>tempo, key or time signature</strong> has changed is left alone and
        named: its folder is called after those, so its audio is out of date too and only a proper
        prepare will fix it. Everything else here is free.
      </div>

      {progress && <div className="notice">{progress}</div>}
      {error && <div className="notice error">{error}</div>}

      {result && (
        <div className="notice done">
          <strong>
            Updated {result.updated.length} song{result.updated.length === 1 ? '' : 's'}
          </strong>{' '}
          in <span className="code">{result.folder}</span> — {result.lyricsWritten} lyric file
          {result.lyricsWritten === 1 ? '' : 's'} and {result.chartsWritten} chart
          {result.chartsWritten === 1 ? '' : 's'} rewritten, no audio touched.
          {published && (
            <>
              <br />
              The band now sees {published.songs} song{published.songs === 1 ? '' : 's'}.
            </>
          )}
          {result.skipped.length > 0 && (
            <>
              <br />
              Left alone: {result.skipped.map((s) => `${s.song} — ${s.reason}`).join('; ')}
            </>
          )}
          {result.stale.length > 0 && (
            <>
              <br />
              No longer has words, but the old file is still there and nothing here can remove it:{' '}
              {result.stale.join(', ')}
            </>
          )}
        </div>
      )}

      <div className="btn-row">
        <button
          className="btn primary"
          disabled={busy || !project || !alsPath || selected.size === 0}
          onClick={() => void start()}
        >
          {busy
            ? 'Updating…'
            : selected.size === 0
              ? 'Nothing ticked'
              : `Update ${whole ? 'the whole set' : `${selected.size} song${selected.size === 1 ? '' : 's'}`}`}
        </button>
      </div>
    </>
  );
}
