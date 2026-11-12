import { useState } from 'react';
import { useStore } from '../lib/store';
import * as local from '../lib/localSource';
import { readBytes } from '../lib/source';
import { parseAls } from '../lib/alsParser';
import { matchAbleSet, parseAbleSetSetlist, type AbleSetEntry } from '../lib/ableset';
import { chooseSetlist, chosenSetlistFor, clearChosenSetlist } from '../lib/chosenSetlist';
import { setlistIdFor } from '../lib/alsImport';
import { coded } from '../lib/errorCodes';
import ErrorNotice from './ErrorNotice';

/**
 * Load an AbleSet setlist by hand, and see what it makes of the set.
 *
 * The studio finds AbleSet's setlist on its own, but from a format AbleSet
 * does not document, and it can get it wrong. Here a person picks the file —
 * one of the .json files AbleSet keeps in AbleSet/Setlists beside the set —
 * and sees it laid out against the set before anything changes: the order,
 * each song in or out of the show, any line that names no song of the set,
 * and the songs it leaves out. Used, it is the set's running order and its
 * selection, over anything found on its own, until cleared.
 */

interface Row {
  name: string;
  /** The set's song this entry is, or null when it names none of them. */
  title: string | null;
  off: boolean;
}

interface Preview {
  name: string;
  entries: AbleSetEntry[];
  rows: Row[];
  /** Songs of the set the file never names: not in the show. */
  leftOut: string[];
}

export default function AbleSetSetlistPanel({ setPath }: { setPath: string }) {
  const { library, rescan, scanning } = useStore();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped when the choice changes, so what is shown follows it. */
  const [, setRound] = useState(0);
  const chosen = chosenSetlistFor(setPath);
  const setlist = library.setlists.find((sl) => sl.id === setlistIdFor(setPath));

  const load = async () => {
    setError(null);
    setBusy(true);
    try {
      let file: local.PickedFile;
      try {
        file = await local.pickFile({ description: "an AbleSet setlist (a .json file in the set's AbleSet/Setlists folder)", extensions: ['json'] });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        throw err;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(file.bytes));
      } catch {
        throw new Error(coded('RTS-SLS-01', `“${file.name}” is not JSON, so it is not an AbleSet setlist.`));
      }
      const entries = parseAbleSetSetlist(raw);
      if (!entries?.length) {
        throw new Error(coded('RTS-SLS-01', `“${file.name}” holds no songs with a time and a name, so it is not an AbleSet setlist.`));
      }
      const { bytes } = await readBytes(setPath);
      const project = await parseAls(bytes);
      const { matched } = matchAbleSet(project, entries);
      const named = new Set(matched.filter((t): t is string => !!t));
      setPreview({
        name: file.name.replace(/\.json$/i, ''),
        entries,
        rows: entries.map((e, i) => ({ name: e.name, title: matched[i], off: !!e.off })),
        leftOut: [...new Set(project.songs.map((s) => s.title).filter((t) => !named.has(t)))],
      });
    } catch (err) {
      setError(coded('RTS-SLS-02', err));
    } finally {
      setBusy(false);
    }
  };

  const use = async () => {
    if (!preview) return;
    chooseSetlist(setPath, { name: preview.name, entries: preview.entries, at: Date.now() });
    setPreview(null);
    setRound((r) => r + 1);
    await rescan();
  };

  const clear = async () => {
    clearChosenSetlist(setPath);
    setRound((r) => r + 1);
    await rescan();
  };

  const inShow = preview ? preview.rows.filter((r) => r.title && !r.off).length : 0;

  return (
    <div className="panel" style={{ paddingTop: 0 }}>
      <div className="control-label">AbleSet setlist</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        {chosen
          ? `Using “${chosen.name}”, loaded by hand — it decides the order and which songs are in the show.`
          : 'Found on its own from the AbleSet folder beside the set. If it is the wrong one, load the right file here.'}
        {setlist?.notes ? <span style={{ display: 'block', marginTop: 4 }}>Now: {setlist.notes}</span> : null}
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => void load()} disabled={busy || scanning}>
          {busy ? 'Reading…' : 'Load AbleSet setlist…'}
        </button>
        {chosen && (
          <button className="btn" onClick={() => void clear()} disabled={busy || scanning} title="Go back to finding AbleSet's setlist on its own">
            Clear — find it on its own
          </button>
        )}
      </div>
      {error && <ErrorNotice code="RTS-SLS-02" text={error} />}

      {preview && (
        <div style={{ marginTop: 12 }}>
          <div className="hint" style={{ marginBottom: 6 }}>
            <strong>{preview.name}</strong> — {inShow} song{inShow === 1 ? '' : 's'} in the show, in this order
            {preview.rows.some((r) => r.off) ? `, ${preview.rows.filter((r) => r.off).length} skipped` : ''}
            {preview.leftOut.length ? `, ${preview.leftOut.length} of the set's songs not on it` : ''}.
          </div>
          <ol style={{ margin: '0 0 8px', paddingLeft: 24 }}>
            {preview.rows.map((row, i) => (
              <li key={i} style={{ opacity: row.title && !row.off ? 1 : 0.6, padding: '2px 0' }}>
                {row.title ?? row.name}{' '}
                {row.off ? (
                  <span className="badge warn">skipped in AbleSet</span>
                ) : row.title ? (
                  <span className="badge ok">in the show</span>
                ) : (
                  <span className="badge bad" title={`AbleSet calls it “${row.name}”; no song of this set has that name or sits where it did`}>
                    not found in this set
                  </span>
                )}
              </li>
            ))}
          </ol>
          {preview.leftOut.length > 0 && (
            <div className="hint" style={{ marginBottom: 8 }}>
              Not on this setlist, so left out of the show: {preview.leftOut.join(', ')}.
            </div>
          )}
          <div className="btn-row">
            <button className="btn primary" onClick={() => void use()} disabled={scanning}>
              Use this setlist
            </button>
            <button className="btn" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
