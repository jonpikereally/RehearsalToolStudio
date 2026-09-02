import { useState, type ReactNode } from 'react';

/**
 * One folding panel on the Settings page.
 *
 * Settings had grown to eight panels of a screen each, so the thing you came
 * for was always three scrolls away. Folding them puts the whole page in view
 * at once — but a closed panel that says only its name is a worse page, not a
 * shorter one, so each carries a summary of what it's set to. What you'd have
 * opened it to read is on the outside of it.
 *
 * Which panels are open is per device, not per user: it's about the screen in
 * front of you, so it lives in localStorage rather than the shared library.
 * Only panels you've actually toggled are stored, which leaves `defaultOpen`
 * free to change later without fighting a saved preference.
 */

export type SectionId =
  | 'source' | 'account' | 'local' | 'members' | 'prepare' | 'slates' | 'lyrics' | 'cues' | 'midi'
  | 'playback' | 'device' | 'storage';

const LS_OPEN = 'ls.settings.open';

function saved(): Partial<Record<SectionId, boolean>> {
  try {
    const raw = localStorage.getItem(LS_OPEN);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function remember(id: SectionId, open: boolean): void {
  try {
    localStorage.setItem(LS_OPEN, JSON.stringify({ ...saved(), [id]: open }));
  } catch {
    /* storage full or blocked — the panel simply won't stay as you left it */
  }
}

export default function SettingsSection({
  id,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  id: SectionId;
  title: string;
  /** What this section is set to, shown while it's closed. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => saved()[id] ?? defaultOpen);

  const toggle = () => {
    setOpen((was) => {
      remember(id, !was);
      return !was;
    });
  };

  return (
    <section className="panel setting-section">
      <button
        className="section-head"
        onClick={toggle}
        aria-expanded={open}
        title={open ? `Hide ${title.toLowerCase()}` : `Show ${title.toLowerCase()}`}
      >
        <span className={open ? 'arrow open' : 'arrow'} aria-hidden>
          ▸
        </span>
        <strong>{title}</strong>
        {!open && summary != null && <span className="section-summary">{summary}</span>}
      </button>
      {open && <div className="stack section-body">{children}</div>}
    </section>
  );
}
