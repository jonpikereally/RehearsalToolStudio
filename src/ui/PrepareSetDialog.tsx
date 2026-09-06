import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import type { AudioStanding } from '../lib/audioKey';
import { useLiveOrder } from '../lib/useLiveOrder';
import { parseAls, type AlsProject } from '../lib/alsParser';
import { overallProgress, type PrepareProgress, type PrepareResult } from '../lib/prepare';
import { runPrepare, standingFor, titlesOf, undoPrepare } from '../lib/prepareRun';
import type { Aside } from '../lib/localSource';
import { folderBaseOf } from '../lib/preparedSet';
import { readBytes } from '../lib/source';
import * as local from '../lib/localSource';
import type { PublishResult } from '../lib/publish';
import { SETS_FOLDER } from '../lib/prints';
import { defaultSetName, safeSetName, setNameFor } from '../lib/setName';

/**
 * Turning a set into a folder of songs anyone can play.
 *
 * Deliberately a button rather than something the scan does on its own: it
 * reads every stem the set points at, which is gigabytes, and writes a whole
 * library back. That belongs to a moment you chose, on a machine that has the
 * files locally, not to opening the app.
 *
 * A dialog over the setlist or the song, not a section of Settings: preparing
 * is something you do *to* the set you are looking at, and it was a strange
 * thing to go looking for among the cache budget and the jump sizes.
 * `preselect` ticks a setlist's songs to start with; without it, the whole set.
 */
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

