/**
 * How the player's blocks are arranged on this device.
 *
 * Order is global — a guitarist who wants the mixer above the words wants that
 * on every song — while collapsing is per song, because whether you need the
 * lyrics up depends on the song rather than on you.
 *
 * Neither touches which lanes are switched on (see chartPrefs): collapsing a
 * block is about screen space, and must leave your selection to come back to.
 */

export type BlockId = 'chart' | 'versions' | 'mixer' | 'navigate' | 'rig' | 'song';

/**
 * The faders first, then the words, then versions, getting around, and the
 * song's own settings.
 *
 * The mixer is what you reach for while playing; the chart is what you read,
 * and it's long, so having it above pushed the faders off the screen.
 */
export const DEFAULT_ORDER: BlockId[] = ['mixer', 'chart', 'versions', 'navigate', 'rig', 'song'];

const LS_ORDER = 'ls.player.blockOrder';
const LS_COLLAPSED = 'ls.player.collapsed';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — the arrangement simply won't persist */
  }
}

/**
 * The saved order, filtered to blocks that still exist and topped up with any
 * that don't appear yet — so adding a block later puts it in view rather than
 * leaving it invisible to anyone with a saved arrangement.
 */
export function blockOrder(): BlockId[] {
  const saved = readJson<BlockId[]>(LS_ORDER, []);
  const known = saved.filter((id) => DEFAULT_ORDER.includes(id));
  return [...known, ...DEFAULT_ORDER.filter((id) => !known.includes(id))];
}

export function setBlockOrder(order: BlockId[]): void {
  writeJson(LS_ORDER, order);
}

export function isCollapsed(songId: string, block: BlockId): boolean {
  return (readJson<Record<string, BlockId[]>>(LS_COLLAPSED, {})[songId] ?? []).includes(block);
}

export function setCollapsed(songId: string, block: BlockId, collapsed: boolean): void {
  const all = readJson<Record<string, BlockId[]>>(LS_COLLAPSED, {});
  const current = new Set(all[songId] ?? []);
  if (collapsed) current.add(block);
  else current.delete(block);
  if (current.size) all[songId] = [...current];
  else delete all[songId];
  writeJson(LS_COLLAPSED, all);
}
