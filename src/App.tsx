import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoute, navigate, songUrl } from './lib/router';
import { closeRun, useRun } from './lib/run';
import { releaseReady } from './lib/songLoader';
import { useStore } from './lib/store';
import LibraryView from './ui/LibraryView';
import PlayerView from './ui/PlayerView';
import SetlistsView from './ui/SetlistsView';
import SetlistView from './ui/SetlistView';
import SettingsView from './ui/SettingsView';
import Onboarding from './ui/Onboarding';
import Launch from './ui/Launch';
import { toolsAlone, setToolsAlone } from './lib/toolsAlone';
import { alwaysOpen, askForFiles, recentOutput, recentSession, takeAsk } from './lib/recent';
import { panelWindow, showChanges, showChooser, whenAppKnown } from './lib/appWindow';
import type { OutputSet } from './lib/locatePrepared';
import SetToolsView from './ui/SetToolsView';
import ChangesView from './ui/ChangesView';
import AutoUpdate from './ui/AutoUpdate';

/**
 * Whether the studio has moved on from what this window is running.
 *
 * Two ways it can, and they want different answers. A newer bundle on disk is
 * one reload away, so the banner offers the reload — never taking it, since
 * reloading under somebody mid-edit is its own kind of unreliability. A
 * server still running the code it started with is not: the page is already
 * current and reloading it changes nothing, which is what a Reload button
 * that appeared to do nothing used to mean. That one is fixed by quitting and
 * opening the app again, and the banner says so instead of offering a button
 * that cannot help.
 */
type Behind = { build: string; kind: 'page' | 'server' };

function useNewerBuild(): Behind | null {
  const [behind, setBehind] = useState<Behind | null>(null);
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/__rehearsal-studio', { signal: AbortSignal.timeout(2000) });
        const info = await res.json();
        // `build` is what sits on disk; `server` is what this server is.
        if (info.build && info.build !== __BUILD__) setBehind({ build: info.build, kind: 'page' });
        else if (info.server && info.server !== __BUILD__) setBehind({ build: info.server, kind: 'server' });
        else setBehind(null);
      } catch {
        // The dev server has no such route; there is nothing to say.
      }
    };
    void check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);
  return behind;
}

/**
 * A folder or a set dropped on the window, or on the Dock icon.
 *
 * The Mac app takes the drop before WebKit can make a page of the file, and
 * hands the paths to this window as an event; it says when a drag is over
 * the window too, so the page can show it is a place to drop. A drop the app
 * did not take — in a plain browser — has no path a server could open, and
 * is only stopped from loading the file as a page.
 */
function useDropped(open: (path: string) => Promise<void>): { over: boolean; error: string | null; clear: () => void } {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const paths = (e as CustomEvent<{ paths?: string[] }>).detail?.paths ?? [];
      if (!paths.length) return;
      setError(null);
      open(paths[0]).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    };
    const onDrag = (e: Event) => setOver(!!(e as CustomEvent<{ over?: boolean }>).detail?.over);
    const swallow = (e: DragEvent) => e.preventDefault();
    window.addEventListener('studio:open', onOpen);
    window.addEventListener('studio:drag', onDrag);
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    // The page is up: anything dropped while it was starting can come now.
    const handlers = (window as unknown as { webkit?: { messageHandlers?: Record<string, { postMessage(m: unknown): void }> } })
      .webkit?.messageHandlers;
    try {
      handlers?.studio?.postMessage({ ready: true });
    } catch {
      /* not the Mac app, then */
    }
    return () => {
      window.removeEventListener('studio:open', onOpen);
      window.removeEventListener('studio:drag', onDrag);
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, [open]);
  return { over, error, clear: () => setError(null) };
}

/**
 * File ▸ Open, and ⌘O with it: put the choosing window back up.
 *
 * The Mac app's menu sends an event; the key is caught here as well, for a
 * window with no menu bar of its own — a browser looking at the dev server.
 * Asking on purpose always asks, even when both sides are set to open what
 * they had last, so `askForFiles` is what the chooser reads.
 */
function useOpenMenu(reopen: () => void) {
  useEffect(() => {
    const onMenu = (e: Event) => {
      if ((e as CustomEvent<{ item?: string }>).detail?.item === 'open') reopen();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'o' || e.key.toLowerCase() === 'n')) {
        e.preventDefault();
        reopen();
      }
    };
    window.addEventListener('studio:menu', onMenu);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('studio:menu', onMenu);
      window.removeEventListener('keydown', onKey);
    };
  }, [reopen]);
}

