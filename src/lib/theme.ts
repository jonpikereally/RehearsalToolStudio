/**
 * The studio's colour scheme: which surfaces, and which accent.
 *
 * Per machine rather than in the shared library, like the folded Settings
 * panels: it is about the screen and the room it is in, not the music. The
 * values live in styles.css as tokens under `data-theme` and `data-accent` on
 * <html>; this only chooses between them, and is applied before React renders
 * so a light page never opens as a flash of dark.
 */

export type ThemeChoice = 'system' | 'dark' | 'black' | 'light';
export type AccentChoice = 'amber' | 'blue' | 'teal' | 'pink' | 'violet';

export const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'Match the Mac' },
  { id: 'dark', label: 'Dark' },
  { id: 'black', label: 'Black' },
  { id: 'light', label: 'Light' },
];

/** `swatch` is the accent as the dark schemes draw it, for the picker's dot. */
export const ACCENTS: { id: AccentChoice; label: string; swatch: string }[] = [
  { id: 'amber', label: 'Amber', swatch: '#ffb03a' },
  { id: 'blue', label: 'Blue', swatch: '#5aa9ff' },
  { id: 'teal', label: 'Teal', swatch: '#2dd4bf' },
  { id: 'pink', label: 'Pink', swatch: '#f472b6' },
  { id: 'violet', label: 'Violet', swatch: '#a78bfa' },
];

export interface ColorScheme {
  theme: ThemeChoice;
  accent: AccentChoice;
}

const LS_SCHEME = 'ls.colorScheme';
const DEFAULT: ColorScheme = { theme: 'dark', accent: 'amber' };

export function savedScheme(): ColorScheme {
  try {
    const raw = localStorage.getItem(LS_SCHEME);
    const parsed = raw ? (JSON.parse(raw) as Partial<ColorScheme>) : {};
    return {
      theme: THEMES.some((t) => t.id === parsed.theme) ? parsed.theme! : DEFAULT.theme,
      accent: ACCENTS.some((a) => a.id === parsed.accent) ? parsed.accent! : DEFAULT.accent,
    };
  } catch {
    return DEFAULT;
  }
}

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;

/** The scheme actually drawn: "Match the Mac" settles on dark or light. */
function resolved(theme: ThemeChoice): Exclude<ThemeChoice, 'system'> {
  if (theme !== 'system') return theme;
  return systemDark() ? 'dark' : 'light';
}

function apply(scheme: ColorScheme): void {
  const root = document.documentElement;
  const theme = resolved(scheme.theme);
  root.dataset.theme = theme;
  root.dataset.accent = scheme.accent;
  // The window chrome follows the page, where a browser draws any.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#0d0f13');
}

let current = DEFAULT;
const listeners = new Set<(s: ColorScheme) => void>();

export function setScheme(next: Partial<ColorScheme>): void {
  current = { ...current, ...next };
  try {
    localStorage.setItem(LS_SCHEME, JSON.stringify(current));
  } catch {
    /* storage full or blocked — the scheme simply won't outlast this window */
  }
  apply(current);
  for (const fn of listeners) fn(current);
}

export function currentScheme(): ColorScheme {
  return current;
}

export function onSchemeChange(fn: (s: ColorScheme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called once from main.tsx, before the first render. */
export function initTheme(): void {
  current = savedScheme();
  apply(current);
  // Follow the Mac between light and dark while "Match the Mac" is chosen.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (current.theme === 'system') apply(current);
  });
  // Another window of the studio changing the scheme changes this one too.
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_SCHEME) return;
    current = savedScheme();
    apply(current);
    for (const fn of listeners) fn(current);
  });
}
