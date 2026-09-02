import { useEffect, useMemo, useState } from 'react';
import type { DownloadItem } from '../lib/songLoader';
import { formatBytes } from '../lib/songLoader';
import { versionsOf } from '../lib/versions';
import { isReferenceName } from '../lib/scan';

/**
 * Where a part already is, or what fetching it costs.
 *
 * A file in the user's own folder is not a download and shouldn't be priced
 * like one — it is simply there, and saying so is the difference between the
 * question making sense and looking broken.
 */
function Availability({ item }: { item: DownloadItem }) {
  if (item.where === 'disk') return <span className="badge ok">on disk</span>;
  if (item.where === 'cache') return <span className="badge ok">on device</span>;
  return <span className="badge warn">not in the folder</span>;
}

/**
 * Why a part isn't in your folder, when you have one.
 *
 * "On disk" is a lookup of this exact path inside the folder you chose, so a
 * part that has to be fetched while its neighbours sit there is a part whose
 * path doesn't match — a file that hasn't synced, or one that lives somewhere
 * the folder doesn't cover. Showing the path turns that from a mystery into
 * something you can look at.
 */
function NotHere({ item, showPath }: { item: DownloadItem; showPath: boolean }) {
  if (!showPath || item.cached) return null;
  return <span className="pick-path mono">{item.variant.path}</span>;
}

/**
 * Which parts to fetch, asked before anything is downloaded.
 *
 * Put once per song per device, and only when there is something still to
 * fetch — a song already cached opens straight away. The point is the phone:
 * eight stems is a long wait and a real dent in a data allowance, and the
 * reference alone is often all you want on the way to a rehearsal.
 */
