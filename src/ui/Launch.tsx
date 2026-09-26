import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { setToolsAlone } from '../lib/toolsAlone';
import * as local from '../lib/localSource';
import type { FolderSessions } from '../lib/localSource';
import { createOutputSet, outputSets, rememberSession, type OutputSet } from '../lib/locatePrepared';
import { alwaysOpen, recentOutput, recentSession, setAlwaysOpen, takeAsk } from '../lib/recent';
import { choosingNew, chooserChose, isChooserWindow, type Intent } from '../lib/appWindow';
import { SETS_FOLDER } from '../lib/prints';
import { safeSetName } from '../lib/setName';
import { isStudioCopy } from '../../scripts/studio-copies.mjs';

/**
 * The window a launch opens with: what to do, then where it goes.
 *
 * The first question is which of three things this is — opening an Ableton
 * session, making a new one from a folder of stems, or using the set tools
 * with no set at all. The second is the set folder in the band's Dropbox that
 * the phones read, which every one of them writes to. Nothing is opened until
 * both are answered, and they are answered one after the other: the second
 * depends on the first, since a new folder is fed by the session chosen.
 *
 * The usual answer to both is “the same as last time”, so each offers what it
 * opened last first, and can be told to take it without asking. In the Mac
 * app this is a small window of its own in front of the studio: what it
 * chooses is handed back to the window behind, and closing it changes
 * nothing. File ▸ Open (⌘O) puts it up; File ▸ New (⌘N) puts it up with the
 * new set folder already asked for.
 */

