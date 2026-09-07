import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import {
  DEFAULT_KEEPS, keepsPart, membersFromRigs, readMembers, submixLabel, writeMembers, type MemberMix,
} from '../lib/members';
import SettingsSection from './SettingsSection';

/**
 * The band, and what each of them keeps on a fader of their own.
 *
 * Everything they don't keep is summed into one submix per song, written
 * beside the stems, so a phone holds four files where it held eight. The
 * names come from the rig files the website writes, and the parts to tick
 * come from the set that is open — which is what a person is actually
 * looking at when they think about what they want separate.
 */
export default function MembersSettings() {
  const { publishFolder, library, currentSet, publishFolderName } = useStore();
  const [members, setMembers] = useState<MemberMix[] | null>(null);
  const [known, setKnown] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const band = await publishFolder();
        if (!band) {
          setMembers([]);
          return;
        }
        setMembers(await readMembers(band));
        setKnown(await membersFromRigs(band).catch(() => []));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setMembers([]);
      }
    })();
  }, [publishFolder, publishFolderName]);

  /** Every part label in the set that is open, for ticking rather than typing. */
  const labels = [
    ...new Set(
      library.songs
        .filter((song) => !currentSet || song.setPath === currentSet)
        .flatMap((song) => song.variants.map((v) => v.name.trim().toLowerCase()))
        .filter(Boolean),
    ),
  ].sort();

  const save = async (next: MemberMix[]) => {
    setMembers(next);
    setBusy(true);
    setError(null);
    try {
      const band = await publishFolder();
      if (!band) throw new Error("The band's folder is not to hand.");
      await writeMembers(band, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const change = (member: MemberMix, patch: Partial<MemberMix>) =>
    void save((members ?? []).map((m) => (m === member ? { ...m, ...patch } : m)));

  const add = (name: string) => {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean || (members ?? []).some((m) => m.member.toLowerCase() === clean.toLowerCase())) return;
    setAdding('');
    void save([...(members ?? []), { member: clean, keeps: [...DEFAULT_KEEPS] }]);
  };

  const on = (members ?? []).filter((m) => !m.off);
  const summary = !members?.length ? (
    <>
      <span className="badge">off</span>no submixes written
    </>
  ) : (
    <>
      <span className={on.length ? 'badge ok' : 'badge'}>{on.length ? `${on.length} submixes` : 'off'}</span>
      {members.map((m) => m.member).join(', ')}
    </>
  );

  return (
    <SettingsSection id="members" title="The band" summary={summary}>
      <div style={{ color: 'var(--text-dim)', fontSize: 13.5, lineHeight: 1.5 }}>
        Each member gets one part per song of everything they are <em>not</em> keeping separate, summed here from the
        multitrack and written beside the stems. Their phone loads that one file in place of the parts inside it — four
        files instead of eight, and a quarter of the decoding. The record itself is never in one, and a submix that
        would stand for fewer than two parts isn’t written.
      </div>

      {error && <div className="notice error">{error}</div>}
      {members === null && <div className="notice">Reading the band’s folder…</div>}

      {members?.map((member) => (
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
              onClick={() => void save((members ?? []).filter((m) => m !== member))}
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
          .filter((name) => !(members ?? []).some((m) => m.member.toLowerCase() === name.toLowerCase()))
          .map((name) => (
            <button key={name} className="chip" disabled={busy} onClick={() => add(name)} title="From the rig files in the band's folder">
              + {name}
            </button>
          ))}
      </div>
    </SettingsSection>
  );
}
