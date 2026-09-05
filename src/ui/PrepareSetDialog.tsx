import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { getShiftedBuffer, primeShiftedRender, shiftLanes } from '../lib/pitchService';
import { holdAwake } from '../lib/keepAwake';
import { audioKeyFor, audioStanding, type AudioStanding } from '../lib/audioKey';
import { songFolderName } from '../lib/prepare';
import { DEFAULT_BITRATE } from '../lib/mp3';
import { updatePrepared } from '../lib/updatePrepared';
import { statFile } from '../lib/source';
import { useLiveOrder } from '../lib/useLiveOrder';
import { parseAls, type AlsProject } from '../lib/alsParser';
import { overallProgress, prepareSet, type PrepareProgress, type PrepareResult } from '../lib/prepare';
import { readBytes } from '../lib/source';
import { clearDecodedCache, releaseReady } from '../lib/songLoader';
import * as local from '../lib/localSource';
import { publishLibrary, type PublishResult } from '../lib/publish';
import { MANIFEST_NAME, type PreparedManifest } from '../lib/preparedSet';
import { SETS_FOLDER } from '../lib/prints';
import { resolveStemPath } from '../lib/alsImport';
import { defaultSetName, rememberSetName, safeSetName, setNameFor } from '../lib/setName';

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
  const { currentSet, publishFolderName, pickPublishFolder, publishFolder, settings } = useStore();
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
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [lastPrepared, setLastPrepared] = useState<string | null>(null);
  /** Words and sections refreshed for the songs left alone, once the run is done. */
  const [refreshed, setRefreshed] = useState<{ count: number; error?: string } | null>(null);

  const setPath = currentSet;
  const alsName = setPath?.split('/').pop()?.replace(/\.als$/i, '') ?? null;
  // The order the manifest lists songs in: the setlist this was opened from,
  // else the set's running order — AbleSet's, as it has it right now.
  const liveOrder = useLiveOrder(project, order ? null : setPath);
  const songOrder = order ?? liveOrder?.titles ?? undefined;
  /** What the band will see the set called: their folder's name. */
  const [setName, setSetName] = useState(() => setNameFor(setPath));
  useEffect(() => setSetName(setNameFor(setPath)), [setPath]);

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
      let manifest: PreparedManifest | null = null;
      try {
        const { bytes } = await local.readBytes(band, '', `${SETS_FOLDER}/${folderName}/${MANIFEST_NAME}`);
        manifest = JSON.parse(new TextDecoder().decode(bytes)) as PreparedManifest;
      } catch {
        manifest = null; // never prepared under this name: every song is new
      }
      const revs = new Map<string, string | null>();
      const paths = new Set<string>();
      for (const song of project.songs) for (const stem of song.stems) for (const clip of stem.clips) {
        if (!clip.disabled) paths.add(resolveStemPath(setPath, clip.path));
      }
      // A stat apiece, a dozen at a time; a missing file is a fact, not a failure.
      const list = [...paths];
      for (let i = 0; i < list.length; i += 12) {
        await Promise.all(
          list.slice(i, i + 12).map(async (path) => {
            try {
              const st = await statFile(path);
              revs.set(path.toLowerCase(), `${st.modified}-${st.size}`);
            } catch {
              revs.set(path.toLowerCase(), null);
            }
          }),
        );
      }
      if (!live) return;
      const inputs = {
        fileRev: (path: string) => revs.get(resolveStemPath(setPath, path).toLowerCase()) ?? null,
        bitrate: DEFAULT_BITRATE,
        sampleRate: 48000,
      };
      const nextKeys: Record<string, string> = {};
      const next = new Map<string, AudioStanding>();
      for (const song of project.songs) {
        if (nextKeys[song.title]) continue;
        const key = audioKeyFor(song, project, inputs);
        nextKeys[song.title] = key;
        const folder = songFolderName(song, project).toLowerCase();
        const entry = manifest?.songs.find((e) => e.folder.toLowerCase() === folder);
        next.set(song.title, audioStanding(key, entry?.audioKey, !!entry));
      }
      setKeys(nextKeys);
      setStanding(next);
      setLastPrepared(manifest?.preparedAt ?? null);
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
    running.current = new AbortController();
    // Minutes of work nobody is touching is what a Mac calls idle; held
    // awake, or the display sleeps, the app naps and the run crawls.
    const releaseAwake = holdAwake('Preparing a set');
    setBusy(true);
    setError(null);
    setResult(null);
    setPublished(null);
    setRefreshed(null);
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

      const { bytes } = await readBytes(setPath);
      const full = project ?? (await parseAls(bytes));
      const ctx = new AudioContext();
      // A blank field means today's name, the same as never having typed one.
      const folderName = safeSetName(setName) || defaultSetName(setPath);
      rememberSetName(setPath, folderName === defaultSetName(setPath) ? '' : folderName);

      const done = await prepareSet({
        project: full,
        alsPath: setPath,
        only: [...selected],
        /*
         * What is already in that folder, so a run of one song leaves the
         * songs prepared before it describing themselves as they did.
         */
        readManifest: async () => {
          const path = `${SETS_FOLDER}/${folderName}/${MANIFEST_NAME}`;
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
        setName: folderName,
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
        audioKeys: keys,
        songOrder,
        onProgress: setProgress,
        signal: running.current.signal,
      });
      void ctx.close();
      setResult(done);

      /*
       * The songs left alone still get their words and sections: a lyric
       * fixed in the set lands everywhere, whether or not any audio moved.
       * The cheap path, over the manifest the run just wrote.
       */
      const untouched = titles.filter((t) => !selected.has(t) && standing?.get(t)?.state === 'unchanged');
      if (untouched.length) {
        try {
          const setFolder = `${SETS_FOLDER}/${folderName}`;
          const { bytes: raw } = await local.readBytes(folder, '', `${setFolder}/${MANIFEST_NAME}`);
          const manifest = JSON.parse(new TextDecoder().decode(raw)) as PreparedManifest;
          const under = `${setFolder.toLowerCase()}/`;
          const presentFolders = [
            ...new Set(
              (await local.listFiles(folder, ''))
                .map((f) => f.path.replace(/^\/+/, ''))
                .filter((path) => path.toLowerCase().startsWith(under))
                .map((path) => path.slice(under.length).split('/')[0])
                .filter((name) => name && !name.includes('.')),
            ),
          ];
          const refresh = await updatePrepared({
            project: full,
            alsPath: setPath,
            setFolder,
            manifest,
            presentFolders,
            only: untouched,
            songOrder,
            writeFile: (path, data) => local.writeFile(folder, '', path, data),
            signal: running.current?.signal,
          });
          setRefreshed({ count: refresh.updated.length });
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') throw err;
          setRefreshed({ count: 0, error: err instanceof Error ? err.message : String(err) });
        }
      }
      setPublished(await publishLibrary(folder));
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setError('Stopped. Songs already written are in the folder; running it again rewrites the rest.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      releaseAwake();
      running.current = null;
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
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Prepare for Rehearsal Tool"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Prepare {alsName ?? 'the set'} for Rehearsal Tool</h3>
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
        <label htmlFor="set-folder">
          Call the set
          <span className="hint">
            The folder the band opens, under{' '}
            <span className="code">{SETS_FOLDER}/</span>. Remembered for this set,
            so a song prepared later lands in the same folder.
          </span>
        </label>
        <div className="btn-row">
          <input
            id="set-folder"
            className="text-input"
            type="text"
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            onBlur={() => setSetName((v) => safeSetName(v) || defaultSetName(setPath))}
            disabled={busy}
            aria-label="Name of the prepared set's folder"
          />
          {safeSetName(setName) !== defaultSetName(setPath) && (
            <button className="btn" disabled={busy} onClick={() => setSetName(defaultSetName(setPath))}>
              Today's name
            </button>
          )}
        </div>
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
                return same
                  ? `${same} song${same === 1 ? '' : 's'} unchanged since ${since} — left unticked, their words and sections refreshed instead. ` +
                      `${changed} changed, ${fresh} new. Tick a song to write it again regardless.`
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
                      return s.state === 'new' ? 'new' : s.state === 'unchanged' ? 'unchanged' : `changed — ${s.why}`;
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
                : `Words and sections refreshed for ${refreshed.count} unchanged song${refreshed.count === 1 ? '' : 's'}.`}
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
          </>
        ) : (
          <>
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
