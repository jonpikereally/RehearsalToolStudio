import { useStore } from '../lib/store';
import { navigate, setlistUrl } from '../lib/router';
import { isFromSet } from '../lib/alsImport';
import { canEditLibrary } from '../lib/appMode';

export default function SetlistsView() {
  const { library, createSetlist } = useStore();

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

      {library.setlists.length === 0 && (
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

      {library.setlists.map((setlist) => (
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
