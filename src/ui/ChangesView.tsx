import { useEffect, useState } from 'react';
import { clearNotes, saveNotes, type SaveNote } from '../lib/saveLog';

/**
 * What the studio has done, save by save.
 *
 * The bar along the top says what is happening now and is then dismissed;
 * this is the same thing kept — every save Live made while the studio was
 * open, and what the studio made of it, with the time. Its own small window
 * in the Mac app, so it can sit beside Live during a rehearsal.
 *
 * It watches for new notes rather than being reloaded: they are written by
 * the other window, so this one listens for the storage they land in.
 */

const DAY = (at: number) => new Date(at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
const TIME = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

const LABEL: Record<SaveNote['kind'], string> = {
  saved: 'saved',
  updated: 'updated',
  nothing: 'no change',
  held: 'left alone',
  stopped: 'stopped',
  error: 'failed',
  undone: 'undone',
};

const TONE: Record<SaveNote['kind'], string> = {
  saved: '',
  updated: ' ok',
  nothing: '',
  held: ' warn',
  stopped: ' warn',
  error: ' bad',
  undone: ' warn',
};

export default function ChangesView() {
  const [notes, setNotes] = useState<SaveNote[]>(saveNotes);

  useEffect(() => {
    const read = () => setNotes(saveNotes());
    // Written in this window, or in the studio's: both reach here.
    window.addEventListener('studio:note', read);
    window.addEventListener('storage', read);
    const timer = window.setInterval(read, 4000);
    return () => {
      window.removeEventListener('studio:note', read);
      window.removeEventListener('storage', read);
      window.clearInterval(timer);
    };
  }, []);

  let day: string | null = null;

  return (
    <>
      <div className="topbar">
        <h1>
          Changes
          <span className="sub" style={{ display: 'block' }}>
            every save, and what the studio made of it
          </span>
        </h1>
        {notes.length > 0 && (
          <button className="btn" onClick={() => clearNotes()} title="Empty the log; nothing on disk is touched">
            Clear
          </button>
        )}
      </div>

      {!notes.length && (
        <div className="empty">
          <h2>Nothing yet</h2>
          <p>Every save Live makes while the studio is open lands here, along with what was done about it.</p>
        </div>
      )}

      <div className="changes">
        {notes.map((n, i) => {
          const heading = DAY(n.at) !== day ? (day = DAY(n.at)) : null;
          return (
            <div key={`${n.at}-${i}`}>
              {heading && <div className="changes-day">{heading}</div>}
              <div className="change">
                <span className="change-at">{TIME(n.at)}</span>
                <span className={`badge${TONE[n.kind]}`}>{LABEL[n.kind]}</span>
                <span className="change-what">
                  {n.text}
                  <span className="change-where">
                    {n.session}
                    {n.set ? ` → ${n.set.split('/').pop()}` : ''}
                  </span>
                  {n.songs?.length ? <span className="change-songs">{n.songs.join(' · ')}</span> : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ height: 16 }} />
    </>
  );
}
