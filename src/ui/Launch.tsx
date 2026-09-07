import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { setToolsAlone } from '../lib/toolsAlone';
import * as local from '../lib/localSource';
import type { FolderSessions } from '../lib/localSource';
import { createOutputSet, outputSets, type OutputSet } from '../lib/locatePrepared';
import { recentOutput, recentSession, takeAsk } from '../lib/recent';
import { SETS_FOLDER } from '../lib/prints';
import { safeSetName } from '../lib/setName';

/**
 * The window a launch opens with: what goes out, and what comes in.
 *
 * The studio works between two places — a set folder in the band's Dropbox
 * that the phones read, and the Ableton session that fills it — and until it
 * knows both it can't say whether they are in step. So both are chosen here,
 * side by side, before the four tabs appear: the folder on the left, the
 * session on the right, and the pair opened together.
 *
 * The usual answer to both is “the same as last time”, so each side offers
 * what it opened last as its first button, and can be told to take it without
 * asking. Told that on both sides, this window is skipped entirely — File ▸
 * Open (⌘N) brings it back, and always asks when it is asked for.
 */

const asPath = (dir: string, name: string) => `${dir}/${name}`;
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Copies the studio's own tools wrote: sessions to open, not sets of yours. */
const isStudioCopy = (name: string) => /( \((slates|chords|info|rig|lyrics|rehearsaltool)\)| Lyrics)\.als$/i.test(name);

