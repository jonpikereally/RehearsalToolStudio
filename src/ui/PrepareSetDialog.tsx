import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import type { AudioStanding } from '../lib/audioKey';
import { useLiveOrder } from '../lib/useLiveOrder';
import { parseAls, type AlsProject } from '../lib/alsParser';
import { describeParts, overallProgress, type PrepareProgress, type PrepareResult } from '../lib/prepare';
import { runPrepare, standingFor, titlesOf, undoPrepare } from '../lib/prepareRun';
import { ALL_INFO, INFO_LABEL, type InfoKinds } from '../lib/updatePrepared';
import { note } from '../lib/saveLog';
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

/** The four jobs the buttons offer: everything, or that work taken apart. */
type Job = 'all' | 'stems' | 'submixes' | 'info';

/** What a press is called back to it, before it goes ahead. */
const CONFIRM_TITLE: Record<Job, string> = {
  all: 'Prepare everything?',
  stems: 'Render the stems?',
  submixes: 'Write the submixes?',
  info: 'Write the words and sections?',
};

export default function PrepareSetDialog({
  onClose,
  preselect,
  order,
  only,
}: {
  onClose: () => void;
  preselect?: string[];
  /** The running order to write, by title, when a setlist's own; else the set's. */
  order?: string[];
  /**
   * The job this window was opened for, when it was opened for one: the bar
   * offers each on its own. It picks the button that leads, and keeps the
   * songs the caller chose — they are chosen for that job, not for the audio's
   * sake, so the usual unticking of unchanged songs must not touch them.
   */
  only?: 'stems' | 'submixes' | 'info';
}) {
  const { currentSet, outputSet, publishFolderName, pickPublishFolder, publishFolder, settings } = useStore();
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [result, setResult] = useState<PrepareResult | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  /** What a submix run wrote, which is its own kind of finished. */
  const [submixResult, setSubmixResult] = useState<PrepareResult | null>(null);
  /**
   * Which job the press asks for. `all` is the whole thing — the stems of the
   * songs ticked, the submixes anybody is missing, and the words of the rest.
   * The other three are that work taken apart, since a set is usually behind
   * in one way at a time.
   */
  const [job, setJob] = useState<Job>(only ?? 'all');
  /**
   * The job a press has asked for and is waiting to be agreed to.
   *
   * A prepare writes over the band's folder — an hour of rendering for a set,
   * and the songs that were there written over — and it went the moment a
   * button was pressed. So the press names the job and says what it will do
   * to what, and the work starts on the second press.
   */
  const [confirming, setConfirming] = useState<Job | null>(null);
  /** Which facts an info run writes. */
  const [infoKinds, setInfoKinds] = useState<InfoKinds>(ALL_INFO);
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
  /** Why each song's submixes are behind the band, when they are. */
  const [submixStanding, setSubmixStanding] = useState<Map<string, string | null> | null>(null);
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
      setSubmixStanding(found.submixes);
      setWords(found.words);
      setLastPrepared(found.lastPrepared);
      const next = found.standing;
      const manifest = found.manifest;
      /*
       * Unchanged songs start unticked; anything ticked by hand already is
       * kept. Never when the job is the submixes: their songs are unchanged
       * by definition — that is the whole point of the pass — and unticking
       * them would leave the dialog offering nothing.
       */
      if (manifest && !only) {
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
  const toggle = (title: string) => {
    const next = new Set(selected);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setChosen(next);
  };

  /* --- what a press is about to do, for the sentence that asks first --- */

  const songCount = selected.size;
  const someSongs = songCount === titles.length && titles.length > 1
    ? `all ${songCount} songs`
    : `${songCount} song${songCount === 1 ? '' : 's'}`;
  /** How many of the chosen songs lack a submix the band asks for. */
  const behindOnSubmixes = titles.filter((t) => selected.has(t) && submixStanding?.get(t)).length;
  const infoWanted = (Object.keys(INFO_LABEL) as (keyof InfoKinds)[])
    .filter((k) => infoKinds[k])
    .map((k) => INFO_LABEL[k].toLowerCase())
    .join(', ') || 'nothing';
  /** The songs by name, while they are few enough to be worth naming. */
  const chosenNames = songCount && songCount <= 6 ? [...selected].join(', ') : null;

  /**
   * Prepare, and hand the result to the band. The run itself is in
   * prepareRun; the folder is asked for inside the click when it is not
   * already granted — a picker opened after an await is a picker the browser
   * refuses.
   */
  const go = async (folder: local.FolderHandle, kind: Job = job) => {
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
      const ticked = [...selected];
      const behind = titles.filter((t) => submixStanding?.get(t));
      const out = await runPrepare({
        project: full,
        setPath,
        band: folder,
        folderName,
        /*
         * Each job says which of the three passes it wants. The stems' songs
         * go in one list, the submixes' in another, and what the words do is
         * `refresh` — so "prepare the submixes" writes nothing but submixes,
         * and "prepare the info" reads no audio at all.
         */
        selected: kind === 'all' || kind === 'stems' ? ticked : [],
        submixes: kind === 'all' ? behind : kind === 'submixes' ? ticked : undefined,
        refresh: kind === 'stems' || kind === 'submixes' ? 'none' : kind === 'info' ? ticked : 'auto',
        infoKinds: kind === 'info' ? infoKinds : undefined,
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
      setSubmixResult(out.submixes);
      setRefreshed(out.refreshed);
      setPublished(out.published);
      if (!out.published && out.publishError) {
        setError(`The files are written, but the band's library could not be: ${out.publishError}`);
      }
      // By hand, but the same thing happened to the band's folder, so it goes
      // in the same log as the saves the studio answered on its own.
      const wrote = (out.result?.songsWritten ?? 0) + (out.submixes?.songsWritten ?? 0);
      // What the band can see of it, or why they cannot see it yet.
      const band = (o: typeof out) =>
        o.published ? ` The band sees ${o.published.songs}.` : ` The band's library could not be written: ${o.publishError}`;
      note({
        kind: wrote || out.refreshed?.count ? 'updated' : 'nothing',
        session: setPath.split('/').pop() ?? setPath,
        set: folderName,
        songs: [...selected],
        text: only === 'submixes'
          ? `Submixes written by hand for ${out.submixes?.songsWritten ?? 0} song${out.submixes?.songsWritten === 1 ? '' : 's'}.${band(out)}`
          : `Prepared by hand: ${out.result?.songsWritten ?? 0} song${out.result?.songsWritten === 1 ? '' : 's'} written${
              out.refreshed?.count ? `, ${out.refreshed.count} refreshed` : ''
            }.${band(out)}`,
      });
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
      note({
        kind: 'undone',
        session: setPath?.split('/').pop() ?? 'the set',
        set: last.folder,
        text: `Undone by hand: ${put.restored} song${put.restored === 1 ? '' : 's'} put back${put.removed ? `, ${put.removed} removed` : ''}. The band sees ${put.published.songs}.`,
      });
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

  const start = async (kind: Job = job) => {
    try {
      const folder = (await publishFolder()) ?? (await pickPublishFolder());
      await go(folder, kind);
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
        <h3>
          {only === 'submixes'
            ? `Write the band's submixes for ${alsName ?? 'the set'}`
            : only === 'info'
              ? `Write the words and sections of ${alsName ?? 'the set'}`
              : only === 'stems'
                ? `Render the stems of ${alsName ?? 'the set'}`
                : `${lastPrepared ? 'Update' : 'Prepare'} ${alsName ?? 'the set'} for Rehearsal Tool`}
        </h3>
        {/* The form, until a run has finished: then what happened is all that's shown. */}
        {!result && !submixResult && (
          <>
        {!setPath && <p className="dialog-note">No set is open. Choose one from the Songs tab first.</p>}
      <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>
        {only === 'submixes'
          ? "Writes each member's submix from the set's own audio, and nothing else: the stems already in the folder stay exactly as they are."
          : only === 'info'
            ? 'Writes the facts beside the audio — sections, chords, words, patch changes — into the folder. Nothing is rendered and no stem is touched.'
            : `Reads the set's current arrangement and writes each song out as small files anyone can play — phones included, with no Ableton needed at the other end.`}
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
          {only === 'submixes' && submixStanding && (
            <div className="hint" style={{ marginBottom: 6 }}>
              {(() => {
                const behind = titles.filter((t) => submixStanding.get(t));
                return behind.length
                  ? `${behind.length} song${behind.length === 1 ? '' : 's'} ${behind.length === 1 ? 'wants' : 'want'} submixes the folder hasn't got. ` +
                    'Their stems stay exactly as they are — only the submixes are written.'
                  : 'Every song already has the submixes the band asks for.';
              })()}
            </div>
          )}
          {only !== 'submixes' && standing && lastPrepared && (
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
                {only === 'submixes' ? (
                  <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 'auto', textAlign: 'right' }}>
                    {submixStanding?.get(title) ?? 'has the submixes the band asks for'}
                  </span>
                ) : (
                  standing?.get(title) && lastPrepared && (
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
                  )
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
          Wrote {describeParts(result)} across {result.songsWritten} song
          {result.songsWritten === 1 ? '' : 's'} to <span className="code">{result.folder}</span>.
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

      {submixResult && (
        <div className="notice done" role="status">
          <strong>
            {submixResult.songsWritten > 0
              ? `Done — the submixes are written for ${submixResult.songsWritten} song${submixResult.songsWritten === 1 ? '' : 's'}.`
              : 'Finished, but nothing was written.'}
          </strong>
          <br />
          Wrote {submixResult.partsWritten} submix{submixResult.partsWritten === 1 ? '' : 'es'} into{' '}
          <span className="code">{submixResult.folder}</span>, under each song's{' '}
          <span className="code">submixes/</span> folder. The stems were not touched.
          {submixResult.skipped.length > 0 && (
            <>
              <br />
              {submixResult.skipped.length} skipped — {submixResult.skipped[0].part} in {submixResult.skipped[0].song}:{' '}
              {submixResult.skipped[0].reason}
              {submixResult.skipped.length > 1 ? `, and ${submixResult.skipped.length - 1} more.` : ''}
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

      {/*
        What the press just asked for, in the plain terms it will happen in:
        which songs, how many, into which folder, and — for the jobs that
        render — that it is hours and gigabytes and writes over what is there.
      */}
      {confirming && !busy && !result && !submixResult && (
        <div className="notice" role="status">
          <strong>{CONFIRM_TITLE[confirming]}</strong>
          <div style={{ marginTop: 4 }}>
            {confirming === 'all' && (
              <>
                Render {someSongs}
                {behindOnSubmixes
                  ? `, write the submixes of the ${behindOnSubmixes} song${behindOnSubmixes === 1 ? '' : 's'} that lack one,`
                  : ''}{' '}
                and refresh the words and sections of the rest, into “{setName}” in the band’s folder. Every stem the
                set points at is read, which is gigabytes and can be an hour.
              </>
            )}
            {confirming === 'stems' && (
              <>
                Render {someSongs} into “{setName}” in the band’s folder. Every stem the set points at is read, which is
                gigabytes and can be an hour; each song’s folder is written over.
              </>
            )}
            {confirming === 'submixes' && (
              <>
                Write each member’s submix for {someSongs} into “{setName}”, from the audio already in the folder. The
                stems are not touched.
              </>
            )}
            {confirming === 'info' && (
              <>
                Write {infoWanted} for {someSongs} into “{setName}”. Nothing is rendered and no audio is read.
              </>
            )}
            {(confirming === 'all' || confirming === 'stems') && (
              <> What it writes over is kept aside, so it can be undone; and it can be stopped while it runs.</>
            )}
          </div>
          {chosenNames && <div className="hint" style={{ marginTop: 4 }}>{chosenNames}</div>}
        </div>
      )}

      <div className="btn-row">
        {result || submixResult ? (
          // Finished: the plain thing to do first, and a way back to the form.
          <>
            <button className="btn primary" onClick={onClose} autoFocus>
              Close
            </button>
            <button
              className="btn"
              onClick={() => {
                setResult(null);
                setSubmixResult(null);
                setPublished(null);
                setRefreshed(null);
              }}
            >
              {only === 'submixes' ? 'Write more' : 'Prepare again'}
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
            {/*
              Four jobs, because a set is usually behind in one way at a time:
              everything, the stems alone, the submixes alone, or the words
              and sections beside them, which read no audio at all.
            */}
            {/* Which facts an info run writes; all of them unless told otherwise. */}
            {(
              [
                ['all', 'Prepare all', 'The stems of the songs ticked, the submixes anybody is missing, and the words of the rest'],
                ['stems', 'Prepare stems', 'Render the ticked songs — their parts and their submixes. The slow one.'],
                ['submixes', 'Prepare submixes', "Each member's submix of the ticked songs, from the audio already in the folder"],
                ['info', 'Prepare info', 'The facts beside the audio: sections, chords, words, patch changes. Nothing is rendered.'],
              ] as const
            ).map(([kind, label, why]) =>
              // While a job waits to be agreed to, it is the only one offered:
              // the other three would be a second question over the first.
              confirming && confirming !== kind ? null : (
                <button
                  key={kind}
                  className={kind === (confirming ?? only ?? 'all') ? 'btn primary' : 'btn'}
                  title={why}
                  disabled={busy || !setPath || selected.size === 0}
                  onClick={() => {
                    setJob(kind);
                    if (confirming === kind) {
                      setConfirming(null);
                      void start(kind);
                    } else {
                      setConfirming(kind);
                    }
                  }}
                >
                  {busy && kind === job ? `${label}…` : confirming === kind ? `Yes — ${label.toLowerCase()}` : label}
                </button>
              ),
            )}
            <button
              className={busy ? 'btn danger' : 'btn'}
              onClick={() => (busy ? running.current?.abort() : confirming ? setConfirming(null) : onClose())}
              title={busy ? 'Stop preparing. What is already written stays.' : undefined}
            >
              {busy ? 'Stop' : confirming ? 'Back' : 'Cancel'}
            </button>
          </>
        )}
      </div>
      {/*
        What "Prepare info" writes. All of it unless told otherwise — a set
        whose chords have been redone and whose sections have not should be
        able to send the chords without the sections following. What is left
        unticked is not touched: the entry keeps what it had.
      */}
      {!result && !submixResult && (
        <div className="info-kinds">
          <span className="control-label">Info to write</span>
          <button
            className={Object.values(infoKinds).every(Boolean) ? 'chip on' : 'chip'}
            disabled={busy}
            onClick={() => setInfoKinds(ALL_INFO)}
          >
            All
          </button>
          {(Object.keys(INFO_LABEL) as (keyof InfoKinds)[]).map((kind) => (
            <button
              key={kind}
              className={infoKinds[kind] ? 'chip on' : 'chip'}
              disabled={busy}
              onClick={() => {
                const next = { ...infoKinds, [kind]: !infoKinds[kind] };
                // Never none: the button would have nothing to write.
                setInfoKinds(Object.values(next).some(Boolean) ? next : { ...ALL_INFO });
              }}
            >
              {INFO_LABEL[kind]}
            </button>
          ))}
        </div>
      )}
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
