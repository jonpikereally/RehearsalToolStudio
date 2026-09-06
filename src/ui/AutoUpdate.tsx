import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { parseAls } from '../lib/alsParser';
import { readBytes } from '../lib/source';
import { overallProgress, type PrepareProgress } from '../lib/prepare';
import { runPrepare, standingFor, titlesOf, type RunOutcome } from '../lib/prepareRun';
import { defaultSetName, safeSetName, setNameFor } from '../lib/setName';
import { runningOrderTitles } from '../lib/ableset';
import PrepareSetDialog from './PrepareSetDialog';

/**
 * Keeping the prepared set current with the set as Live saves it.
 *
 * The studio sits beside Live; the store notices each save and reads the
 * folder again. This is what happens next. With auto-update on, the songs
 * whose audio changed are prepared again and the rest get their words and
 * sections refreshed, with nobody at a dialog — a bar says what is being
 * written and what was. With it off, the bar says the set was saved and
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
  | { kind: 'error'; at: number; message: string };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function AutoUpdate() {
  const { currentSet, setSaved, dismissSetSaved, settings, saveSettings, publishFolder, library } = useStore();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [dialog, setDialog] = useState(false);
  /** The save being acted on, so a newer one is not answered twice and an older run's news is dropped. */
  const acting = useRef<number | null>(null);
  const stopper = useRef<AbortController | null>(null);
  const libraryRef = useRef(library);
  libraryRef.current = library;

  const setName = currentSet?.split('/').pop()?.replace(/\.als$/i, '') ?? 'The set';

  useEffect(() => {
    if (!setSaved || !currentSet || setSaved.path !== currentSet) return;
    const at = setSaved.at;
    // Once per save — except that turning auto-update on while a save waits
    // in the bar is the answer to that save, and it goes ahead now.
    if (acting.current === at && !(settings.autoUpdate && phase?.kind === 'saved')) return;
    acting.current = at;
    if (!settings.autoUpdate) {
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
        const folderName = safeSetName(setNameFor(currentSet)) || defaultSetName(currentSet);
        if (current()) setPhase({ kind: 'running', at, stage: 'Looking at what changed…', progress: null });
        const found = await standingFor(project, currentSet, band, folderName);
        if (!found.manifest) {
          if (current()) setPhase({ kind: 'unprepared', at });
          return;
        }
        const selected = titlesOf(project).filter((t) => found.standing.get(t)?.state !== 'unchanged');
        if (current()) setPhase({ kind: 'running', at, stage: selected.length ? '' : 'Refreshing words and sections…', progress: null });
        const outcome = await runPrepare({
          project,
          setPath: currentSet,
          band,
          folderName,
          selected,
          standing: found.standing,
          keys: found.keys,
          // The order as the scan just found it, AbleSet's log included.
          songOrder: runningOrderTitles(libraryRef.current, currentSet) ?? undefined,
          cacheBudgetGB: settings.cacheBudgetGB,
          signal: controller.signal,
          onProgress: (p) => current() && setPhase({ kind: 'running', at, stage: '', progress: p }),
        });
        if (current()) setPhase({ kind: 'done', at, outcome, selected });
      } catch (err) {
        if (!current()) return;
        const aborted = (err as { name?: string })?.name === 'AbortError';
        setPhase({
          kind: 'error',
          at,
          message: aborted
            ? 'Stopped. Songs already written are in the folder; the next save, or a prepare, writes the rest.'
            : err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (stopper.current === controller) stopper.current = null;
      }
    })();
    // A newer save while this runs is answered once the run has ended: the
    // store holds it back until then, so nothing here need cancel anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSaved, currentSet, settings.autoUpdate, phase?.kind]);

  const dismiss = () => {
    setPhase(null);
    dismissSetSaved();
  };

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
              {phase.outcome.refreshed
                ? phase.outcome.refreshed.error
                  ? `; the rest could not be refreshed: ${phase.outcome.refreshed.error}`
                  : `; words and sections refreshed for ${phase.outcome.refreshed.count} song${phase.outcome.refreshed.count === 1 ? '' : 's'}`
                : ''}
              . The band sees {phase.outcome.published.songs} song{phase.outcome.published.songs === 1 ? '' : 's'}.
              {phase.outcome.result && phase.outcome.result.skipped.length > 0 && (
                <> {phase.outcome.result.skipped.length} part{phase.outcome.result.skipped.length === 1 ? '' : 's'} skipped — {phase.outcome.result.skipped[0].part} in {phase.outcome.result.skipped[0].song}: {phase.outcome.result.skipped[0].reason}.</>
              )}
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
        </span>
        {phase.kind === 'saved' && (
          <>
            <button className="btn primary" onClick={() => setDialog(true)}>
              Update the prepared set
            </button>
            <button className="btn" onClick={() => saveSettings({ autoUpdate: true })} title="From now on, every save of the set updates the prepared set on its own">
              Auto-update from now on
            </button>
          </>
        )}
        {phase.kind === 'unprepared' && (
          <button className="btn primary" onClick={() => setDialog(true)}>
            Prepare it now
          </button>
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