const asPath = (dir: string, name: string) => `${dir}/${name}`;
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** The three things a launch can be, in the order they are offered. */
const INTENTS: { key: Intent; title: string; note: string }[] = [
  { key: 'open', title: 'Open an Ableton session', note: 'Play it, prepare it for the band, and run the set tools on it.' },
  { key: 'stems', title: 'New session from stems', note: 'Lay a folder of bounces out the way a session you already have is, as a new set.' },
  { key: 'tools', title: 'Just use the tools', note: 'Spoken slates from typed words, Lyrics Studio — the tools that need no set.' },
];

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
  const { publishFolderName, publishFolder, pickPublishFolder, adoptPublishFolder, chooseOutput, openSession, sessionPath } = useStore();

  /* What is chosen so far. Nothing is opened until the intent is answered and, for a set, both sides are. */
  const [intent, setIntent] = useState<Intent | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [output, setOutput] = useState<OutputSet | null>(null);
  const [session, setSession] = useState<string | null>(null);

  const [sets, setSets] = useState<OutputSet[] | null>(null);
  const [folder, setFolder] = useState<FolderSessions | null>(null);
  const [always, setAlways] = useState(alwaysOpen);
  const [outError, setOutError] = useState<string | null>(null);
  const [inError, setInError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
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
   * A new session from stems opens the session it is modelled on and goes
   * straight to the tool that lays the stems out.
   */
  const openBoth = useCallback(
    async (set: OutputSet, alsPath: string, what: Intent) => {
      setOpening(nameOf(alsPath));
      setInError(null);
      // Its own window hands the pair to the studio behind and stops there.
      if (ownWindow && chooserChose({ set: { ...set }, session: alsPath, intent: what })) return;
      try {
        chooseOutput(set);
        await openSession(alsPath, set);
        if (what === 'stems') navigate('/tools', { tool: 'stems' });
      } catch (err) {
        setInError(`${nameOf(alsPath)} could not be opened: ${err instanceof Error ? err.message : String(err)}`);
        setOpening(null);
      }
    },
    [chooseOutput, openSession, ownWindow],
  );

  /** The tools, with no set — and whichever set folder was chosen for what they write. */
  const openTools = useCallback(
    (set: OutputSet | null) => {
      if (ownWindow && chooserChose({ set: set ? { ...set } : undefined, intent: 'tools' })) return;
      if (set) chooseOutput(set);
      setToolsAlone(true);
      navigate('/tools');
    },
    [chooseOutput, ownWindow],
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
    void openBoth(recentSet, recentAls, 'open');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, sets, always, recentSet, recentAls, opening]);

  /* File ▸ New, on the way in or while this window is already up: a session, and the new folder asked for. */
  useEffect(() => {
    const askNew = () => {
      setIntent((was) => was ?? 'open');
      setStep(2);
      setMaking(true);
    };
    if (making) askNew();
    window.addEventListener('studio:new', askNew);
    return () => window.removeEventListener('studio:new', askNew);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Choosing a folder offers the session it remembers, when none is chosen yet. */
  const takeOutput = (set: OutputSet) => {
    setOutput(set);
    setMaking(false);
    if (!session && set.session) setSession(set.session);
  };

  const pickAls = async () => {
    setInError(null);
    try {
      const picked = await local.pickFilePath({
        description: intent === 'stems' ? 'the Ableton session the new one is laid out like' : 'the Ableton session the prepared files are made from',
        extensions: ['als'],
      });
      setSession(asPath(picked.dir, picked.name));
      await local.sessionsIn(picked.dir).then(loadFolder).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setInError(message);
    }
  };

  /**
   * A set folder chosen in the Finder, the way the session is. What is
   * picked says what it is: a folder inside a band's Sets/ is that set, in
   * that band — another band's, and the studio moves to it; the band's
   * folder itself, or any other, is taken as the band's, with its sets to
   * choose from. A set folder with no manifest yet gets one, fed by the
   * chosen session, so a folder made by hand in the Finder is usable too.
   */
  const pickOutput = async () => {
    setOutError(null);
    setMaking(false);
    try {
      const picked = await local.pickFolderPath({
        prompt: 'Choose the set folder the band will read, or the band’s folder',
        startIn: { slot: 'publish', sub: SETS_FOLDER },
      });
      const parent = dirOf(picked.dir);
      const isSet = nameOf(parent) === SETS_FOLDER;
      const band = await adoptPublishFolder(isSet ? dirOf(parent) : picked.dir);
      let found = await outputSets(band);
      if (!isSet) {
        setOutput(null);
        setSets(found);
        return;
      }
      const folder = `${SETS_FOLDER}/${picked.name}`;
      let set = found.find((s) => s.folder === folder);
      if (!set) {
        if (!session) {
          setSets(found);
          setOutError(`${picked.name} has nothing prepared in it yet. Go back and choose the session first, then pick it again: a new set folder is fed by the session.`);
          return;
        }
        await rememberSession(band, folder, session);
        found = await outputSets(band);
        set = found.find((s) => s.folder === folder) ?? { folder, name: picked.name, songs: 0, session };
      }
      setSets(found);
      takeOutput(set);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setOutError(message);
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

  const needsSession = intent === 'open' || intent === 'stems';
  /* The first step is answered once there is a thing to do — and a session, when the thing needs one. */
  const canGoOn = intent === 'tools' || (needsSession && !!session);
  const ready = intent === 'tools' ? true : !!output && !!session;

  const go = () => {
    if (!ready || !intent) return;
    if (intent === 'tools') openTools(output);
    else void openBoth(output!, session!, intent);
  };

  /* --------------------------------- step 1 --------------------------------- */
  if (step === 1) {
    return (
      <>
        <div className="launch launch-one">
          <section className="launch-card">
            <h3>
              <span className="launch-step">Step 1 of 2</span>
              What to do
            </h3>

            <div className="launch-options">
              {INTENTS.map((o) => (
                <Pick key={o.key} on={intent === o.key} title={o.title} note={o.note} onClick={() => setIntent(o.key)} />
              ))}
            </div>

            {needsSession && (
              <div className="launch-under">
                <h4>{intent === 'stems' ? 'Laid out like' : 'Ableton session'}</h4>
                {intent === 'stems' && (
                  <div className="launch-none">
                    The new set copies this one's tracks, routing, sends and click track; the folder of stems is asked for next, in the tool.
                  </div>
                )}

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

                {intent === 'open' && (
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={always.session}
                      onChange={(e) => setAlways(setAlwaysOpen({ session: e.target.checked }))}
                    />
                    <span>Always open the most recent</span>
                  </label>
                )}

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
              </div>
            )}
          </section>
        </div>

        <div className="launch-go">
          <div className="launch-pair">
            <span className="launch-said">
              <strong>{intent ? INTENTS.find((o) => o.key === intent)!.title : 'Choose what to do'}</strong>
              {needsSession && <span>· {session ? nameOf(session) : 'no session chosen'}</span>}
            </span>
          </div>
          <button className="btn primary" disabled={!canGoOn} onClick={() => canGoOn && setStep(2)}>
            Next
          </button>
        </div>
      </>
    );
  }

  /* --------------------------------- step 2 --------------------------------- */
  return (
    <>
      <div className="launch launch-one">
        <section className="launch-card">
          <h3>
            <span className="launch-step">Step 2 of 2</span>
            Output folder
            {publishFolderName && <span className="launch-where">in {publishFolderName}</span>}
          </h3>

          <div className="launch-none">
            {intent === 'tools'
              ? 'The set folder anything the tools prepare is written into. Optional: the tools that need no set need no folder either.'
              : intent === 'stems'
                ? 'The set folder in the band’s Dropbox that the new session will fill once it is prepared.'
                : 'The set folder in the band’s Dropbox that this session fills.'}
          </div>

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

          {intent === 'open' && (
            <label className="switch-row">
              <input
                type="checkbox"
                checked={always.output}
                onChange={(e) => setAlways(setAlwaysOpen({ output: e.target.checked }))}
              />
              <span>Always open the most recent</span>
            </label>
          )}

          <div className="launch-row">
            <select
              className="jump-select"
              aria-label={`Set folders in ${publishFolderName ?? 'the band’s folder'}`}
              value={output && sets?.some((s) => s.folder === output.folder) ? output.folder : ''}
              onChange={(e) => {
                const set = sets?.find((s) => s.folder === e.target.value);
                if (set) takeOutput(set);
              }}
              disabled={!sets?.length}
            >
              <option value="">{sets?.length ? `In ${publishFolderName ?? 'the band’s folder'}…` : 'No set folders yet'}</option>
              {sets?.map((set) => (
                <option key={set.folder} value={set.folder}>
                  {set.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => void pickOutput()}>
              Another folder…
            </button>
            {/* A new folder is fed by the session, so there is none to make without one. */}
            {needsSession && (
              <button
                className={making ? 'btn on' : 'btn'}
                onClick={() => {
                  setMaking((m) => !m);
                  if (!newName && session) setNewName(nameOf(session).replace(/\.als$/i, ''));
                }}
              >
                {making ? 'Never mind' : 'New folder…'}
              </button>
            )}
          </div>

          {making && needsSession && (
            <div className="launch-row">
              <input
                className="text-input"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`Name it — under ${SETS_FOLDER}/`}
                aria-label="Name for the new set folder"
                autoFocus
              />
              <button className="btn primary" onClick={() => void makeFolder()} disabled={!session || !safeSetName(newName)}>
                Make it
              </button>
            </div>
          )}

          {outError && <div className="notice error">{outError}</div>}
        </section>
      </div>

      <div className="launch-go">
        <button className="btn" onClick={() => setStep(1)}>
          Back
        </button>
        <div className="launch-pair">
          <span className="launch-said">
            <span className="launch-step">{intent === 'stems' ? 'Like' : 'Input'}</span>
            <strong>{session ? nameOf(session) : intent === 'tools' ? 'the tools, no set' : 'not chosen'}</strong>
          </span>
          <span className="launch-said">
            <span className="launch-step">Output</span>
            <strong>{output ? output.name : intent === 'tools' ? 'none' : 'not chosen'}</strong>
          </span>
        </div>
        <button className="btn primary" disabled={!ready} onClick={go}>
          {intent === 'tools' ? (output ? 'Open the tools' : 'Skip and open the tools') : intent === 'stems' ? 'Open and lay out stems' : 'Open'}
        </button>
      </div>

      <div className="launch-aside">
        <button className="linky" onClick={() => void changeBand()}>
          {publishFolderName ? `Band’s folder: ${publishFolderName} — change…` : 'Choose the band’s folder…'}
        </button>
      </div>
    </>
  );
}
