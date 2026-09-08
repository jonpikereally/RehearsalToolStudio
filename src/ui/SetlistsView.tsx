import { useState } from 'react';
import { autoUpdates, useStore } from '../lib/store';
import PrepareSetDialog from './PrepareSetDialog';
import { navigate, setlistUrl } from '../lib/router';
import { isFromSet, setlistIdFor } from '../lib/alsImport';
import { canEditLibrary } from '../lib/appMode';
import { usePreparedStanding } from '../lib/usePreparedStanding';
import { AUTO_JOBS } from './AutoUpdate';

export default function SetlistsView() {
  const { library, createSetlist, currentSet, settings, saveSettings, publishFolderName, setSaved } = useStore();
  const [preparing, setPreparing] = useState(false);
  // Looked up again after a save has been read, and after the dialog closes.
  const prepared = usePreparedStanding(currentSet, `${setSaved?.at ?? ''}|${preparing}`);
  const inSetCount = library.songs.filter((s) => s.setPath === currentSet).length;

  // The set's own running order, and any made by hand out of its songs.
  const inSet = new Set(library.songs.filter((s) => s.setPath === currentSet).map((s) => s.id));
  const setlists = library.setlists.filter(
    (sl) =>
      (currentSet && sl.id === setlistIdFor(currentSet)) ||
      (!isFromSet(sl.id) && sl.songIds.every((id) => inSet.has(id))),
  );

  const add = () => {
    const name = window.prompt('Name this setlist', 'New setlist');
    if (!name?.trim()) return;
    const setlist = createSetlist(name.trim());
    navigate(setlistUrl(setlist.id));
  };

  return (
    <>
      <div className="topbar">
        <h1>Setlists</h1>
        {canEditLibrary && (
          <button className="icon-btn" onClick={add} aria-label="New setlist">
            +
          </button>
        )}
      </div>

      {setlists.length === 0 && (
        <div className="empty">
          <h2>No setlists</h2>
          <p>
            {canEditLibrary
              ? "Group songs into a running order for a gig, a rehearsal, or a project you're learning."
              : 'Running orders are made by whoever runs the band. When there is one, it turns up here.'}
          </p>
          {canEditLibrary && (
            <button className="btn primary" onClick={add}>
              New setlist
            </button>
          )}
        </div>
      )}

      {/*
        The whole set, from the page that lists its running orders: a setlist's
        own button prepares that setlist, and this is the one place to prepare
        everything without first choosing which order to do it from.
      */}
      {currentSet && inSetCount > 0 && (
        <div className="panel btn-row">
          <button className="btn primary" onClick={() => setPreparing(true)}>
            {prepared.state === 'found' ? 'Update the set for Rehearsal Tool' : 'Prepare the whole set for Rehearsal Tool'}
          </button>
          <span style={{ color: 'var(--text-dim)', fontSize: 13, alignSelf: 'center' }}>
            {prepared.state === 'found'
              ? (() => {
                  const f = prepared.found;
                  const when = f.lastPrepared ? new Date(f.lastPrepared) : null;
                  const stamp = when && !Number.isNaN(when.getTime())
                    ? when.toLocaleDateString([], { day: 'numeric', month: 'short' })
                    : null;
                  const behind = f.changed + f.fresh;
                  const words = f.words ? `words or sections changed in ${f.words} song${f.words === 1 ? '' : 's'}` : '';
                  return (
                    `prepared${stamp ? ` ${stamp}` : ''} into “${f.folder}” — ` +
                    (behind
                      ? `${f.changed ? `${f.changed} changed` : ''}${f.changed && f.fresh ? ', ' : ''}${f.fresh ? `${f.fresh} new` : ''} since, ${f.unchanged} unchanged` +
                        (words ? `; ${words}` : '')
                      : words
                        ? `no audio has changed since, but ${words}`
                        : 'nothing has changed since; words and sections can still be refreshed')
                  );
                })()
              : prepared.state === 'looking'
                ? 'looking for it in the band’s folder…'
                : `all ${inSetCount} song${inSetCount === 1 ? '' : 's'}, as small files the band's app plays`}
          </span>
        </div>
      )}
      {/*
        Live saves the set; the studio notices. Whether it then rewrites the
        band's folder on its own is a choice, made here beside the button
        that does it by hand.
      */}
      {currentSet && inSetCount > 0 && (
        <div className="panel" style={{ paddingTop: 0 }}>
          <div className="control-label">When Live saves the set, on its own</div>
          <div className="hint" style={{ marginBottom: 8 }}>
            {autoUpdates(settings.autoUpdate)
              ? `Watching ${currentSet.split('/').pop()} — what is ticked below is written into “${publishFolderName ?? 'the band’s folder'}” without asking. The rest is offered in the bar.`
              : 'Nothing: each save is noticed and offered as an update, and nothing is written until you say.'}
          </div>
          {AUTO_JOBS.map(({ key, label, hint }) => (
            <label className="switch-row" key={key}>
              <input
                type="checkbox"
                checked={settings.autoUpdate[key]}
                onChange={(e) => saveSettings({ autoUpdate: { ...settings.autoUpdate, [key]: e.target.checked } })}
              />
              <span>
                <strong>{label}</strong>
                <span className="hint" style={{ display: 'block' }}>
                  {hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      {preparing && <PrepareSetDialog onClose={() => setPreparing(false)} />}

      {setlists.map((setlist) => (
        <button key={setlist.id} className="row" onClick={() => navigate(setlistUrl(setlist.id))}>
          <div className="row-main">
            <div className="row-title">{setlist.name}</div>
            <div className="row-sub">
              {setlist.songIds.length} song{setlist.songIds.length === 1 ? '' : 's'}
              {/* Says why it appeared without anyone making it. */}
              {isFromSet(setlist.id) && ' · from an Ableton set'}
            </div>
          </div>
          <div className="row-right">›</div>
        </button>
      ))}
    </>
  );
}