/**
 * What happens when nothing is open.
 *
 * Both sides set to take what they had last, and both still remembered: open
 * that pair and say nothing. Otherwise the chooser — its own small window in
 * the Mac app, this page in a browser. Asked for on purpose, it always asks.
 */
function useOpenGate(
  needed: boolean,
  open: (alsPath: string, into: OutputSet) => Promise<void>,
): { opening: boolean; inWindow: boolean } {
  const [opening, setOpening] = useState(false);
  const [inWindow, setInWindow] = useState(false);
  const settled = useRef(false);
  useEffect(() => {
    if (!needed) {
      settled.current = false;
      setInWindow(false);
      return;
    }
    if (settled.current) return;
    settled.current = true;
    const asked = takeAsk();
    const always = alwaysOpen();
    const set = recentOutput();
    const als = recentSession() ?? set?.session ?? null;
    // Whether the chooser is a window of its own is the app's to say, and it
    // says so as the page loads — so this waits for the answer rather than
    // asking before it has come and drawing the chooser here for nothing.
    const chooser = () => void whenAppKnown().then(() => setInWindow(showChooser()));
    if (asked || !always.output || !always.session || !set || !als) {
      chooser();
      return;
    }
    setOpening(true);
    open(als, set)
      .catch(() => chooser())
      .finally(() => setOpening(false));
  }, [needed, open]);
  return { opening, inWindow };
}

