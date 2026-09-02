import { useEffect, useState } from 'react';
import { useRoute, navigate } from './lib/router';
import { useStore } from './lib/store';
import LibraryView from './ui/LibraryView';
import PlayerView from './ui/PlayerView';
import SetlistsView from './ui/SetlistsView';
import SetlistView from './ui/SetlistView';
import SettingsView from './ui/SettingsView';
import Onboarding from './ui/Onboarding';
import ChooseSet from './ui/ChooseSet';
import SetToolsView from './ui/SetToolsView';

/**
 * Whether the studio's server is now serving a newer build than this page.
 *
 * The launcher rebuilds on every click, but an already-open window keeps
 * running whatever it loaded — so on focus the page asks the server which
 * build sits on disk and compares it to its own stamp. A mismatch becomes a
 * banner rather than a silent reload: reloading under someone mid-edit is
 * its own kind of unreliability.
 */
function useNewerBuild(): string | null {
  const [newer, setNewer] = useState<string | null>(null);
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/__rehearsal-studio', { signal: AbortSignal.timeout(2000) });
        const info = await res.json();
        // What the server *is*, not what sits on disk: a rebuilt bundle behind
        // a server still running old code is not a newer studio yet.
        const running = info.server ?? info.build;
        if (running && running !== __BUILD__) setNewer(running);
      } catch {
        // The dev server has no such route; there is nothing to say.
      }
    };
    void check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);
  return newer;
}

export default function App() {
  const route = useRoute();
  const { settings, localStatus, currentSet, sets, chooseSet, resourcesFolderName } = useStore();
  const newerBuild = useNewerBuild();
  const usingLocalFolder = settings.useLocal && localStatus === 'ready';
  const section = route.path[0] ?? 'library';

  const songId = route.query.get('id') ?? route.path[1];

  let body: JSX.Element;
  if (section === 'song' && songId) {
    // Keyed on the resources folder: granting one is what makes the outside
    // samples readable, and the song is opened again to pick them up.
    body = <PlayerView key={resourcesFolderName ?? ''} songId={songId} setlistId={route.query.get('sl')} />;
    // Set tools work on a lone .als with no folder at all, so they stay
    // reachable before a folder is chosen — as Settings always has.
  } else if (!usingLocalFolder && section !== 'settings' && section !== 'tools') {
    body = <Onboarding />;
    // Everything is about one set, so a launch chooses it before anything else.
  } else if (usingLocalFolder && !currentSet && section !== 'settings') {
    body = <ChooseSet />;
  } else if (section === 'setlists') {
    body = <SetlistsView />;
  } else if (section === 'setlist' && (route.query.get('id') ?? route.path[1])) {
    // Query first, path second: a set's setlist is named after a file path and
    // can't sit in a path segment. Links made before that still work.
    body = <SetlistView setlistId={route.query.get('id') ?? route.path[1]} />;
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
  return (
    <div className="app">
      {newerBuild && (
        <div
          className="notice"
          style={{ display: 'flex', gap: 12, alignItems: 'center', margin: 0, borderRadius: 0 }}
        >
          <span style={{ flex: 1 }}>
            A newer build ({newerBuild}) is ready — this window is showing {__BUILD__}.
          </span>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
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
            Set: <strong>{sets.find((s) => s.path === currentSet)?.name ?? currentSet.split('/').pop()}</strong>
          </span>
          <button className="chip" onClick={() => chooseSet(null)}>
            Change set
          </button>
        </div>
      )}
      <div className="app-body">{body}</div>
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