export default function Launch() {
  const { settings, saveSettings, publishFolderName, publishFolder, pickPublishFolder, chooseOutput, openSession, sessionPath } =
    useStore();

  /* What is chosen so far, on each side. Nothing is opened until both are. */
  const [output, setOutput] = useState<OutputSet | null>(null);
  const [session, setSession] = useState<string | null>(null);

  const [sets, setSets] = useState<OutputSet[] | null>(null);
  const [folder, setFolder] = useState<FolderSessions | null>(null);
  const [listing, setListing] = useState(false);
  const [outError, setOutError] = useState<string | null>(null);
  const [inError, setInError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [making, setMaking] = useState(false);
  const [newName, setNewName] = useState('');

  /* Asked for from the menu, this window always asks, whatever the settings say. */
  const [ask] = useState(takeAsk);
  const auto = useRef(false);

  const remembered = useRef<{ output: OutputSet | null; session: string | null }>({
    output: recentOutput(),
    session: recentSession(),
  });

  /** The set folders in the band's folder, and which of them was last worked in. */
  const loadSets = useCallback(async () => {
    setOutError(null);
    try {
      const band = await publishFolder();
      if (!band) {
        setSets([]);
        return;
      }
      setSets(await outputSets(band));
    } catch (err) {
      setOutError(err instanceof Error ? err.message : String(err));
      setSets([]);
    }
  }, [publishFolder]);

  useEffect(() => {
    void loadSets();
  }, [loadSets, publishFolderName]);

  /** The sessions sitting beside one: the folder's other saves and sets. */
  const loadFolder = useCallback(async (dir: string) => {
    setListing(true);
    try {
      const found = await local.sessionsIn(dir);
      setFolder({ ...found, files: found.files.filter((f) => !isStudioCopy(f.name)) });
      return found;
    } finally {
      setListing(false);
    }
  }, []);

  /* The folder to offer sessions from: the one in hand, else the last opened. */
  useEffect(() => {
    const start = session ?? sessionPath ?? remembered.current.session;
    if (!start) {
      void local
        .sessionsInStored('songs')
        .then((found) => found && setFolder({ ...found, files: found.files.filter((f) => !isStudioCopy(f.name)) }))
        .catch(() => undefined);
      return;
    }
    if (folder && dirOf(start) === folder.dir) return;
    void loadFolder(dirOf(start)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessionPath, loadFolder]);

  /** Open the pair: the folder is set first, and handed to the session too. */
  const openBoth = useCallback(
    async (set: OutputSet, alsPath: string) => {
      setOpening(nameOf(alsPath));
      setInError(null);
      try {
        // Remembered by the open itself, once it has worked: a folder that
        // could not be opened is not the folder to offer first next time.
        chooseOutput(set);
        await openSession(alsPath, set);
      } catch (err) {
        setInError(`${nameOf(alsPath)} could not be opened: ${err instanceof Error ? err.message : String(err)}`);
        setOpening(null);
      }
    },
    [chooseOutput, openSession],
  );

  /*
   * Both sides told to take what they had last, and both still there: open
   * them and let the studio come up where it left off. Once per window, and
   * never when this window was asked for on purpose.
   */
  const recentSet = remembered.current.output
    ? (sets?.find((s) => s.folder === remembered.current.output!.folder) ?? remembered.current.output)
    : (sets?.[0] ?? null);
  const recentAls = remembered.current.session ?? recentSet?.session ?? null;

  useEffect(() => {
    if (ask || auto.current || sets === null || opening) return;
    if (!settings.alwaysRecentOutput && !settings.alwaysRecentSession) return;
    const set = settings.alwaysRecentOutput ? recentSet : null;
    const als = settings.alwaysRecentSession ? recentAls : null;
    if (set && !output) setOutput(set);
    if (als && !session) setSession(als);
    if (settings.alwaysRecentOutput && settings.alwaysRecentSession && set && als) {
      auto.current = true;
      void openBoth(set, als);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, sets, settings.alwaysRecentOutput, settings.alwaysRecentSession, recentSet, recentAls, opening]);

  /** Choosing a folder offers the session it remembers, when none is chosen yet. */
  const takeOutput = (set: OutputSet) => {
    setOutput(set);
    setChoosing(false);
    setMaking(false);
    if (!session && set.session) setSession(set.session);
  };

  const pickAls = async () => {
    setInError(null);
    try {
      const picked = await local.pickFilePath({
        description: 'the Ableton session the prepared files are made from',
        extensions: ['als'],
      });
      const path = asPath(picked.dir, picked.name);
      setSession(path);
      await loadFolder(picked.dir).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setInError(message);
    }
  };

  const makeFolder = async () => {
    if (!session) return;
    setOutError(null);
    try {
      const band = (await publishFolder()) ?? (await pickPublishFolder());
      const made = await createOutputSet(band, newName, session);
      setMaking(false);
      setNewName('');
      await loadSets();
      takeOutput(made);
    } catch (err) {
      setOutError(err instanceof Error ? err.message : String(err));
    }
  };

  const changeBand = async () => {
    setOutError(null);
    try {
      await pickPublishFolder();
      setOutput(null);
      await loadSets();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setOutError(message);
    }
  };

  const when = (iso?: string) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  };
  const describe = (set: OutputSet) =>
    [
      set.songs ? `${set.songs} song${set.songs === 1 ? '' : 's'}` : 'nothing prepared yet',
      when(set.preparedAt) ? `prepared ${when(set.preparedAt)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  if (opening) {
    return (
      <>
        <div className="topbar">
          <h1>Opening</h1>
        </div>
        <div className="empty">
          <h2>{output?.name ?? 'The set'}</h2>
          <p>Reading {opening} and everything it names…</p>
        </div>
      </>
    );
  }

  const ready = !!output && !!session;

  return (
    <>
      <div className="topbar">
        <h1>
          Open a set
          <span className="sub" style={{ display: 'block' }}>
            where the prepared files go, and the Ableton session they are made from
          </span>
        </h1>
        <button className="icon-btn" onClick={() => void loadSets()} disabled={sets === null} title="Look again">
          ⟳
        </button>
      </div>

      <div className="launch">
        {/* ------------------------------ output ------------------------------ */}
        <section className="launch-card">
          <header>
            <span className="launch-step">Output</span>
            <h3>The band’s set folder</h3>
            <p>The folder in {publishFolderName ? `“${publishFolderName}”` : 'the band’s folder'} the phones read. Everything prepared lands here.</p>
          </header>

          {outError && <div className="notice error">{outError}</div>}

          {recentSet ? (
            <button
              className={output?.folder === recentSet.folder ? 'launch-pick on' : 'launch-pick'}
              onClick={() => takeOutput(recentSet)}
            >
              <span className="launch-pick-title">{recentSet.name}</span>
              <span className="launch-pick-sub">
                {remembered.current.output ? 'last opened' : 'most recently prepared'} · {describe(recentSet)}
              </span>
            </button>
          ) : (
            <div className="notice quiet">{sets === null ? 'Looking in the band’s folder…' : 'No set folders yet — make the first one.'}</div>
          )}

          {output && output.folder !== recentSet?.folder && (
            <button className="launch-pick on" onClick={() => takeOutput(output)}>
              <span className="launch-pick-title">{output.name}</span>
              <span className="launch-pick-sub">{describe(output)}</span>
            </button>
          )}

          <label className="switch-row">
            <input
              type="checkbox"
              checked={settings.alwaysRecentOutput}
              onChange={(e) => saveSettings({ alwaysRecentOutput: e.target.checked })}
            />
            <span>
              Always open the most recent output folder
              <span className="hint">Don’t ask for it again — File ▸ Open still brings this window back.</span>
            </span>
          </label>

          <div className="btn-row">
            <button className="btn" onClick={() => { setChoosing((c) => !c); setMaking(false); }} disabled={sets === null}>
              {choosing ? 'Never mind' : 'Choose another folder…'}
            </button>
            <button className="btn" onClick={() => { setMaking((m) => !m); setChoosing(false); if (!newName && session) setNewName(nameOf(session).replace(/\.als$/i, '')); }}>
              {making ? 'Never mind' : 'New output folder…'}
            </button>
          </div>

          {making && (
            <div className="launch-sub">
              <div className="field stacked">
                <label htmlFor="new-set-name">
                  Call the folder
                  <span className="hint">
                    Made under {SETS_FOLDER}/, fed by {session ? nameOf(session) : 'the session chosen on the right'}.
                  </span>
                </label>
                <div className="btn-row">
                  <input
                    id="new-set-name"
                    className="text-input"
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Friday at the Dock"
                    style={{ minWidth: 200 }}
                  />
                  <button className="btn primary" onClick={() => void makeFolder()} disabled={!session || !safeSetName(newName)}>
                    Make it
                  </button>
                </div>
              </div>
            </div>
          )}

          {choosing && (
            <div className="launch-list">
              {sets?.length ? (
                sets.map((set) => (
                  <button
                    key={set.folder}
                    className={output?.folder === set.folder ? 'row on' : 'row'}
                    onClick={() => takeOutput(set)}
                  >
                    <div className="row-main">
                      <div className="row-title">{set.name}</div>
                      <div className="row-sub">
                        {describe(set)}
                        {set.session ? ` · from ${nameOf(set.session)}` : ' · no session named yet'}
                      </div>
                    </div>
                    <div className="row-right">›</div>
                  </button>
                ))
              ) : (
                <div className="notice quiet">Nothing under {SETS_FOLDER}/ yet.</div>
              )}
            </div>
          )}

          <button className="linky" onClick={() => void changeBand()}>
            {publishFolderName ? `Band’s folder: ${publishFolderName} — change…` : 'Choose the band’s folder…'}
          </button>
        </section>

        {/* ------------------------------- input ------------------------------ */}
        <section className="launch-card">
          <header>
            <span className="launch-step">Input</span>
            <h3>The Ableton session</h3>
            <p>The .als the set is made from. Its own folder is where the stems are read.</p>
          </header>

          {inError && <div className="notice error">{inError}</div>}

          {recentAls ? (
            <button className={session === recentAls ? 'launch-pick on' : 'launch-pick'} onClick={() => setSession(recentAls)}>
              <span className="launch-pick-title">{nameOf(recentAls)}</span>
              <span className="launch-pick-sub">
                {remembered.current.session === recentAls ? 'last opened' : 'what this folder was prepared from'} · in {nameOf(dirOf(recentAls))}
              </span>
            </button>
          ) : (
            <div className="notice quiet">No session opened yet — choose the .als below.</div>
          )}

          <label className="switch-row">
            <input
              type="checkbox"
              checked={settings.alwaysRecentSession}
              onChange={(e) => saveSettings({ alwaysRecentSession: e.target.checked })}
            />
            <span>
              Always open the most recent Ableton set
              <span className="hint">With the folder above set the same way, the studio opens straight into the tabs.</span>
            </span>
          </label>

          <div className="field stacked">
            <label htmlFor="launch-session">
              Sessions in {folder ? `“${folder.name}”` : 'the current folder'}
              <span className="hint">
                {listing
                  ? 'Looking…'
                  : folder?.files.length
                    ? 'An older save, or another set kept beside it.'
                    : 'Nothing to choose from until a folder has been opened.'}
              </span>
            </label>
            <select
              id="launch-session"
              className="jump-select"
              value={session && folder && dirOf(session) === folder.dir ? nameOf(session) : ''}
              onChange={(e) => e.target.value && folder && setSession(asPath(folder.dir, e.target.value))}
              disabled={!folder?.files.length}
            >
              <option value="">{folder?.files.length ? 'Choose a session…' : 'No sessions in this folder'}</option>
              {folder?.files.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>

          <div className="btn-row">
            <button className="btn" onClick={() => void pickAls()}>
              Choose a different Ableton folder…
            </button>
          </div>

          <button
            className="linky"
            onClick={() => {
              setToolsAlone(true);
              navigate('/tools');
            }}
          >
            Just use the tools, without the band’s files
          </button>
        </section>
      </div>

      <div className="launch-go">
        <span>
          {ready ? (
            <>
              <strong>{output!.name}</strong> ← <strong>{nameOf(session!)}</strong>
            </>
          ) : output ? (
            'Now choose the Ableton session it is made from.'
          ) : session ? (
            'Now choose the folder the prepared files go into.'
          ) : (
            'Choose an output folder and an input session. You can also drop an .als on this window.'
          )}
        </span>
        <button className="btn primary" disabled={!ready} onClick={() => ready && void openBoth(output!, session!)}>
          Open
        </button>
      </div>

      <div style={{ height: 24 }} />
    </>
  );
}
