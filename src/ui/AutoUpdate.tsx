import { useEffect, useRef, useState } from 'react';
import { autoUpdates, useStore } from '../lib/store';
import { parseAls } from '../lib/alsParser';
import { readBytes } from '../lib/source';
import { overallProgress, type PrepareProgress } from '../lib/prepare';
import { audioKeysFor, runPrepare, standingFor, titlesOf, undoPrepare, type RunOutcome } from '../lib/prepareRun';
import type { Aside } from '../lib/localSource';
import { folderBaseOf } from '../lib/preparedSet';
import { defaultSetName, safeSetName, setNameFor } from '../lib/setName';
import { runningOrderTitles } from '../lib/ableset';
import { preparedNameFor } from '../lib/locatePrepared';
import PrepareSetDialog from './PrepareSetDialog';
import { navigate } from '../lib/router';
import { note } from '../lib/saveLog';

/**
 * Keeping the prepared set current with the set as Live saves it.
 *
 * The studio sits beside Live; the store notices each save and reads the
 * folder again. This is what happens next. Three jobs can be set to happen on
 * their own — the stems of the songs whose audio changed, the submixes of the
 * songs behind the band, the words and sections of the rest — and only the
 * ones switched on are done, with nobody at a dialog; a bar says what is being
 * written and what was. With all three off, the bar says the set was saved and
 * offers the update, so nothing is ever written that wasn't asked for.
 *
 * A set never prepared under its name is not prepared on a save: that is
 * gigabytes of work nobody chose, and the first prepare is where the folder
 * is named and the band's folder chosen.
 */

type Phase =
  | { kind: 'saved'; at: number }
  | { kind: 'running'; at: number; stage: string; progress: PrepareProgress | null }
  | { kind: 'done'; at: number; outcome: RunOutcome; selected: string[] }
  | { kind: 'unprepared'; at: number }
  | { kind: 'nothing'; at: number }
  | { kind: 'wholeSet'; at: number; folder: string; count: number }
  | { kind: 'error'; at: number; message: string }
  | { kind: 'undone'; at: number; restored: number; removed: number; songs: number };

