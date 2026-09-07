import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { setToolsAlone } from '../lib/toolsAlone';
import * as local from '../lib/localSource';
import type { FolderSessions } from '../lib/localSource';
import { createOutputSet, outputSets, type OutputSet } from '../lib/locatePrepared';
import { alwaysOpen, recentOutput, recentSession, setAlwaysOpen, takeAsk } from '../lib/recent';
import { choosingNew, chooserChose, chooserWantsTools, isChooserWindow } from '../lib/appWindow';
import { SETS_FOLDER } from '../lib/prints';
import { safeSetName } from '../lib/setName';

/**
 * The window a launch opens with: what comes in, and where it goes out.
 *
 * The studio works between two places — an Ableton session, and a set folder
 * in the band's Dropbox that the phones read — and until it knows both it
 * can't say whether they are in step. So both are chosen here, side by side,
 * and opened together.
 *
 * The usual answer to both is “the same as last time”, so each side offers
 * what it opened last first, and can be told to take it without asking. In
 * the Mac app this is a small window of its own in front of the studio: what
 * it chooses is handed back to the window behind, and closing it changes
 * nothing. File ▸ Open (⌘O) puts it up; File ▸ New (⌘N) puts it up with the
 * new set folder already asked for.
 */

const asPath = (dir: string, name: string) => `${dir}/${name}`;
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Copies the studio's own tools wrote: sessions to open, not sets of yours. */
const isStudioCopy = (name: string) => /( \((slates|chords|info|rig|lyrics|rehearsaltool)\)| Lyrics)\.als$/i.test(name);

/** The one thing a side offers first, and what is on it once something is chosen. */
function Pick({ on, title, note, onClick }: { on: boolean; title: string; note: string; onClick: () => void }) {
  return (
    <button className={on ? 'launch-pick on' : 'launch-pick'} onClick={onClick}>
      <span className="launch-pick-title">{title}</span>
      <span className="launch-pick-sub">{note}</span>
    </button>
  );
}

