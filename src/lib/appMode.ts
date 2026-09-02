/**
 * Rehearsal Tool Studio is one tool for one machine: it reads Ableton sets
 * off this disk, prepares them into folders anyone can play, and plays them.
 * It grew out of a codebase shared with the band's website, and a few of the
 * flags that told the two apart are kept here as constants — so the code that
 * asks "may I write to the library?" still has something to ask.
 */

export const APP_NAME = 'Rehearsal Tool Studio';

/** The studio always may: the library is its own, on its own disk. */
export const canEditLibrary = true;

/** Transposing, speed and patch changes alter what *you* hear; always yours to set. */
export const canEditForYourself = true;
