import { useEffect, useRef } from 'react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { setToolsAlone } from '../lib/toolsAlone';

/**
 * The first question on opening: which set?
 *
 * Everything the studio shows and does is about one Ableton set — its songs,
 * its running order, the tools that write into it. So a launch begins here,
 * with the sets the folder holds, and nothing else is drawn until one is
 * chosen. A folder never scanned is scanned now, since there is no list to
 * choose from otherwise.
 */
export default function ChooseSet() {
  const { sets, chooseSet, rescan, scanning, scanProgress, localFolderName, lastScan } = useStore();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || sets.length) return;
    started.current = true;
    void rescan();
    // Once, on arrival with nothing to show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="topbar">
        <h1>
          Choose a set
          <span className="sub" style={{ display: 'block' }}>
            {sets.length
              ? `${sets.length} in “${localFolderName}”`
              : `in “${localFolderName}”`}
          </span>
        </h1>
        <button className="icon-btn" onClick={() => void rescan()} disabled={scanning} title="Rescan the folder">
          {scanning ? '…' : '⟳'}
        </button>
      </div>

      {scanning && <div className="notice">{scanProgress || 'Scanning…'}</div>}
      {!scanning && lastScan?.alsNotes?.length ? (
        <div className="notice">{lastScan.alsNotes.join('. ')}.</div>
      ) : null}

      {!scanning && !sets.length && (
        <div className="empty">
          <h2>No Ableton sets here</h2>
          <p>
            {lastScan
              ? `Nothing in “${localFolderName}” read as a set with songs in it. Is this the right folder?`
              : 'Rescan the folder, or choose another one in Settings.'}
          </p>
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => void rescan()}>
              Rescan
            </button>
            <button className="btn" onClick={() => navigate('/settings')}>
              Settings
            </button>
          </div>
        </div>
      )}

      {/*
        Two of the set tools need no set: a slate spoken from typed words, and
        Lyrics Studio, which takes any file. A way straight to them, so a title
        to say or a song to transcribe doesn't wait on choosing a set first.
      */}
      <div className="panel btn-row" style={{ alignItems: 'center' }}>
        <button
          className="btn"
          onClick={() => {
            setToolsAlone(true);
            navigate('/tools');
          }}
        >
          Skip — open the set tools without a set
        </button>
        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          Speak a slate, or open Lyrics Studio. Anything that works on a set still needs one.
        </span>
      </div>

      {sets.map((set) => (
        <button key={set.path} className="row" onClick={() => chooseSet(set.path)}>
          <div className="row-main">
            <div className="row-title">{set.name}</div>
            <div className="row-sub">
              {set.songs
                ? `${set.songs} song${set.songs === 1 ? '' : 's'}` +
                  (set.withAudio < set.songs
                    ? `, ${set.songs - set.withAudio} without audio here`
                    : '')
                : 'not read yet'}
              {' · '}
              {set.path.replace(/^\//, '')}
            </div>
          </div>
          <div className="row-right">›</div>
        </button>
      ))}

      <div style={{ height: 24 }} />
    </>
  );
}