export default function DownloadDialog({
  songTitle,
  items,
  skipped,
  onConfirm,
  onCancel,
}: {
  songTitle: string;
  items: DownloadItem[];
  /** Variant ids currently skipped on this device. */
  skipped: string[];
  onConfirm: (skipIds: string[]) => void;
  /** Back out without fetching anything. */
  onCancel: () => void;
}) {
  /*
   * Escape and the × back out of the song entirely rather than dismissing the
   * question. Nothing is loaded until it is answered, so closing the dialog on
   * the spot would leave a player with no audio in it looking broken — and
   * quietly taking the default would start the download the dialog exists to
   * ask about.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(items.filter((i) => !skipped.includes(i.variant.id)).map((i) => i.variant.id)),
  );

  /*
   * Two questions. Which version — a folder of files, a complete rendering of
   * the song — and then which of that version's parts to load. A version can
   * hold anything: stems, a reference master, an instrumental, an acapella, a
   * print made here, and they are all just parts of it.
   */
  const versions = useMemo(
    () => versionsOf(items.map((i) => i.variant), songTitle),
    [items, songTitle],
  );
  const [versionId, setVersionId] = useState(() => {
    const owning = versions.find((v) => v.parts.some((p) => !skipped.includes(p.id)));
    return (owning ?? versions[0])?.id ?? '';
  });
  const version = versions.find((v) => v.id === versionId) ?? versions[0];

  const byId = useMemo(() => new Map(items.map((i) => [i.variant.id, i])), [items]);
  const wholeMixes = (version?.mixes ?? []).map((v) => byId.get(v.id)!).filter(Boolean);
  // The reference master is listed apart: it is what SWITCH plays, where the
  // rest are ordinary channels.
  const references = wholeMixes.filter((i) => isReferenceName(i.variant.name));
  const mixes = wholeMixes.filter((i) => !isReferenceName(i.variant.name));
  const stems = (version?.stems ?? []).map((v) => byId.get(v.id)!).filter(Boolean);

  /** Moving to another version takes its parts wholesale and drops the rest. */
  const pickVersion = (id: string) => {
    setVersionId(id);
    const next = versions.find((v) => v.id === id);
    setChosen(new Set(next ? next.parts.map((p) => p.id) : []));
  };

  const toggle = (id: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toDownload = useMemo(
    () => items.filter((i) => chosen.has(i.variant.id) && !i.cached),
    [items, chosen],
  );
  const bytes = toDownload.reduce((sum, i) => sum + (i.variant.sizeBytes ?? 0), 0);
  const cachedCount = items.filter((i) => i.cached).length;
  const onDisk = items.filter((i) => i.where === 'disk').length;

  /*
   * Some of it is in the folder and some of it isn't, which is the case worth
   * explaining: with nothing on disk there is no folder in play, and with all
   * of it there is nothing to account for.
   */
  const explainMissing = onDisk > 0 && onDisk < items.length;

  /*
   * Reading from a folder is not downloading, and saying so matters: a set read
   * off disk was being described as though every part had to be fetched.
   */
  const summary =
    onDisk === items.length
      ? 'Every part is in your folder — this is just which ones to load.'
      : explainMissing
        ? `${onDisk} of ${items.length} parts are in your folder. The rest aren't at these paths, so they are left out until they are.`
        : cachedCount > 0
          ? `${cachedCount} of ${items.length} parts are here. The rest aren't in the folder.`
          : 'None of these parts are in the folder yet. Copy them in and rescan.';

  /** The version stays whatever it is; only the stems move. */
  const setAllStems = (on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      for (const s of stems) {
        if (on) next.add(s.variant.id);
        else next.delete(s.variant.id);
      }
      return next;
    });

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Parts to download for ${songTitle}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="spread">
          <h3>{songTitle}</h3>
          <button className="icon-btn" onClick={onCancel} aria-label="Back without downloading">
            ×
          </button>
        </div>
        <p className="dialog-note">{summary}</p>

        {versions.length > 1 && (
          <>
            <span className="control-label">Version</span>
            <div className="pick-list">
              {versions.map((v) => (
                <label key={v.id} className={v.id === version?.id ? 'pick on' : 'pick'}>
                  <input
                    type="radio"
                    name="version"
                    checked={v.id === version?.id}
                    onChange={() => pickVersion(v.id)}
                  />
                  <span className="pick-name">{v.name}</span>
                  <span className="pick-size mono">
                    {v.stems.length ? `${v.stems.length} stems` : ''}
                    {v.stems.length && v.mixes.length ? ' + ' : ''}
                    {v.mixes.length ? `${v.mixes.length} mix${v.mixes.length === 1 ? '' : 'es'}` : ''}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        {references.length > 0 && (
          <>
            <span className="control-label">Reference master</span>
            <div className="pick-list">
              {references.map((item) => {
                const { variant } = item;
                const on = chosen.has(variant.id);
                return (
                  <label key={variant.id} className={on ? 'pick on' : 'pick'}>
                    <input type="checkbox" checked={on} onChange={() => toggle(variant.id)} />
                    <span className="pick-name">
                      {variant.name}
                      <NotHere item={item} showPath={explainMissing} />
                    </span>
                    <Availability item={item} />
                  </label>
                );
              })}
            </div>
          </>
        )}

        {mixes.length > 0 && (
          <>
            <span className="control-label">Mixes</span>
            <div className="pick-list">
              {mixes.map((item) => {
                const { variant } = item;
                const on = chosen.has(variant.id);
                return (
                  <label key={variant.id} className={on ? 'pick on' : 'pick'}>
                    <input type="checkbox" checked={on} onChange={() => toggle(variant.id)} />
                    <span className="pick-name">
                      {variant.name}
                      <NotHere item={item} showPath={explainMissing} />
                    </span>
                    <Availability item={item} />
                  </label>
                );
              })}
            </div>
          </>
        )}

        {stems.length > 0 && (
          <>
            <span className="control-label">
              Stems — {stems.filter((i) => chosen.has(i.variant.id)).length} of {stems.length}
            </span>
            <div className="pick-list">
              {stems.map((item) => {
                const { variant } = item;
                const on = chosen.has(variant.id);
                return (
                  <label key={variant.id} className={on ? 'pick on' : 'pick'}>
                    <input type="checkbox" checked={on} onChange={() => toggle(variant.id)} />
                    <span className="pick-name">
                      {variant.name}
                      <NotHere item={item} showPath={explainMissing} />
                    </span>
                    <Availability item={item} />
                  </label>
                );
              })}
            </div>

            <div className="controls flush">
              <button className="chip" onClick={() => setAllStems(true)}>
                All stems
              </button>
              <button className="chip" onClick={() => setAllStems(false)}>
                None
              </button>
            </div>
          </>
        )}

        <p className="dialog-note">
          {bytes > 0 ? (
            <>
              {toDownload.length} part{toDownload.length === 1 ? '' : 's'} ({formatBytes(bytes)}) not in the folder — the song opens
              without {toDownload.length === 1 ? 'it' : 'them'}.
            </>
          ) : (
            <>Everything chosen is here.</>
          )}
        </p>

        <div className="btn-row">
          <button
            className="btn primary"
            disabled={chosen.size === 0}
            onClick={() =>
              // Nothing is fetched here: a part that isn't in the folder is skipped whatever the tick says.
              onConfirm(items.filter((i) => !chosen.has(i.variant.id) || !i.cached).map((i) => i.variant.id))
            }
          >
            {bytes > 0 ? 'Open without them' : 'Open song'}
          </button>
        </div>
        {chosen.size === 0 && <p className="dialog-note">Pick at least one part to play.</p>}
      </div>
    </div>
  );
}