export default function App() {
  const route = useRoute();
  const { settings, localStatus, currentSet, sets, chooseSet, chooseOutput, outputSet, sessionPath, publishFolderName, resourceFolders, library, openDropped, openSession, watching } = useStore();
  const drop = useDropped(openDropped);
  /*
   * Back to the chooser. In the Mac app it is a window in front of what is
   * open, so nothing is let go of until something else is chosen; in a
   * browser there is only this page, so the set is put down to make room.
   */
  const reopen = useCallback(() => {
    askForFiles();
    if (showChooser()) return;
    setToolsAlone(false);
    chooseSet(null);
    chooseOutput(null);
    navigate('/');
  }, [chooseSet, chooseOutput]);
  useOpenMenu(reopen);

  /*
   * What the chooser window chose, and its way past itself. The chooser has
   * closed by the time this runs, so this window says what is happening —
   * and says so when it doesn't work, rather than sitting there.
   */
  const [taking, setTaking] = useState<string | null>(null);
  const [takeError, setTakeError] = useState<string | null>(null);
  const takeChosen = useCallback(
    async (alsPath: string, into: OutputSet) => {
      setToolsAlone(false);
      setTakeError(null);
      setTaking(alsPath.split('/').pop() ?? alsPath);
      try {
        chooseOutput(into);
        await openSession(alsPath, into);
      } catch (err) {
        setTakeError(`${alsPath.split('/').pop()} could not be opened: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      } finally {
        setTaking(null);
      }
    },
    [chooseOutput, openSession],
  );
  useEffect(() => {
    const onChose = (e: Event) => {
      const detail = (e as CustomEvent<{ set?: OutputSet; session?: string }>).detail;
      if (!detail?.set || !detail.session) return;
      void takeChosen(detail.session, detail.set);
    };
    const onTools = () => {
      setToolsAlone(true);
      navigate('/tools');
    };
    window.addEventListener('studio:chose', onChose);
    window.addEventListener('studio:tools', onTools);
    return () => {
      window.removeEventListener('studio:chose', onChose);
      window.removeEventListener('studio:tools', onTools);
    };
  }, [takeChosen]);
  const newerBuild = useNewerBuild();
  const run = useRun();
  const usingLocalFolder = settings.useLocal && localStatus === 'ready';
  const section = route.path[0] ?? 'library';

  const songId = route.query.get('id') ?? route.path[1];
  const setlistId = route.query.get('sl');

  /*
   * A song stays loaded behind Settings. Opening Settings used to unmount the
   * player and with it the song — every stem decoded again on the way back —
   * so the player is held, hidden, while Settings is up, and let go only when
   * the page goes somewhere else. Held at a fixed place in the tree, so React
   * keeps the same instance rather than making a new one.
   */
  const [held, setHeld] = useState<{ songId: string; setlistId: string | null } | null>(null);
  useEffect(() => {
    if (section === 'song' && songId) setHeld({ songId, setlistId });
    else if (section !== 'settings') setHeld(null);
  }, [section, songId, setlistId]);
  const playing = section === 'song' && songId ? { songId, setlistId } : section === 'settings' ? held : null;
  const heldSong = section === 'settings' && held ? library.songs.find((s) => s.id === held.songId) : undefined;

  /*
   * A launch goes: the band's folder once, then the choosing window — the set
   * folder that is filled and the session that fills it, together — and the
   * four tabs once both are open. Settings is always reachable, and the set
   * tools without a set when the chooser was skipped for the tools that need
   * none.
   */
  const aside = section === 'settings' || section === 'changes' || (section === 'tools' && toolsAlone());
  const needsChoosing = !aside && !!publishFolderName && (!outputSet || !usingLocalFolder || !currentSet);
  const gate = useOpenGate(needsChoosing, takeChosen);
  let body: JSX.Element | null;
  if (section === 'song' && songId) {
    body = null;
  } else if (!aside && !publishFolderName) {
    body = <Onboarding />;
  } else if (needsChoosing) {
    /*
     * The chooser is its own window in the Mac app, so this one says what is
     * happening and how to get that window back rather than asking again
     * itself. In a browser there is no other window, so it asks here.
     */
    body =
      taking || gate.opening ? (
        <div className="launch-busy">
          <h2>Opening {taking ?? 'what was open last'}</h2>
          <p>Reading the session and everything it names…</p>
        </div>
      ) : gate.inWindow ? (
        <div className="launch-busy">
          <h2>Choosing what to open</h2>
          {takeError ? (
            <div className="notice error">{takeError}</div>
          ) : (
            <p>The Open window is in front. Choose an Ableton session and the folder it fills.</p>
          )}
          <button className="btn primary" onClick={() => showChooser()}>
            Show the Open window
          </button>
        </div>
      ) : (
        <Launch />
      );
  } else if (section === 'setlists') {
    body = <SetlistsView />;
  } else if (section === 'setlist' && (route.query.get('id') ?? route.path[1])) {
    // Query first, path second: a set's setlist is named after a file path and
    // can't sit in a path segment. Links made before that still work.
    body = <SetlistView setlistId={route.query.get('id') ?? route.path[1]} />;
  } else if (section === 'changes') {
    body = <ChangesView />;
  } else if (section === 'tools') {
    body = <SetToolsView />;
  } else if (section === 'settings') {
    body = <SettingsView />;
  } else {
    body = <LibraryView />;
  }

  /*
   * The bar sits above everything, on every page, the player included.
   *
   * It used to be along the bottom and absent from the player, on the grounds
   * that the transport should have the screen to itself. Being able to see
   * where you are — and get back — turns out to matter more, and at the top it
   * is nowhere near the controls you reach for while playing.
   */
  /*
   * A small window of its own: the chooser, or the log of what has been done.
   * Only what it is for — no tabs, no set bar, no update bar — since the
   * studio's own window is behind it doing all of that.
   */
  const panel = panelWindow();
  if (panel) {
    return (
      <div className="app chooser-window">
        {panel === 'chooser' ? (
          <>
            <div className="topbar">
              <h1>
                Open a set
                <span className="sub" style={{ display: 'block' }}>
                  an Ableton session, and the folder it fills
                </span>
              </h1>
            </div>
            <div className="app-body">
              <Launch />
            </div>
          </>
        ) : (
          <div className="app-body">
            <ChangesView />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      {newerBuild && (
        <div
          className="notice"
          style={{ display: 'flex', gap: 12, alignItems: 'center', margin: 0, borderRadius: 0 }}
        >
          <span style={{ flex: 1 }}>
            {newerBuild.kind === 'page' ? (
              <>
                A newer build ({newerBuild.build}) is ready — this window is showing {__BUILD__}.
              </>
            ) : (
              <>
                This window is showing the newest build ({__BUILD__}), but the studio’s own server is still the one it
                started with ({newerBuild.build}) — so anything new it does with the disk isn’t there yet. Quit and open
                the app again to pick it up.
              </>
            )}
          </span>
          {newerBuild.kind === 'page' && (
            <button className="btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
        </div>
      )}
      {drop.over && (
        <div className="drop-veil" aria-hidden="true">
          <span>Drop to open</span>
        </div>
      )}
      {drop.error && (
        <div className="notice error spread" style={{ margin: 0, borderRadius: 0 }}>
          <span>{drop.error}</span>
          <button className="icon-btn" onClick={drop.clear} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <nav className="tabbar">
        <TabButton on={section === 'library'} to="/" glyph="♪" label="Songs" />
        <TabButton on={section.startsWith('setlist')} to="/setlists" glyph="≡" label="Setlists" />
        <TabButton on={section === 'tools'} to="/tools" glyph="⚒" label="Set tools" />
        <TabButton on={section === 'settings'} to="/settings" glyph="⚙" label="Settings" />
      </nav>
      {currentSet && section !== 'song' && (
        <div className="setbar">
          <span>
            Set: <strong>{outputSet?.name ?? sets.find((s) => s.path === currentSet)?.name ?? currentSet.split('/').pop()}</strong>
            {outputSet && (
              <span style={{ color: 'var(--text-dim)' }}>
                {' '}← {(sessionPath ?? currentSet).split('/').pop()}
              </span>
            )}
            {/* The watch on the set, so nobody wonders whether a save will be noticed. */}
            {watching && (
              <span
                className={`watch${watching.paused ? ' paused' : watching.live ? ' live' : ''}`}
                title={
                  watching.paused
                    ? 'The set is looked at every few seconds for a save by Live; paused while a scan or a prepare runs.'
                    : watching.live
                      ? 'Live is running. The set is looked at every few seconds, and a save is picked up within about ten.'
                      : 'Live is not running right now. The set is still looked at every few seconds, in case it is opened.'
                }
              >
                <span className="watch-dot" aria-hidden="true" />
                {watching.paused
                  ? 'watch paused while working'
                  : watching.live
                    ? 'Live is open — watching for saves'
                    : 'Live not open — watching for saves'}
              </span>
            )}
          </span>
          <button
            className="chip"
            onClick={() => {
              // Its own window in the Mac app; a page of its own in a browser.
              if (!showChanges()) navigate('/changes');
            }}
            title="Every save, and what the studio made of it"
          >
            Changes…
          </button>
        </div>
      )}
      {/* Live saved the set: what is being done about it, wherever you are. */}
      <AutoUpdate />
      {/*
        A run is held in memory and governs Previous and Next, so it says so
        wherever you are — state that changes what buttons do should never be
        invisible. Not in the player, where the song count already says it, nor
        behind Settings, where the bar below is already offering the way back.
      */}
      {run.songIds.length > 0 && section !== 'song' && !held && (
        <div className="setbar">
          <span>
            <strong>{run.songIds.length} songs</strong> open together
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              className="chip"
              onClick={() => navigate(songUrl(run.songIds[0], run.setlistId ?? undefined))}
            >
              Back to the first
            </button>
            <button
              className="chip"
              onClick={() => {
                closeRun();
                // The player isn't mounted to notice, so let the audio go here.
                releaseReady();
              }}
            >
              Close
            </button>
          </span>
        </div>
      )}
      {heldSong && (
        <div className="setbar">
          <span>
            Still loaded: <strong>{heldSong.title}</strong>
          </span>
          <button className="chip" onClick={() => navigate(songUrl(heldSong.id, held?.setlistId ?? undefined))}>
            Back to the song
          </button>
        </div>
      )}
      <div className="app-body">
        {playing && (
          // Keyed on the resources folder: granting one is what makes the outside
          // samples readable, and the song is opened again to pick them up.
          <div style={{ display: section === 'song' ? 'contents' : 'none' }}>
            <PlayerView
              key={resourceFolders.map((f) => f.dir).join('|')}
              songId={playing.songId}
              setlistId={playing.setlistId}
              shown={section === 'song'}
            />
          </div>
        )}
        {body}
      </div>
    </div>
  );
}

function TabButton({ on, to, glyph, label }: { on: boolean; to: string; glyph: string; label: string }) {
  return (
    <button className={on ? 'on' : ''} onClick={() => navigate(to)} aria-current={on ? 'page' : undefined}>
      <span className="glyph" aria-hidden>
        {glyph}
      </span>
      {label}
    </button>
  );
}
