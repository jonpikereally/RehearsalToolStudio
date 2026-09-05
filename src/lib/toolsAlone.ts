/**
 * The set tools, opened with no set.
 *
 * A launch chooses a set before anything else, because everything is about
 * one — except two of the set tools. A slate can be spoken from typed words,
 * and Lyrics Studio takes any file you hand it, and neither should wait on a
 * set being chosen when there is only a title to say. So the chooser offers
 * a way past itself, remembered for this window only: the next launch asks
 * for a set again, as it should.
 */

const KEY = 'ls.tools.alone';

export function toolsAlone(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setToolsAlone(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to remember with; the chooser simply comes back */
  }
}