export default function Launch() {
  const { publishFolderName, publishFolder, pickPublishFolder, chooseOutput, openSession, sessionPath } = useStore();

  /* What is chosen so far, on each side. Nothing is opened until both are. */
  const [output, setOutput] = useState<OutputSet | null>(null);
  const [session, setSession] = useState<string | null>(null);

  const [sets, setSets] = useState<OutputSet[] | null>(null);
  const [folder, setFolder] = useState<FolderSessions | null>(null);
  const [always, setAlways] = useState(alwaysOpen);
  const [outError, setOutError] = useState<string | null>(null);
  const [inError, setInError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // Opened by File ▸ New, the window arrives with the new folder asked for.
  const [making, setMaking] = useState(choosingNew);
  const [newName, setNewName] = useState('');

  /* Asked for on purpose, this window asks, whatever the switches say. */
  const [ask] = useState(takeAsk);
  const auto = useRef(false);
  const ownWindow = isChooserWindow();

  const remembered = useRef({ output: recentOutput(), session: recentSession() });

  /** The set folders in the band's folder, newest first. */
  const loadSets = useCallback(async () => {
    setOutError(null);
    try {
      const band = await publishFolder();
      setSets(band ? await outputSets(band) : []);
    } catch (err) {
      setOutError(err instanceof Error ? err.message : String(err));
      setSets([]);
    }
  }, [publishFolder]);

  useEffect(() => {
    void loadSets();
  }, [loadSets, publishFolderName]);

  /** The sessions sitting beside one: the folder's other saves and sets. */
  const loadFolder = useCallback(async (found: FolderSessions | null) => {
    if (found) setFolder({ ...found, files: found.files.filter((f) => !isStudioCopy(f.name)) });
  }, []);

  useEffect(() => {
    const start = session ?? sessionPath ?? remembered.current.session;
    if (!start) {
      void local.sessionsInStored('songs').then(loadFolder).catch(() => undefined);
      return;
    }
    if (folder && dirOf(start) === folder.dir) return;
    void local.sessionsIn(dirOf(start)).then(loadFolder).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessionPath, loadFolder]);

  /**
   * Open the pair. In its own window that means handing them to the studio
   * behind, which is the one holding the set; on its own it opens them here.
   */
  const openBoth = useCallback(
    async (set: OutputSet, alsPath: string) => {
      setOpening(nameOf(alsPath));
      setInError(null);
      // Its own window hands the pair to the studio behind and stops there.
      if (ownWindow && chooserChose({ set: { ...set }, session: alsPath })) return;
      try {
        chooseOutput(set);
        await openSession(alsPath, set);
      } catch (err) {
        setInError(`${nameOf(alsPath)} could not be opened: ${err instanceof Error ? err.message : String(err)}`);
        setOpening(null);
      }
    },
    [chooseOutput, openSession, ownWindow],
  );

  /* What each side offers first: what it opened last, else the likeliest. */
  const recentSet = remembered.current.output
    ? (sets?.find((s) => s.folder === remembered.current.output!.folder) ?? remembered.current.output)
    : (sets?.[0] ?? null);
  const recentAls = remembered.current.session ?? recentSet?.session ?? null;

  /*
   * What each side opened last is chosen as soon as it is known, not merely
   * offered: a window saying "opened last" on both sides and "not chosen"
   * along the bottom is a window arguing with itself, and Open is the whole
   * point of it. Choosing something else is a click either way.
   *
   * Told to take them without asking, and met on the way in rather than asked
   * for, it opens them too — in the Mac app the studio does that for itself
   * and this window never comes up at all.
   */
  useEffect(() => {
    if (auto.current || sets === null || opening) return;
    if (recentSet && !output) setOutput(recentSet);
    if (recentAls && !session) setSession(recentAls);
    if (ask || ownWindow || !always.output || !always.session || !recentSet || !recentAls) return;
    auto.current = true;
    void openBoth(recentSet, recentAls);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, sets, always, recentSet, recentAls, opening]);

  /* File ▸ New while this window is already up: ask for the new folder here. */
  useEffect(() => {
    const onNew = () => {
      setMaking(true);
      setChoosing(false);
    };
    window.addEventListener('studio:new', onNew);
    return () => window.removeEventListener('studio:new', onNew);
  }, []);

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
      setSession(asPath(picked.dir, picked.name));
      await local.sessionsIn(picked.dir).then(loadFolder).catch(() => undefined);
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

  const toolsOnly = () => {
    if (ownWindow && chooserWantsTools()) return;
    setToolsAlone(true);
    navigate('/tools');
  };

  const when = (iso?: string) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : null;
  };
  const describe = (set: OutputSet) =>
    [set.songs ? `${set.songs} songs` : 'nothing prepared yet', when(set.preparedAt) ? `prepared ${when(set.preparedAt)}` : null]
      .filter(Boolean)
      .join(' · ');

  if (opening) {
    return (
      <div className="launch-busy">
        <h2>{output?.name ?? 'The set'}</h2>
        <p>Reading {opening} and everything it names…</p>
      </div>
    );
  }

  const ready = !!output && !!session;

  return (
    <>
      <div className="launch">
        {/* ------------------------------ input ------------------------------- */}
        <section className="launch-card">
          <h3>
            <span className="launch-step">Input</span>
            Ableton session
          </h3>

          {recentAls ? (
            <Pick
              on={session === recentAls}
              title={nameOf(recentAls)}
              note={`${remembered.current.session === recentAls ? 'opened last' : 'what the folder was made from'} · in ${nameOf(dirOf(recentAls))}`}
              onClick={() => setSession(recentAls)}
            />
          ) : (
            <div className="launch-none">No session opened yet.</div>
          )}

          {session && session !== recentAls && (
            <Pick on title={nameOf(session)} note={`in ${nameOf(dirOf(session))}`} onClick={() => undefined} />
          )}

          <label className="switch-row">
            <input
              type="checkbox"
              checked={always.session}
              onChange={(e) => setAlways(setAlwaysOpen({ session: e.target.checked }))}
            />
            <span>Always open the most recent</span>
          </label>

          <div className="launch-row">
            <select
              className="jump-select"
              aria-label={`Sessions in ${folder?.name ?? 'this folder'}`}
              value={session && folder && dirOf(session) === folder.dir ? nameOf(session) : ''}
              onChange={(e) => e.target.value && folder && setSession(asPath(folder.dir, e.target.value))}
              disabled={!folder?.files.length}
            >
              <option value="">{folder?.files.length ? `In ${folder.name}…` : 'No other sessions'}</option>
              {folder?.files.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => void pickAls()}>
              Another folder…
            </button>
          </div>

          {inError && <div className="notice error">{inError}</div>}
        </section>

        {/* ------------------------------ output ------------------------------ */}
        <section className="launch-card">
          <h3>
            <span className="launch-step">Output</span>
            Set folder
            {publishFolderName && <span className="launch-where">in {publishFolderName}</span>}
          </h3>

          {recentSet ? (
            <Pick
              on={output?.folder === recentSet.folder}
              title={recentSet.name}
              note={`${remembered.current.output ? 'opened last' : 'prepared most recently'} · ${describe(recentSet)}`}
              onClick={() => takeOutput(recentSet)}
            />
          ) : (
            <div className="launch-none">
              {sets === null ? 'Looking in the band’s folder…' : 'No set folders yet — make the first one.'}
            </div>
          )}

          {output && output.folder !== recentSet?.folder && (
            <Pick on title={output.name} note={describe(output)} onClick={() => undefined} />
          )}

          <label className="switch-row">
            <input
              type="checkbox"
              checked={always.output}
              onChange={(e) => setAlways(setAlwaysOpen({ output: e.target.checked }))}
            />
            <span>Always open the most recent</span>
          </label>

          <div className="launch-row">
            <button
              className={choosing ? 'btn on' : 'btn'}
              onClick={() => {
                setChoosing((c) => !c);
                setMaking(false);
              }}
              disabled={!sets?.length}
            >
              {choosing ? 'Never mind' : 'Another folder…'}
            </button>
            <button
              className={making ? 'btn on' : 'btn'}
              onClick={() => {
                setMaking((m) => !m);
                setChoosing(false);
                if (!newName && session) setNewName(nameOf(session).replace(/\.als$/i, ''));
              }}
            >
              {making ? 'Never mind' : 'New folder…'}
            </button>
          </div>

          {making && (
            <div className="launch-row">
              <input
                className="text-input"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`Name it — under ${SETS_FOLDER}/`}
                aria-label="Name for the new set folder"
              />
              <button className="btn primary" onClick={() => void makeFolder()} disabled={!session || !safeSetName(newName)}>
                Make it
              </button>
            </div>
          )}
          {making && !session && <div className="launch-none">Choose the session first: the new folder is fed by it.</div>}

          {choosing && (
            <div className="launch-list">
              {sets?.map((set) => (
                <button
                  key={set.folder}
                  className={output?.folder === set.folder ? 'row on' : 'row'}
                  onClick={() => takeOutput(set)}
                >
                  <div className="row-main">
                    <div className="row-title">{set.name}</div>
                    <div className="row-sub">
                      {describe(set)}
                      {set.session ? ` · from ${nameOf(set.session)}` : ' · no session yet'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {outError && <div className="notice error">{outError}</div>}
        </section>
      </div>

      <div className="launch-go">
        <div className="launch-pair">
          <span className="launch-said">
            <span className="launch-step">Input</span>
            <strong>{session ? nameOf(session) : 'not chosen'}</strong>
          </span>
          <span className="launch-said">
            <span className="launch-step">Output</span>
            <strong>{output ? output.name : 'not chosen'}</strong>
          </span>
        </div>
        <button className="btn primary" disabled={!ready} onClick={() => ready && void openBoth(output!, session!)}>
          Open
        </button>
      </div>

      <div className="launch-aside">
        <button className="linky" onClick={() => void changeBand()}>
          {publishFolderName ? `Band’s folder: ${publishFolderName} — change…` : 'Choose the band’s folder…'}
        </button>
        <button className="linky" onClick={toolsOnly}>
          Just use the tools, without the band’s files
        </button>
      </div>
    </>
  );
}
