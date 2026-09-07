import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import * as local from '../lib/localSource';
import {
  DEFAULT_KEEPS, isClickOrCue, keepsPart, membersFromRigs, readMembers, submixesBehind, submixLabel, writeMembers,
  type MemberMix,
} from '../lib/members';
import { MANIFEST_NAME, type PreparedManifest } from '../lib/preparedSet';
import PrepareSetDialog from './PrepareSetDialog';
import SettingsSection from './SettingsSection';

/**
 * The band, and what each of them keeps on a fader of their own.
 *
 * Everything they don't keep is summed into one submix per song, written
 * beside the stems, so a phone holds four files where it held eight. The
 * names come from the rig files the website writes, and the parts to tick
 * come from the set that is open — which is what a person is actually
 * looking at when they think about what they want separate.
 *
 * Changes are held until they are saved, because saving them is a decision
 * with hours of rendering behind it: what is written for the band only
 * becomes true when the songs are prepared again, so the save says which
 * songs are now behind and offers to run them.
 */
export default function MembersSettings() {
  const { publishFolder, library, currentSet, publishFolderName, outputSet } = useStore();
  const [saved, setSaved] = useState<MemberMix[] | null>(null);
  const [draft, setDraft] = useState<MemberMix[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  /** What the prepared set is missing, worked out after a save. */
  const [behind, setBehind] = useState<{ title: string; who: string[] }[] | null>(null);
  const [dialog, setDialog] = useState<string[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const band = await publishFolder();
        if (!band) {
          setSaved([]);
          return;
        }
        const list = await readMembers(band);
        setSaved(list);
        setDraft(list);
        setKnown(await membersFromRigs(band).catch(() => []));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSaved([]);
      }
    })();
  }, [publishFolder, publishFolderName]);

  /** Every part label in the set that is open, for ticking rather than typing. */
  const labels = [
    ...new Set(
      library.songs
        .filter((song) => !currentSet || song.setPath === currentSet)
        .flatMap((song) => song.variants.map((v) => v.name.trim().toLowerCase()))
        .filter((label) => label && !isClickOrCue(label)),
    ),
  ].sort();

  const dirty = JSON.stringify(saved ?? []) !== JSON.stringify(draft);
  const change = (member: MemberMix, patch: Partial<MemberMix>) =>
    setDraft(draft.map((m) => (m === member ? { ...m, ...patch } : m)));

  const add = (name: string) => {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean || draft.some((m) => m.member.toLowerCase() === clean.toLowerCase())) return;
    setAdding('');
    setDraft([...draft, { member: clean, keeps: [...DEFAULT_KEEPS] }]);
  };

  /**
   * Save, then look at what has been prepared: a member added, or one of them
   * keeping something different, leaves every song's submix behind until the
   * songs are written again, and the folder is the only place that says which.
   */
  const save = async () => {
    setBusy(true);
    setError(null);
    setBehind(null);
    try {
      const band = await publishFolder();
      if (!band) throw new Error("The band's folder is not to hand.");
      await writeMembers(band, draft);
      setSaved(draft);
      if (outputSet) {
        const { bytes } = await local.readBytes(band, '', `${outputSet.folder}/${MANIFEST_NAME}`);
        const manifest = JSON.parse(new TextDecoder().decode(bytes)) as PreparedManifest;
        setBehind(submixesBehind(manifest.songs ?? [], draft));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const on = (saved ?? []).filter((m) => !m.off);
  const summary = !saved?.length ? (
    <>
      <span className="badge">off</span>no submixes written
    </>
  ) : (
    <>
      <span className={on.length ? 'badge ok' : 'badge'}>{on.length ? `${on.length} submixes` : 'off'}</span>
      {saved.map((m) => m.member).join(', ')}
    </>
  );

  return (
    <SettingsSection id="members" title="The band" summary={summary}>
      <div style={{ color: 'var(--text-dim)', fontSize: 13.5, lineHeight: 1.5 }}>
        Each member gets one part per song of everything they are <em>not</em> keeping separate, summed here from the
        multitrack and written beside the stems. Their phone loads that one file in place of the parts inside it — four
        files instead of eight, and a quarter of the decoding. The record itself is never in one, and a submix that
        would stand for fewer than two parts isn’t written, and neither the click nor the cues is ever in one.
      </div>

      {error && <div className="notice error">{error}</div>}
      {saved === null && <div className="notice">Reading the band’s folder…</div>}

      {draft.map((member) => (
        <div key={member.member} className="member">
          <div className="member-head">
            <strong>{member.member}</strong>
            <span className="code">{submixLabel(member.member)}</span>
            <label className="switch-row" style={{ marginLeft: 'auto' }}>
              <input
                type="checkbox"
                checked={!member.off}
                disabled={busy}
                onChange={(e) => change(member, { off: e.target.checked ? undefined : true })}
              />
              <span>Write a submix</span>
            </label>
            <button
              className="btn"
              disabled={busy}
              onClick={() => setDraft(draft.filter((m) => m !== member))}
              title={`Take ${member.member} out of the band`}
            >
              Remove
            </button>
          </div>
          <div className="member-keeps">
            <span className="control-label">Keeps separate</span>
            {labels.map((label) => (
              <button
                key={label}
                className={keepsPart(member, label) ? 'chip on' : 'chip'}
                disabled={busy || !!member.off}
                onClick={() =>
                  change(member, {
                    keeps: keepsPart(member, label)
                      ? member.keeps.filter((k) => k.toLowerCase() !== label)
                      : [...member.keeps, label],
                  })
                }
              >
                {label}
              </button>
            ))}
            {/* Kept parts the open set has no track for: another set's, or typed. */}
            {member.keeps
              .filter((keep) => !labels.includes(keep.toLowerCase()))
              .map((keep) => (
                <button
                  key={keep}
                  className="chip on"
                  disabled={busy || !!member.off}
                  onClick={() => change(member, { keeps: member.keeps.filter((k) => k !== keep) })}
                  title="Not a part of the set that is open"
                >
                  {keep} ·
                </button>
              ))}
            {!labels.length && <span className="hint">Open a set to see its parts.</span>}
          </div>
        </div>
      ))}

      <div className="btn-row">
        <input
          className="text-input"
          type="text"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add(adding)}
          placeholder="Name a member…"
          aria-label="Name a member"
          disabled={busy}
          style={{ maxWidth: 220 }}
        />
        <button className="btn" disabled={busy || !adding.trim()} onClick={() => add(adding)}>
          Add
        </button>
        {known
          .filter((name) => !draft.some((m) => m.member.toLowerCase() === name.toLowerCase()))
          .map((name) => (
            <button key={name} className="chip" disabled={busy} onClick={() => add(name)} title="From the rig files in the band's folder">
              + {name}
            </button>
          ))}
      </div>

      <div className="btn-row">
        <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : dirty ? 'Save the band' : 'Saved'}
        </button>
        {dirty && (
          <button className="btn" disabled={busy} onClick={() => setDraft(saved ?? [])}>
            Put it back
          </button>
        )}
        <span style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
          {dirty
            ? 'Nothing is written until this is saved.'
            : 'Saved to members.json in the band’s folder.'}
        </span>
      </div>

      {/* What the save means for what is already in the folder. */}
      {behind && (
        behind.length ? (
          <div className="notice spread">
            <span>
              <strong>
                {behind.length} song{behind.length === 1 ? '' : 's'} in “{outputSet?.name}”
              </strong>{' '}
              {behind.length === 1 ? 'has' : 'have'} no submix for{' '}
              {[...new Set(behind.flatMap((b) => b.who))].join(', ')} yet, or one written from a different list.
              Preparing them writes it.
            </span>
            <button className="btn primary" onClick={() => setDialog(behind.map((b) => b.title))}>
              Prepare {behind.length === 1 ? 'it' : `those ${behind.length}`}
            </button>
          </div>
        ) : (
          <div className="notice quiet">
            Every song in “{outputSet?.name}” already has the submixes this asks for.
          </div>
        )
      )}

      {dialog && <PrepareSetDialog preselect={dialog} onClose={() => setDialog(null)} />}
    </SettingsSection>
  );
}
