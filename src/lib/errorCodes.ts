/**
 * Every error the studio shows, by code.
 *
 * A code names one failure, is never reused for another, and outlives any
 * rewording of its message — so somebody asking an LLM for help can start
 * from the code. The public list, docs/errors.md, is written from this by
 * `npm run errors`, and the self-test fails when they disagree, when a code
 * is used that is not here, or when an error is shown without one.
 *
 * Codes are RTS-<area>-<nn>. The Mac app's and Lyrics engine's codes live
 * here too, though their code is Swift and Python: one list, one page.
 */

export const ERROR_LIST_URL = 'https://github.com/jonpikereally/RehearsalToolStudio/blob/main/docs/errors.md';

export interface ErrorEntry {
  /** Where in the studio it happens. */
  area: string;
  /** What went wrong, in a line. */
  title: string;
  /** What it usually means and what to do about it. */
  help: string;
}

export const ERROR_AREAS: Record<string, string> = {
  APP: 'The studio window',
  LCH: 'Opening a set',
  ONB: 'First run',
  OPN: 'Settings: folders',
  SET: 'Set tools',
  SLT: 'Set tools ▸ Slates',
  LYR: 'Set tools ▸ Lyrics',
  LSE: 'Lyrics engine',
  NEW: 'Set tools ▸ New songs from stems',
  PREP: 'Prepare the set',
  PSG: 'Prepare a song',
  UPD: 'Update the band',
  AUTO: 'Auto-update on save',
  BND: 'The band',
  PLY: 'The player',
  BNC: 'Print a mix',
  TC: 'Timecode',
  OUT: 'Audio output',
  MIDI: 'MIDI',
  MAC: 'The Mac app',
};

