/**
 * "What changed?" — optional, said once for a prepare. It becomes the summary
 * of each written song's history entry on the band's site, with what Studio
 * saw for itself listed beneath it (songChangelog.ts). Left empty, Studio's
 * own account is the summary.
 */
export default function ChangeNoteField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="field stacked">
      <label htmlFor="change-note">
        What changed? <span className="hint">Optional. Shown on each written song's history on the band's site, above what Studio found changed.</span>
      </label>
      <input
        id="change-note"
        className="text-input"
        type="text"
        maxLength={300}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. New bass take, chorus 2 extended"
      />
    </div>
  );
}
