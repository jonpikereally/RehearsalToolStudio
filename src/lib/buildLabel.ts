/**
 * A build, named for a person: the commit and when it was built.
 *
 * `914c26d` alone answers "which build" only to somebody with the log open.
 * With the date and time beside it — `914c26d (16 Sep 2026, 02:19)` — it
 * answers "is that this morning's?" on its own. The time is the machine's
 * local time, as the person reading it keeps it. A build with no time on
 * record, one made by an older build script, is named by its commit alone.
 */
export function buildLabel(build: string, builtAt?: string | null): string {
  if (!builtAt) return build;
  const when = new Date(builtAt);
  if (Number.isNaN(when.getTime())) return build;
  return `${build} (${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })})`;
}