export const ERROR_CODES: Record<string, ErrorEntry> = {
  'RTS-APP-01': {
    area: 'APP',
    title: 'What was dropped on the window could not be opened',
    help: 'A folder or .als dropped on the window or the Dock icon could not be read. Check it still exists and that macOS has given Rehearsal Tool Studio access to the folder it is in (System Settings ▸ Privacy & Security ▸ Files and Folders).',
  },
  'RTS-APP-02': {
    area: 'APP',
    title: 'What was chosen in the Open window could not be opened',
    help: 'The session or set folder chosen at launch could not be read. Choose it again; if it is in Dropbox, make sure it has finished syncing and is available offline.',
  },
  'RTS-APP-03': {
    area: 'APP',
    title: "The studio's library could not be read or saved",
    help: "The studio keeps a library file in your sets folder. It could not be read or written — usually the folder moved, Dropbox has it locked mid-sync, or macOS refused access. Rescan; if it persists, choose the sets folder again in Settings.",
  },
  'RTS-APP-04': {
    area: 'APP',
    title: 'A sync conflict in the library could not be resolved',
    help: 'Two copies of the library file disagreed (often two studios on one sets folder, or a Dropbox conflicted copy). Try again; only run one studio against a sets folder at a time.',
  },
  'RTS-APP-05': {
    area: 'APP',
    title: "The studio's page stopped",
    help: 'Something in the page threw while drawing. Reload. The error and its stack are on screen and in the launch log; give them to your LLM with this code.',
  },
  'RTS-LCH-01': {
    area: 'LCH',
    title: 'The session could not be opened',
    help: 'The Ableton session chosen could not be read. Save it in Live, check it is not a backup copy, and choose it again.',
  },
  'RTS-LCH-02': {
    area: 'LCH',
    title: 'The set folder could not be used',
    help: "The set folder in the band's Dropbox could not be read or created. Check the band's folder in Settings and that Dropbox is running.",
  },
  'RTS-ONB-01': {
    area: 'ONB',
    title: 'The folder could not be chosen',
    help: 'The folder dialog failed or the folder could not be read. Try again; choose a folder on this Mac that you can open in the Finder.',
  },
  'RTS-OPN-01': {
    area: 'OPN',
    title: 'The folder could not be chosen',
    help: 'Choosing or remembering a folder failed. Try again; if it is in Dropbox, make sure the Dropbox app is running.',
  },
  'RTS-SET-00': {
    area: 'SET',
    title: 'A set tool failed',
    help: 'A Set tools action failed without a more specific code. The message says what; save the set in Live and try again.',
  },
  'RTS-SET-01': {
    area: 'SET',
    title: 'The set could not be read',
    help: 'The .als could not be read or parsed. Save it in Live (a half-written set cannot be read) and pick it again.',
  },
  'RTS-SET-02': {
    area: 'SET',
    title: 'No songs chosen for slates',
    help: 'Choose at least one song under "Working on" before adding slates.',
  },
  'RTS-SET-03': {
    area: 'SET',
    title: 'Slates could not be written',
    help: "Speaking or writing the slates failed. The slate voice helper may not be running — quit and reopen the studio — or the set's folder could not be written.",
  },
  'RTS-SET-04': {
    area: 'SET',
    title: 'No chords to write: every song already has them',
    help: 'Every chosen song already has chords in the chosen notation. Choose another notation or other songs.',
  },
  'RTS-SET-05': {
    area: 'SET',
    title: 'Chords could not be written',
    help: "Writing the chord track into a copy of the set failed. The message says why; check the set has a MIDI track with clips to model one on, and that the set's folder can be written.",
  },
  'RTS-SET-06': {
    area: 'SET',
    title: 'No song info to write',
    help: 'Tick at least one kind of information, for songs that have it.',
  },
  'RTS-SET-07': {
    area: 'SET',
    title: 'Song info could not be written',
    help: "Writing the song info clips into a copy of the set failed. The message says why; check the set's folder can be written.",
  },
  'RTS-SET-08': {
    area: 'SET',
    title: 'No locator text to write',
    help: 'Choose at least one song.',
  },
  'RTS-SET-09': {
    area: 'SET',
    title: 'Locator text could not be written',
    help: "Writing locator names as MIDI clips failed. The message says why; check the set's folder can be written.",
  },
  'RTS-SET-10': {
    area: 'SET',
    title: 'The return mix could not be printed',
    help: "Summing the return bus for the song failed — often a part's audio file is missing or unreadable. Check the song plays in the player first.",
  },
  'RTS-SET-11': {
    area: 'SET',
    title: 'No patch changes to write',
    help: "None are programmed in the player for these songs and there are no rig files from the band. Program some, or choose the band's folder so theirs can be found.",
  },
  'RTS-SET-12': {
    area: 'SET',
    title: 'Patch changes could not be written',
    help: "Writing the patch-change MIDI clips into a copy of the set failed. The message says why; check the set's folder can be written.",
  },
  'RTS-SLT-01': {
    area: 'SLT',
    title: "The set's songs could not be read for slates",
    help: 'Reading the songs to make slates for failed. Rescan, or pick the set again.',
  },
  'RTS-SLT-02': {
    area: 'SLT',
    title: 'The file could not be opened',
    help: 'The file picked for slates could not be read. Pick it again.',
  },
  'RTS-SLT-03': {
    area: 'SLT',
    title: 'The slates could not be spoken',
    help: "The voice helper did not answer. Quit and reopen the studio; macOS's voices must be installed (System Settings ▸ Accessibility ▸ Spoken Content).",
  },
  'RTS-SLT-04': {
    area: 'SLT',
    title: 'The slates could not be written into the project',
    help: "Writing the spoken slates into the project failed. Check the project's folder can be written and the set is saved.",
  },
  'RTS-SLT-05': {
    area: 'SLT',
    title: 'A single slate could not be made',
    help: 'Speaking or saving one slate failed. Try again; quit and reopen the studio if the voice helper is not answering.',
  },
  'RTS-SLT-06': {
    area: 'SLT',
    title: 'The slate voice helper is not running',
    help: 'Slates are spoken by a small helper the studio starts. Quit and reopen the studio to start it again.',
  },
  'RTS-LYR-01': {
    area: 'LYR',
    title: 'The lyrics engine did not start',
    help: 'The engine (Whisper, in Python) failed to start. Its first start fetches Python and its models and needs the network; its log is ~/Library/Logs/Rehearsal Tool Studio/lyrics-studio.log.',
  },
  'RTS-LYR-02': {
    area: 'LYR',
    title: "A song's lyrics could not be heard",
    help: 'Listening to the chosen track failed. If the message carries an RTS-LSE code, look that up; otherwise try another track, or quit and reopen the studio.',
  },
  'RTS-LYR-03': {
    area: 'LYR',
    title: 'Lyric clips could not be written',
    help: "Writing the +LYRICS track into a copy of the set failed. Check the set has a MIDI track with clips to model one on, and that the set's folder can be written.",
  },
  'RTS-LYR-04': {
    area: 'LYR',
    title: 'The song has no audio track to listen to',
    help: 'No audio track has a clip inside this song. Check the song in Live.',
  },
  'RTS-LYR-05': {
    area: 'LYR',
    title: 'No words were heard',
    help: 'The track was listened to but no words came back. Choose a track with the lead vocal on it (Ref Vox), or tick "Isolate the voice first" for a track with music on it.',
  },
  'RTS-LYR-06': {
    area: 'LYR',
    title: 'Stopped before it was listened to',
    help: 'The run was stopped before this song. Tick it and run again.',
  },
  'RTS-LYR-07': {
    area: 'LYR',
    title: 'The lyrics folder or a lyric file could not be read',
    help: "The lyrics folder could not be listed, or a song's lyric file in it could not be read; the song is listened to without it. If the message carries an RTS-LSE code, look that up. Check the folder is still there and synced, and choose it again in Set tools ▸ Lyrics.",
  },
  'RTS-LSE-00': {
    area: 'LSE',
    title: 'The lyrics engine refused a request',
    help: 'The engine answered with an error that has no more specific code. The message says what; quit and reopen the studio, and check ~/Library/Logs/Rehearsal Tool Studio/lyrics-studio.log.',
  },
  'RTS-LSE-01': {
    area: 'LSE',
    title: 'Audio file not found',
    help: "The set names an audio file for the track that is not on this Mac at that path. Open the set in Live and let it find missing files (File ▸ Manage Files), save, and try again. A Dropbox file that is online-only must be made available offline.",
  },
  'RTS-LSE-02': {
    area: 'LSE',
    title: 'macOS refused the lyrics engine access to the audio',
    help: "macOS's folder permissions stopped the engine reading the file. The studio restarts the engine once by itself; if it still fails, quit the studio, open System Settings ▸ Privacy & Security ▸ Files and Folders, allow Rehearsal Tool Studio the folder the audio is in, and try again.",
  },
  'RTS-LSE-03': {
    area: 'LSE',
    title: 'ffmpeg could not read the audio file',
    help: "ffmpeg, which cuts the song out of the track's file, could not read it. The message has ffmpeg's own words: a damaged or unusual file, or a format it cannot decode. Re-export the file from Live as WAV and try again.",
  },
  'RTS-LSE-04': {
    area: 'LSE',
    title: 'ffmpeg is not available',
    help: 'The engine needs ffmpeg and could not find or fetch one. With the network on, quit and reopen the studio so it can fetch its own; or install it: brew install ffmpeg.',
  },
  'RTS-LSE-05': {
    area: 'LSE',
    title: 'No lyrics found on that track',
    help: "The track's audio was read but nothing was heard, or every part was too short. Choose the vocal track, or tick Isolate the voice first.",
  },
  'RTS-LSE-06': {
    area: 'LSE',
    title: 'The audio track is not in the set',
    help: 'The track chosen is no longer in the set as saved. Save the set in Live and run again.',
  },
  'RTS-LSE-07': {
    area: 'LSE',
    title: 'The track has no audio on it',
    help: 'The chosen track has no audio clips. Choose another track.',
  },
  'RTS-LSE-08': {
    area: 'LSE',
    title: 'Not a Live set the engine can work on',
    help: 'The set path given to the engine is not a readable .als. Save the set in Live and try again.',
  },
  'RTS-LSE-09': {
    area: 'LSE',
    title: "Part of the track's audio could not be cut",
    help: 'Cutting the song out of the audio file failed for a reason other than ffmpeg reading it. The message says what; try again, and check free disk space.',
  },
  'RTS-LSE-10': {
    area: 'LSE',
    title: 'The transcription stopped with an error',
    help: 'Whisper or the engine itself failed while listening. The message has the Python error; quit and reopen the studio and try again, and see ~/Library/Logs/Rehearsal Tool Studio/lyrics-studio.log.',
  },
  'RTS-LSE-11': {
    area: 'LSE',
    title: 'The audio file could not be opened',
    help: 'The file is where the set says but could not be opened, for a reason other than macOS permission. The message has the system\'s words; check the file in the Finder, and that Dropbox has it downloaded.',
  },
  'RTS-LSE-12': {
    area: 'LSE',
    title: 'A lyric file could not be read',
    help: "The engine could not get lines of lyrics out of the file: a kind it does not read, a damaged file, one with no lines in it, or a Pages document saved without a preview. Save the lyrics as plain text (.txt), Word (.docx) or PDF into the lyrics folder and run again.",
  },
  'RTS-NEW-01': {
    area: 'NEW',
    title: 'Some stem files could not be read',
    help: 'The files named could not be read and were left out. Check they are audio files and fully synced.',
  },
  'RTS-NEW-02': {
    area: 'NEW',
    title: 'The folder of stems could not be read',
    help: 'Reading the chosen folder of stems failed. Choose it again.',
  },
  'RTS-NEW-03': {
    area: 'NEW',
    title: 'The new songs could not be written',
    help: "Laying the new songs out in a copy of the set failed. Save the set in Live and check the set's folder can be written.",
  },
  'RTS-NEW-04': {
    area: 'NEW',
    title: 'A song by that name is already in the set',
    help: 'Rename the new song, or untick it.',
  },
  'RTS-PREP-01': {
    area: 'PREP',
    title: 'The set could not be read for preparing',
    help: 'The .als could not be read or parsed. Save it in Live and open the dialog again.',
  },
  'RTS-PREP-02': {
    area: 'PREP',
    title: "Files written, but the band's library was not",
    help: "The songs were prepared, but library.json in the band's folder could not be written, so the band does not see them yet. Check the band's folder in Settings, then prepare again or press Update the band.",
  },
  'RTS-PREP-03': {
    area: 'PREP',
    title: 'The prepare was stopped',
    help: 'You stopped it. The message says whether anything had been written over; Undo puts it back, and running again rewrites the rest.',
  },
  'RTS-PREP-04': {
    area: 'PREP',
    title: 'Preparing the set failed',
    help: "Writing the prepared songs failed. The message says why — often an audio file could not be read, or the band's folder could not be written.",
  },
  'RTS-PREP-05': {
    area: 'PREP',
    title: 'The prepare could not be undone',
    help: 'Putting back the songs the last prepare wrote over failed. Their earlier versions are in the folder Dropbox keeps (version history) if needed.',
  },
  'RTS-PREP-06': {
    area: 'PREP',
    title: 'The silent parts could not be removed',
    help: 'Removing the parts that turned out silent from the prepared songs failed. The message says why; it is safe to leave them.',
  },
  'RTS-PREP-07': {
    area: 'PREP',
    title: 'The prepare could not start',
    help: "Choosing or reading the band's folder failed. Choose it again.",
  },
  'RTS-PREP-08': {
    area: 'PREP',
    title: "Click or cue samples can't be read",
    help: 'Samples the click or cue parts play are in a folder the studio has not been allowed. Use "Allow a folder…" to allow it (Settings ▸ Samples elsewhere), then prepare again.',
  },
  'RTS-PSG-01': {
    area: 'PSG',
    title: 'The song could not be read for preparing',
    help: 'The set could not be read, or the song is no longer in it, or it is not on AbleSet\'s setlist. The message says which.',
  },
  'RTS-PSG-02': {
    area: 'PSG',
    title: 'The silent parts could not be removed',
    help: 'Removing silent parts from the prepared song failed. It is safe to leave them.',
  },
  'RTS-PSG-03': {
    area: 'PSG',
    title: 'The song prepare was stopped',
    help: 'You stopped it. Parts already written are on disk; running it again rewrites them.',
  },
  'RTS-PSG-04': {
    area: 'PSG',
    title: 'Preparing the song failed',
    help: "Writing the song's parts failed. The message says why — often an audio file could not be read, or the band's folder could not be written.",
  },
  'RTS-PSG-05': {
    area: 'PSG',
    title: "The song's words and sections could not be updated",
    help: 'Rewriting the words and sections for the song failed. The message says why.',
  },
  'RTS-UPD-01': {
    area: 'UPD',
    title: 'Updating the band failed',
    help: "Refreshing what the band sees failed. The message says why; check the band's folder in Settings.",
  },
  'RTS-UPD-02': {
    area: 'UPD',
    title: "The band's folder could not be chosen",
    help: "Choosing the band's folder failed. Choose it again.",
  },
  'RTS-AUTO-01': {
    area: 'AUTO',
    title: "An update after a save didn't finish",
    help: 'Updating the prepared set after Live saved it failed part way. The message says why; Undo puts back anything written over, and the next save tries again.',
  },
  'RTS-AUTO-02': {
    area: 'AUTO',
    title: "Auto-update has no band's folder to write to",
    help: "Auto-update writes where a prepare last wrote. Prepare the set once by hand, choosing the band's folder; saves update it after that.",
  },
  'RTS-AUTO-03': {
    area: 'AUTO',
    title: 'The auto-update could not be undone',
    help: "Putting back the songs the last auto-update wrote over failed. Their earlier versions are in Dropbox's version history if needed.",
  },
  'RTS-AUTO-04': {
    area: 'AUTO',
    title: 'The auto-update was stopped',
    help: 'You stopped it. The message says whether anything had been written over; Undo puts it back, and the next save writes the rest.',
  },
  'RTS-BND-01': {
    area: 'BND',
    title: "The band's settings could not be read",
    help: "Reading the band's mixes or rig files from their folder failed. Check the band's folder in Settings.",
  },
  'RTS-BND-02': {
    area: 'BND',
    title: "The band's settings could not be saved",
    help: "Writing to the band's folder failed. Check it is still there and Dropbox is running.",
  },
  'RTS-PLY-01': {
    area: 'PLY',
    title: 'The song could not be loaded',
    help: "Decoding the song's audio failed — a file is missing, unreadable, or in a folder the studio has not been allowed. Rescan; allow outside folders in Settings ▸ Samples elsewhere.",
  },
  'RTS-BNC-01': {
    area: 'BNC',
    title: 'The mix could not be printed',
    help: 'Rendering or saving the mix failed. The message says why; check there is disk space and the destination can be written.',
  },
  'RTS-TC-01': {
    area: 'TC',
    title: 'The timecode could not be saved',
    help: 'Writing the timecode setting failed. Try again.',
  },
  'RTS-OUT-01': {
    area: 'OUT',
    title: 'The audio output could not be changed',
    help: "The chosen output device could not be used. Check it is connected and shows in macOS's Sound settings.",
  },
  'RTS-MIDI-01': {
    area: 'MIDI',
    title: 'The MIDI test did not pass',
    help: 'The MIDI check found a problem; the message says which. This window has no Web MIDI, so MIDI is written into the set rather than sent live.',
  },
  'RTS-MAC-01': {
    area: 'MAC',
    title: "The studio didn't start",
    help: "Nothing answered on port 5177 after launch. The launcher's log (~/Library/Logs/Rehearsal Tool Studio/launch.log) says why. Quit and reopen; another app using port 5177 is a common cause.",
  },
  'RTS-MAC-02': {
    area: 'MAC',
    title: "The studio's page stopped twice in a minute",
    help: 'WebKit shut the page down, usually for memory. Reload (⌘R); if it keeps happening, close song runs holding many songs and rescan.',
  },
  'RTS-MAC-03': {
    area: 'MAC',
    title: "The studio didn't answer the update check",
    help: "Nothing was listening on port 5177 when checking for updates. The launcher's log says why; quit and reopen.",
  },
  'RTS-MAC-04': {
    area: 'MAC',
    title: 'Updating must wait: a set is being written',
    help: 'An update restarts the studio, which would stop a prepare mid-write. Check for updates again when it has finished.',
  },
  'RTS-MAC-05': {
    area: 'MAC',
    title: "The update couldn't start",
    help: 'The script that swaps in the new app could not be written or run. Install the newest installer by hand from GitHub Releases.',
  },
  'RTS-MAC-06': {
    area: 'MAC',
    title: "The update didn't download",
    help: 'GitHub did not send the update. Check the network and try again, or download the installer from GitHub Releases.',
  },
  'RTS-MAC-07': {
    area: 'MAC',
    title: "A download didn't finish",
    help: 'A file the page offered to download failed. Try again.',
  },
  'RTS-MAC-08': {
    area: 'MAC',
    title: 'The new app could not be swapped in',
    help: 'The update downloaded but could not replace the app (no password given, or no permission). The old app is kept. Try the update again, or install the newest installer by hand.',
  },
};

const CODE = /\[?(RTS-[A-Z]{2,5}-\d{2})\]?/;

/** The code a message carries, and the message without it. */
export function splitCode(text: string): { code: string | null; message: string } {
  const m = CODE.exec(text);
  if (!m) return { code: null, message: text };
  const message = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/^[\s:·—-]+/, '').trim();
  return { code: m[1], message };
}

/**
 * An error's message, carrying a code: its own when something deeper already
 * gave it one — the engine's, say — else the one for where it surfaced.
 */
export function coded(code: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return CODE.test(message) ? message : `[${code}] ${message}`;
}

export function errorListLink(code: string): string {
  return `${ERROR_LIST_URL}#${code.toLowerCase()}`;
}

export function errorHover(code: string): string {
  return `Error ${code}. Check the error list for what it means and what to do: ${ERROR_LIST_URL} — or give your LLM the code and this message.`;
}
