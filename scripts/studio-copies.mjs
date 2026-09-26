/**
 * The set copies the studio's tools write, named once for everyone.
 *
 * Every set tool writes a copy beside the set — "Yellow (slates).als",
 * "Yellow (rig).als" — never the set itself, and the file server refuses
 * to write over any .als that is not one of these. The page filters the
 * same names out of the sessions it offers to open, and the app's own
 * copy is recognised by its name to keep the original's song ids. Three
 * places, one list: a tool whose copy is named here is a tool whose second
 * run is not refused. Plain JavaScript, so the server can import it
 * without a build and the page can import it as it is.
 */

/** What goes in the brackets: one word per tool, in the order they were added. */
export const STUDIO_COPY_KINDS = ['slates', 'chords', 'info', 'locators', 'rig', 'lyrics', 'rehearsaltool', 'from stems', 'new songs'];

/**
 * A copy's name: the set's name, then the kind in brackets. Lyrics Studio,
 * which writes its own copies as "<set> Lyrics.als", is the one exception.
 */
export const STUDIO_COPY_NAME = new RegExp(`( \\((${STUDIO_COPY_KINDS.join('|')})\\)| Lyrics)\\.als$`, 'i');

/**
 * Where a tool's copy of the set at `setPath` goes, for a `kind` from the
 * list above: beside it, named for what was added.
 * @param {string} setPath
 * @param {string} kind
 */
export function studioCopyPath(setPath, kind) {
  return `${setPath.replace(/\.als$/i, '')} (${kind}).als`;
}

/** Whether a file name is one of the studio's copies. @param {string} name */
export function isStudioCopy(name) {
  return STUDIO_COPY_NAME.test(name);
}