export default function PrepareSetDialog({
  onClose,
  preselect,
  order,
}: {
  onClose: () => void;
  preselect?: string[];
  /** The running order to write, by title, when a setlist's own; else the set's. */
  order?: string[];
}) {
  const { currentSet, outputSet, publishFolderName, pickPublishFolder, publishFolder, settings } = useStore();
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [result, setResult] = useState<PrepareResult | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState<AlsProject | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  /** The run in progress, so it can be stopped: minutes is too long to be locked in. */
  const running = useRef<AbortController | null>(null);
  /**
   * Where each song stands against the last prepare of this set, once the
   * files have been looked at; null while they are being looked at, or
   * when there is no band's folder to look in yet.
   */
  const [standing, setStanding] = useState<Map<string, AudioStanding> | null>(null);
  /** Songs whose words, sections or notes differ from their prepared entry. */
  const [words, setWords] = useState<Set<string>>(new Set());
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [lastPrepared, setLastPrepared] = useState<string | null>(null);
  /** Words and sections refreshed for the songs left alone, once the run is done. */
  const [refreshed, setRefreshed] = useState<{ count: number; songs: string[]; error?: string } | null>(null);
  /** What the last run moved aside, and into which folder it ran, so it can be undone. */
  const aside = useRef<{ folder: string; songs: Aside[] } | null>(null);
  const [undone, setUndone] = useState<string | null>(null);

  const setPath = currentSet;
  const alsName = setPath?.split('/').pop()?.replace(/\.als$/i, '') ?? null;
  // The order the manifest lists songs in: the setlist this was opened from,
  // else the set's running order — AbleSet's, as it has it right now.
  const liveOrder = useLiveOrder(project, order ? null : setPath);
  const songOrder = order ?? liveOrder?.titles ?? undefined;
  /** What the band will see the set called: their folder's name. */
  // The folder chosen at launch; a set without one — the tools alone — falls back to its own name.
  const setName = outputSet?.name ?? setNameFor(setPath);

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
        if (!live) return;
        setProject(parsed);
        if (preselect) {
          const wanted = new Set(preselect);
          setChosen(new Set(parsed.songs.map((s) => s.title).filter((t) => wanted.has(t))));
        }
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [setPath]);

  /*
   * What has changed since the last prepare into this folder.
   *
   * Each song's audio is keyed from the set and the files' revisions, and
   * held against the key its manifest entry carries. Songs whose audio is
   * as it was are unticked to start with — that is the point — and said
   * so, with the reason beside those that changed. Nothing here reads a
   * stem; it is the set, a stat per file, and the manifest.
   */
  useEffect(() => {
    setStanding(null);
    setKeys({});
    setLastPrepared(null);
    if (!project || !setPath || !publishFolderName) return;
    let live = true;
    void (async () => {
      // The band's folder as already granted; never a dialog from an effect.
      const band = await publishFolder();
      if (!band || !live) return;
      const folderName = safeSetName(setName) || defaultSetName(setPath);
      const found = await standingFor(project, setPath, band, folderName);
      if (!live) return;
      setKeys(found.keys);
      setStanding(found.standing);
      setWords(found.words);
      setLastPrepared(found.lastPrepared);
      const next = found.standing;
      const manifest = found.manifest;
      // Unchanged songs start unticked; anything ticked by hand already is kept.
      if (manifest) {
        setChosen((was) => {
          const base = was ?? new Set(project.songs.map((s) => s.title));
          return new Set([...base].filter((t) => next.get(t)?.state !== 'unchanged'));
        });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, setPath, publishFolderName, setName]);

  const titles = project ? titlesOf(project) : [];
  // Nothing chosen yet means the whole set, which is what the button says.
  const selected = chosen ?? new Set(titles);
  // Nothing ticked can still be a run: the unchanged songs' words and sections.
  const refreshable = titles.filter((t) => !selected.has(t) && standing?.get(t)?.state === 'unchanged').length;
  const toggle = (title: string) => {
    const next = new Set(selected);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setChosen(next);
  };

  /**
   * Prepare, and hand the result to the band. The run itself is in
   * prepareRun; the folder is asked for inside the click when it is not
   * already granted — a picker opened after an await is a picker the browser
   * refuses.
   */
  const go = async (folder: local.FolderHandle) => {
    if (!setPath) return;
    running.current = new AbortController();
    setBusy(true);
    setError(null);
    setResult(null);
    setPublished(null);
    setRefreshed(null);
    setUndone(null);
    try {
      const full = project ?? (await parseAls((await readBytes(setPath)).bytes));
      const folderName = safeSetName(setName) || defaultSetName(setPath);
      const touched: Aside[] = [];
      aside.current = { folder: folderName, songs: touched };
      const out = await runPrepare({
        project: full,
        setPath,
        band: folder,
        folderName,
        selected: [...selected],
        standing,
        words,
        keys,
        songOrder,
        cacheBudgetGB: settings.cacheBudgetGB,
        aside: touched,
        signal: running.current.signal,
        onProgress: setProgress,
      });
      setResult(out.result);
      setRefreshed(out.refreshed);
      setPublished(out.published);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        // What the stop left behind: nothing, when it came before the first
        // file was written; else the songs written over, which undo puts back.
        const touched = new Set((aside.current?.songs ?? []).map((a) => folderBaseOf(a.folder).toLowerCase())).size;
        setError(
          touched
            ? `Stopped. ${touched === 1 ? 'One song' : `${touched} songs`} had been written over — undo puts ${touched === 1 ? 'it' : 'them'} back as ${touched === 1 ? 'it was' : 'they were'}; running again rewrites the rest.`
            : 'Stopped before any song was written — the folder is as it was, so there is nothing to undo.',
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      running.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  /** Put back what the last run wrote over, and remove what it added. */
  const undo = async () => {
    const last = aside.current;
    if (!last?.songs.length) return;
    setBusy(true);
    setError(null);
    try {
      const folder = await publishFolder();
      if (!folder) throw new Error("The band's folder is not to hand.");
      const put = await undoPrepare(folder, last.folder, last.songs);
      aside.current = null;
      setResult(null);
      setRefreshed(null);
      setPublished(put.published);
      setUndone(
        `Undone: ${put.restored} song${put.restored === 1 ? '' : 's'} put back as ${put.restored === 1 ? 'it was' : 'they were'}` +
          (put.removed ? `, ${put.removed} the run had added removed` : '') +
          '.',
      );
    } catch (err) {
      setError(`Could not undo: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const undoable = !busy && !!aside.current?.songs.length;

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
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Prepare for Rehearsal Tool"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{lastPrepared ? 'Update' : 'Prepare'} {alsName ?? 'the set'} for Rehearsal Tool</h3>
        {/* The form, until a run has finished: then what happened is all that's shown. */}
        {!result && (
          <>
        {!setPath && <p className="dialog-note">No set is open. Choose one from the Songs tab first.</p>}
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
        <div className="btn-row">
          <span className="code">{publishFolderName ?? 'not chosen yet'}</span>
          {publishFolderName && (
            <button className="btn" onClick={() => void pickPublishFolder()} disabled={busy}>
              Change folder
            </button>
          )}
        </div>
      </div>

      <div className="field">
        <label>
          Into
          <span className="hint">The set folder chosen at launch, under <span className="code">{SETS_FOLDER}/</span> in the band's folder.</span>
        </label>
        <span className="code">{`${SETS_FOLDER}/${safeSetName(setName) || defaultSetName(setPath)}`}</span>
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
          {liveOrder?.note && (
            <div className="hint" style={{ marginBottom: 6 }}>
              {liveOrder.note}
            </div>
          )}
          {standing && lastPrepared && (
            <div className="hint" style={{ marginBottom: 6 }}>
              {(() => {
                const same = titles.filter((t) => standing.get(t)?.state === 'unchanged').length;
                const changed = titles.filter((t) => standing.get(t)?.state === 'changed').length;
                const fresh = titles.filter((t) => standing.get(t)?.state === 'new').length;
                const when = new Date(lastPrepared);
                const since = Number.isNaN(when.getTime()) ? 'the last prepare' : `the prepare of ${when.toLocaleString()}`;
                const worded = titles.filter((t) => standing.get(t)?.state === 'unchanged' && words.has(t)).length;
                return same
                  ? `${same} song${same === 1 ? '' : 's'} unchanged since ${since} — left unticked, their words and sections refreshed instead` +
                      (worded ? ` (words, sections or notes changed in ${worded} of them)` : '') +
                      `. ${changed} changed, ${fresh} new. Tick a song to write it again regardless.`
                  : `Everything has changed since ${since}: ${changed} changed, ${fresh} new.`;
              })()}
            </div>
          )}
          {publishFolderName && project && !standing && (
            <div className="hint" style={{ marginBottom: 6 }}>
              Looking at what changed since the last prepare…
            </div>
          )}
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
                {standing?.get(title) && lastPrepared && (
                  <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 'auto', textAlign: 'right' }}>
                    {(() => {
                      const s = standing.get(title)!;
                      return s.state === 'new'
                        ? 'new'
                        : s.state === 'unchanged'
                          ? words.has(title) ? 'audio unchanged — words or sections changed' : 'unchanged'
                          : `changed — ${s.why}`;
                    })()}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}

          </>
        )}

      {progress && (
        <>
          <PrepareBar progress={progress} />
          <div className="notice">
            {progress.stage === 'done'
              ? 'Finishing…'
              : `${progress.songTitle} · ${progress.partName} — ${progress.stage}${
                  progress.stage === 'shifting' || progress.stage === 'encoding' ? ` ${Math.round(progress.ratio * 100)}%` : ''
                } (song ${progress.songIndex} of ${progress.songCount}${
                  progress.stage === 'shifting' ? '' : `, part ${progress.partIndex} of ${progress.partCount}`
                })`}
          </div>
        </>
      )}

      {error && <div className="notice error">{error}</div>}
      {undone && (
        <div className="notice done" role="status">
          {undone}
        </div>
      )}

      {result && (
        <div className="notice done" role="status">
          <strong>
            {result.songsWritten > 0
              ? `Done — ${result.songsWritten === titles.length && titles.length ? 'the set is' : `${result.songsWritten} song${result.songsWritten === 1 ? ' is' : 's are'}`} prepared.`
              : 'Finished, but nothing was written.'}
          </strong>
          <br />
          Wrote {result.partsWritten} part{result.partsWritten === 1 ? '' : 's'} across{' '}
          {result.songsWritten} song{result.songsWritten === 1 ? '' : 's'} to{' '}
          <span className="code">{result.folder}</span>.
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
              <br />
              The record itself is among the parts of{' '}
              {result.records.length === 1 ? 'one song' : `${result.records.length} songs`} —{' '}
              {result.records.map((r) => `${r.song} [${r.part}]`).join(', ')} — and is tagged so the band's
              player switches to it rather than mixing it in.
            </>
          )}
          {refreshed && (
            <>
              <br />
              {refreshed.error
                ? `The unchanged songs' words and sections could not be refreshed: ${refreshed.error}`
                : refreshed.count
                  ? `Words and sections refreshed for ${refreshed.count} unchanged song${refreshed.count === 1 ? '' : 's'}` +
                    (refreshed.count <= 4 ? ` (${refreshed.songs.join(', ')})` : '') +
                    '.'
                  : 'The unchanged songs had nothing new to say; their files were left as they were.'}
            </>
          )}
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

      {published && (
        <div className="notice">
          Published to <span className="code">{published.folderName}</span> — the band now sees{' '}
          {published.songs} song{published.songs === 1 ? '' : 's'}.
        </div>
      )}

      <div className="btn-row">
        {result ? (
          // Finished: the plain thing to do first, and a way back to the form.
          <>
            <button className="btn primary" onClick={onClose} autoFocus>
              Close
            </button>
            <button
              className="btn"
              onClick={() => {
                setResult(null);
                setPublished(null);
                setRefreshed(null);
              }}
            >
              Prepare again
            </button>
            {undoable && (
              <button className="btn" onClick={() => void undo()} title="Put the songs this run wrote back as they were before it">
                Undo this prepare
              </button>
            )}
          </>
        ) : (
          <>
            {undoable && error && (
              <button className="btn" onClick={() => void undo()} title="Put the songs this run wrote back as they were before it">
                Undo this prepare
              </button>
            )}
            <button
              className="btn primary"
              onClick={() => void start()}
              disabled={busy || !setPath || (selected.size === 0 && !refreshable)}
            >
              {busy
                ? 'Preparing…'
                : selected.size === 0
                  ? refreshable
                    ? `Refresh words and sections of ${refreshable} unchanged song${refreshable === 1 ? '' : 's'}`
                    : 'Nothing chosen'
                  : `${publishFolderName ? 'Prepare' : 'Choose a folder and prepare'} ${
                      selected.size === titles.length && titles.length
                        ? 'the whole setlist'
                        : `${selected.size} song${selected.size === 1 ? '' : 's'}`
                    }`}
            </button>
            <button
              className={busy ? 'btn danger' : 'btn'}
              onClick={() => (busy ? running.current?.abort() : onClose())}
              title={busy ? 'Stop preparing. What is already written stays.' : undefined}
            >
              {busy ? 'Stop' : 'Cancel'}
            </button>
          </>
        )}
      </div>
      {!result && (
        <div style={{ color: '#6b7789', fontSize: 12.5 }}>
          Reads every stem the set points at, which is gigabytes, so it wants the machine those files
          are actually on. What it writes is small enough for a phone.
        </div>
      )}
      </div>
    </div>
  );
}