/** The three jobs a save can do on its own, as they are named on screen. */
export const AUTO_JOBS: { key: 'stems' | 'submixes' | 'info'; label: string; hint: string }[] = [
  { key: 'stems', label: 'Stems', hint: 'Render again the songs whose audio has changed' },
  { key: 'submixes', label: 'Submixes', hint: "Write the submixes of songs that lack one the band asks for" },
  { key: 'info', label: 'Words & sections', hint: 'Refresh words, sections, chords, notes and key where they have moved' },
];

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function AutoUpdate() {
  const { currentSet, outputSet, setSaved, dismissSetSaved, settings, saveSettings, publishFolder, library } = useStore();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [dialog, setDialog] = useState(false);
  /** The save being acted on, so a newer one is not answered twice and an older run's news is dropped. */
  const acting = useRef<number | null>(null);
  const stopper = useRef<AbortController | null>(null);
  /** What the last run moved aside, and where, so it can be put back. */
  const aside = useRef<{ folder: string; songs: Aside[] } | null>(null);
  const libraryRef = useRef(library);
  libraryRef.current = library;

  const setName = currentSet?.split('/').pop()?.replace(/\.als$/i, '') ?? 'The set';

  const auto = settings.autoUpdate;

  useEffect(() => {
    if (!setSaved || !currentSet || setSaved.path !== currentSet) return;
    const at = setSaved.at;
    // Once per save — except that turning a job on while a save waits
    // in the bar is the answer to that save, and it goes ahead now.
    if (acting.current === at && !(autoUpdates(auto) && phase?.kind === 'saved')) return;
    acting.current = at;
    if (!autoUpdates(auto)) {
      setPhase({ kind: 'saved', at });
      return;
    }
    const current = () => acting.current === at;
    const controller = new AbortController();
    stopper.current = controller;
    void (async () => {
      try {
        // The band's folder as already granted; never a dialog from an effect.
        const band = await publishFolder();
        if (!band) {
          if (current()) setPhase({ kind: 'error', at, message: "Auto-update needs the band's folder, which a prepare chooses. Prepare the set once by hand." });
          return;
        }
        if (current()) setPhase({ kind: 'running', at, stage: 'Reading the set…', progress: null });
        const { bytes } = await readBytes(currentSet);
        const project = await parseAls(bytes);
        if (current()) setPhase({ kind: 'running', at, stage: 'Looking at what changed…', progress: null });
        // The folder this set already has in the band's folder, whatever
        // either is called now: known by the songs in it.
        const keys = await audioKeysFor(project, currentSet);
        const folderName = outputSet?.name ?? (await preparedNameFor(band, currentSet, keys.byName));
        const found = await standingFor(project, currentSet, band, folderName, keys);
        if (!found.manifest) {
          note({ kind: 'held', session: setName, set: folderName, text: `Left alone: nothing has been prepared into “${folderName}” yet.` });
          if (current()) setPhase({ kind: 'unprepared', at });
          return;
        }
        const titles = titlesOf(project);
        const changed = titles.filter((t) => found.standing.get(t)?.state !== 'unchanged');
        // Only the jobs switched on. Each is asked its own question of the
        // folder, and a job left off contributes nothing to the run.
        const selected = auto.stems ? changed : [];
        const behind = auto.submixes ? titles.filter((t) => found.submixes.get(t)) : [];
        const refresh = auto.info ? 'auto' : 'none';
        if (!selected.length && !behind.length && refresh === 'none') {
          if (current()) setPhase({ kind: 'nothing', at });
          return;
        }
        /*
         * Every song changed is not a save, it is a wrong folder or a
         * studio that renders differently now — and a full render is an
         * hour nobody asked for. Said, and left to a person.
         */
        if (selected.length === titles.length && titles.length > 1) {
          note({
            kind: 'held',
            session: setName,
            set: folderName,
            text: `Left alone: all ${titles.length} songs would have been written again against “${folderName}”, which is not a save's worth of change.`,
          });
          if (current()) setPhase({ kind: 'wholeSet', at, folder: folderName, count: titles.length });
          return;
        }
        const touched: Aside[] = [];
        aside.current = { folder: folderName, songs: touched };
        if (current())
          setPhase({
            kind: 'running',
            at,
            stage: selected.length ? '' : behind.length ? 'Writing the submixes…' : 'Refreshing words and sections…',
            progress: null,
          });
        const outcome = await runPrepare({
          project,
          setPath: currentSet,
          band,
          folderName,
          selected,
          submixes: behind,
          refresh,
          standing: found.standing,
          words: found.words,
          keys: found.keys,
          // The order as the scan just found it, AbleSet's log included.
          songOrder: runningOrderTitles(libraryRef.current, currentSet) ?? undefined,
          cacheBudgetGB: settings.cacheBudgetGB,
          aside: touched,
          signal: controller.signal,
          onProgress: (p) => current() && setPhase({ kind: 'running', at, stage: '', progress: p }),
        });
        const written = outcome.result?.songsWritten ?? 0;
        const mixed = outcome.submixes?.songsWritten ?? 0;
        const refreshed = outcome.refreshed?.count ?? 0;
        const did = [
          written ? `${written} song${written === 1 ? '' : 's'} written again` : '',
          mixed ? `submixes written for ${mixed} song${mixed === 1 ? '' : 's'}` : '',
          refreshed ? `words and sections refreshed for ${refreshed} song${refreshed === 1 ? '' : 's'}` : '',
        ].filter(Boolean);
        note({
          kind: did.length ? 'updated' : 'nothing',
          session: setName,
          set: folderName,
          songs: [...new Set([...selected, ...behind])],
          text: did.length
            ? `${written || mixed ? '' : 'No audio had changed; '}${did.join(', ')}.` +
              (outcome.published ? ` The band sees ${outcome.published.songs}.` : ` The band's library could not be written: ${outcome.publishError}`)
            : 'Nothing had changed.',
        });
        if (current()) setPhase({ kind: 'done', at, outcome, selected });
      } catch (err) {
        if (!current()) return;
        const aborted = (err as { name?: string })?.name === 'AbortError';
        const touched = new Set((aside.current?.songs ?? []).map((a) => folderBaseOf(a.folder).toLowerCase())).size;
        const message = aborted
          ? touched
            ? `Stopped by hand after ${touched === 1 ? 'one song' : `${touched} songs`} had been written over.`
            : 'Stopped by hand before anything was written.'
          : err instanceof Error ? err.message : String(err);
        note({ kind: aborted ? 'stopped' : 'error', session: setName, text: message });
        setPhase({
          kind: 'error',
          at,
          message: aborted
            ? touched
              ? `Stopped. ${touched === 1 ? 'One song' : `${touched} songs`} had been written over — undo puts ${touched === 1 ? 'it' : 'them'} back; the next save, or a prepare, writes the rest.`
              : 'Stopped before any song was written — the folder is as it was, so there is nothing to undo.'
            : err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (stopper.current === controller) stopper.current = null;
      }
    })();
    // A newer save while this runs is answered once the run has ended: the
    // store holds it back until then, so nothing here need cancel anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSaved, currentSet, auto.stems, auto.submixes, auto.info, phase?.kind]);

  const dismiss = () => {
    setPhase(null);
    dismissSetSaved();
  };

  /** Put back what the last run wrote over, and remove what it added. */
  const undo = async () => {
    const last = aside.current;
    if (!last || !phase) return;
    const at = phase.at;
    setPhase({ kind: 'running', at, stage: 'Putting the songs back as they were…', progress: null });
    try {
      const band = await publishFolder();
      if (!band) throw new Error("The band's folder is not to hand.");
      const put = await undoPrepare(band, last.folder, last.songs);
      aside.current = null;
      note({
        kind: 'undone',
        session: setName,
        set: last.folder,
        text: `Undone: ${put.restored} song${put.restored === 1 ? '' : 's'} put back${put.removed ? `, ${put.removed} removed` : ''}. The band sees ${put.published.songs}.`,
      });
      setPhase({ kind: 'undone', at, restored: put.restored, removed: put.removed, songs: put.published.songs });
    } catch (err) {
      setPhase({ kind: 'error', at, message: `Could not undo: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const undoable = !!aside.current?.songs.length && (phase?.kind === 'done' || phase?.kind === 'error');

  if (!phase || !currentSet) return null;

  const running = phase.kind === 'running';
  const pct = running && phase.progress ? Math.round(overallProgress(phase.progress) * 100) : null;
  const p = running ? phase.progress : null;

  return (
    <>
      <div
        className={`notice spread${phase.kind === 'done' ? ' done' : phase.kind === 'error' ? ' error' : ''}`}
        role="status"
        style={{ margin: 0, borderRadius: 0, alignItems: 'center' }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          {phase.kind === 'saved' && (
            <>
              <strong>{setName}</strong> was saved at {clock(phase.at)} — the prepared set may be behind it.
            </>
          )}
          {running && (
            <>
              <strong>Updating the prepared set</strong> after the save at {clock(phase.at)}
              {p
                ? ` — ${p.songTitle} · ${p.partName}, ${p.stage}${
                    p.stage === 'shifting' || p.stage === 'encoding' ? ` ${Math.round(p.ratio * 100)}%` : ''
                  } (song ${p.songIndex} of ${p.songCount})`
                : phase.stage
                  ? ` — ${phase.stage}`
                  : ''}
              {pct !== null && (
                <span className="progress" style={{ marginTop: 6 }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Updating">
                  <span className="progress-fill" style={{ width: `${pct}%` }} />
                  <span className="progress-text">{pct}%</span>
                </span>
              )}
            </>
          )}
          {phase.kind === 'done' && (
            <>
              <strong>Updated</strong> after the save at {clock(phase.at)} —{' '}
              {phase.outcome.result
                ? `${phase.outcome.result.songsWritten} song${phase.outcome.result.songsWritten === 1 ? '' : 's'} written again (${phase.selected.join(', ')})`
                : 'no audio had changed'}
              {phase.outcome.submixes?.songsWritten
                ? `; submixes written for ${phase.outcome.submixes.songsWritten} song${phase.outcome.submixes.songsWritten === 1 ? '' : 's'}`
                : ''}
              {phase.outcome.refreshed
                ? phase.outcome.refreshed.error
                  ? `; the rest could not be refreshed: ${phase.outcome.refreshed.error}`
                  : phase.outcome.refreshed.count
                    ? `; words and sections refreshed for ${phase.outcome.refreshed.count} song${phase.outcome.refreshed.count === 1 ? '' : 's'}` +
                      (phase.outcome.refreshed.count <= 4 ? ` (${phase.outcome.refreshed.songs.join(', ')})` : '')
                    : '; nothing else had changed'
                : ''}
              .{' '}
              {phase.outcome.published
                ? `The band sees ${phase.outcome.published.songs} song${phase.outcome.published.songs === 1 ? '' : 's'}.`
                : `The files are written, but the band's library could not be: ${phase.outcome.publishError}`}
              {phase.outcome.result && phase.outcome.result.skipped.length > 0 && (
                <> {phase.outcome.result.skipped.length} part{phase.outcome.result.skipped.length === 1 ? '' : 's'} skipped — {phase.outcome.result.skipped[0].part} in {phase.outcome.result.skipped[0].song}: {phase.outcome.result.skipped[0].reason}.</>
              )}
            </>
          )}
          {phase.kind === 'wholeSet' && (
            <>
              <strong>{setName}</strong> was saved at {clock(phase.at)}, but every one of its {phase.count} songs would be
              written again against “{phase.folder}” — none of them match what is there. Either that is not this set's
              folder, or something changed that every song is written from: the band's submixes, or how the studio
              renders. Not done on its own: locate the right folder in Settings, or prepare the whole set by hand.
            </>
          )}
          {phase.kind === 'nothing' && (
            <>
              <strong>{setName}</strong> was saved at {clock(phase.at)} — nothing the studio is set to keep up to date had
              changed{auto.stems && auto.submixes && auto.info ? '' : ' — of what is switched on here'}.
            </>
          )}
          {phase.kind === 'unprepared' && (
            <>
              <strong>{setName}</strong> was saved at {clock(phase.at)}, but it hasn't been prepared under the name “
              {safeSetName(setNameFor(currentSet)) || defaultSetName(currentSet)}” yet. Prepare it once; after that each save updates it.
            </>
          )}
          {phase.kind === 'error' && (
            <>
              <strong>The update after the save at {clock(phase.at)} didn't finish.</strong> {phase.message}
            </>
          )}
          {phase.kind === 'undone' && (
            <>
              <strong>Undone.</strong> {phase.restored} song{phase.restored === 1 ? '' : 's'} put back as{' '}
              {phase.restored === 1 ? 'it was' : 'they were'}
              {phase.removed ? `, ${phase.removed} the run had added removed` : ''}. The band sees {phase.songs} song
              {phase.songs === 1 ? '' : 's'}.
            </>
          )}
        </span>
        {undoable && (
          <button className="btn" onClick={() => void undo()} title="Put the songs this run wrote back as they were before it">
            Undo this update
          </button>
        )}
        {(phase.kind === 'saved' || phase.kind === 'nothing') && (
          <>
            <button className="btn primary" onClick={() => setDialog(true)}>
              Update the prepared set
            </button>
            {/*
              The three jobs, as switches rather than one. Turning one on here
              answers this save with it: the effect above takes a save still
              sitting in the bar as the one being asked about.
            */}
            <span className="auto-chips">
              <span className="control-label">On every save:</span>
              {AUTO_JOBS.map(({ key, label, hint }) => (
                <button
                  key={key}
                  className={auto[key] ? 'chip on' : 'chip'}
                  aria-pressed={auto[key]}
                  title={hint}
                  onClick={() => saveSettings({ autoUpdate: { ...auto, [key]: !auto[key] } })}
                >
                  {label}
                </button>
              ))}
            </span>
          </>
        )}
        {phase.kind === 'unprepared' && (
          <button className="btn primary" onClick={() => setDialog(true)}>
            Prepare it now
          </button>
        )}
        {phase.kind === 'wholeSet' && (
          <>
            <button className="btn primary" onClick={() => navigate('/settings')}>
              Locate the folder
            </button>
            <button className="btn" onClick={() => setDialog(true)}>
              Prepare by hand
            </button>
          </>
        )}
        {running ? (
          <button className="btn danger" onClick={() => stopper.current?.abort()} title="Stop. What is already written stays.">
            Stop
          </button>
        ) : (
          <button className="icon-btn" onClick={dismiss} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
      {dialog && (
        <PrepareSetDialog
          onClose={() => {
            setDialog(false);
            dismiss();
          }}
        />
      )}
    </>
  );
}
