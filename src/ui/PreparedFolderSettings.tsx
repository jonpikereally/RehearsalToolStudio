import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import * as local from '../lib/localSource';
import { locatePrepared } from '../lib/locatePrepared';
import { parseAls } from '../lib/alsParser';
import { readBytes } from '../lib/source';
import { audioKeysFor } from '../lib/prepareRun';
import { MANIFEST_NAME } from '../lib/preparedSet';
import { SETS_FOLDER } from '../lib/prints';
import { rememberSetName, rememberedSetName } from '../lib/setName';
import SettingsSection from './SettingsSection';

/**
 * Which folder in the band's folder the open set is prepared into.
 *
 * Usually worked out: the name chosen at the first prepare, or failing that
 * the folder whose manifest says it came from this set, or is named for it.
 * A set renamed on disk, a folder renamed in Dropbox, or a memory lost with
 * the browser's storage can leave that guess wrong — a fresh folder with no
 * audio in it — so the folder can be pointed at by hand, the way a missing
 * file is located in Live. And found, it can be shown in the Finder.
 */
export default function PreparedFolderSettings() {
  const { currentSet, publishFolderName, publishFolder, pickPublishFolder } = useStore();
  const [name, setName] = useState<string | null>(null);
  const [how, setHow] = useState<'chosen' | 'found' | 'none'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [look, setLook] = useState(0);

  const setFile = currentSet?.split('/').pop() ?? null;

  useEffect(() => {
    setName(null);
    setHow('none');
    setError(null);
    if (!currentSet) return;
    const remembered = rememberedSetName(currentSet);
    if (remembered) {
      setName(remembered);
      setHow('chosen');
      return;
    }
    let live = true;
    void (async () => {
      // The band's folder as already granted; never a dialog from an effect.
      const band = await publishFolder();
      if (!band || !live) return;
      const project = await parseAls((await readBytes(currentSet)).bytes);
      const keys = await audioKeysFor(project, currentSet);
      const found = await locatePrepared(band, currentSet, keys.byFolder);
      if (!live) return;
      if ('error' in found) return;
      setName(found.setFolder.split('/').pop() ?? null);
      setHow('found');
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSet, publishFolderName, look]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    } finally {
      setBusy(false);
    }
  };

  /** Point at the folder by hand: one of the prepared sets under Sets/. */
  const locate = () =>
    run(async () => {
      if (!currentSet) return;
      const band = (await publishFolder()) ?? (await pickPublishFolder());
      const picked = await local.pickFolder(null, { startIn: { slot: 'publish', sub: SETS_FOLDER } });
      const isSet = await local.exists(band, '', `${SETS_FOLDER}/${picked.name}/${MANIFEST_NAME}`);
      if (!isSet) {
        throw new Error(
          `“${picked.name}” is not a prepared set in “${publishFolderName ?? "the band's folder"}” — choose a folder under ${SETS_FOLDER}/ that a prepare wrote.`,
        );
      }
      rememberSetName(currentSet, picked.name);
      setLook((n) => n + 1);
    });

  const reveal = () =>
    run(async () => {
      if (!name) return;
      const band = (await publishFolder()) ?? (await pickPublishFolder());
      await local.reveal(band, '', `${SETS_FOLDER}/${name}`);
    });

  const forget = () => {
    if (!currentSet) return;
    rememberSetName(currentSet, '');
    setLook((n) => n + 1);
  };

  if (!currentSet) return null;

  return (
    <SettingsSection
      id="prepare"
      title="The prepared set"
      summary={name ? `${SETS_FOLDER}/${name}` : 'not found yet'}
    >
      <div className="field">
        <label>
          Where {setFile} is prepared to
          <span className="hint">
            The folder under <span className="code">{SETS_FOLDER}/</span> in the band's folder that this set
            fills — the one a save updates. Worked out from the name chosen at the first prepare, or from
            what the folder says it came from; locate it by hand when that guess is wrong, after a rename say.
          </span>
        </label>
        <div className="btn-row">
          <span className="code">
            {name ? `${SETS_FOLDER}/${name}` : 'no prepared set found for it'}
            {name && (
              <span style={{ color: 'var(--text-dim)' }}>
                {how === 'chosen' ? ' · chosen by hand' : ' · found by its manifest'}
              </span>
            )}
          </span>
          <button className="btn" onClick={() => void locate()} disabled={busy}>
            Locate…
          </button>
          {name && (
            <button className="btn" onClick={() => void reveal()} disabled={busy}>
              Show in Finder
            </button>
          )}
          {how === 'chosen' && (
            <button className="btn" onClick={forget} disabled={busy} title="Work it out again from the band's folder">
              Forget
            </button>
          )}
        </div>
        {error && <div className="notice error">{error}</div>}
      </div>
    </SettingsSection>
  );
}
