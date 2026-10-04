# Rehearsal Tool Studio — error codes

Every error Rehearsal Tool Studio shows carries a code like `RTS-LYR-02`, beside its message. Find the code below for what it means and what to do.

To get help from an LLM (ChatGPT, Claude, …), give it the code, the full message, and this page:

> I got error RTS-XXX-00 in Rehearsal Tool Studio: "<the message>". The error list is at https://github.com/jonpikereally/RehearsalToolStudio/blob/main/docs/errors.md — what does it mean and how do I fix it?

Logs that help with any of them, on the Mac running the studio: `~/Library/Logs/Rehearsal Tool Studio/` (`launch.log`, `lyrics-studio.log`, `update.log`).

_This page is written from `src/lib/errorCodes.ts` by `npm run errors`; edit that, not this._

## The studio window

### RTS-APP-01

**What was dropped on the window could not be opened**

A folder or .als dropped on the window or the Dock icon could not be read. Check it still exists and that macOS has given Rehearsal Tool Studio access to the folder it is in (System Settings ▸ Privacy & Security ▸ Files and Folders).

### RTS-APP-02

**What was chosen in the Open window could not be opened**

The session or set folder chosen at launch could not be read. Choose it again; if it is in Dropbox, make sure it has finished syncing and is available offline.

### RTS-APP-03

**The studio's library could not be read or saved**

The studio keeps a library file in your sets folder. It could not be read or written — usually the folder moved, Dropbox has it locked mid-sync, or macOS refused access. Rescan; if it persists, choose the sets folder again in Settings.

### RTS-APP-04

**A sync conflict in the library could not be resolved**

Two copies of the library file disagreed (often two studios on one sets folder, or a Dropbox conflicted copy). Try again; only run one studio against a sets folder at a time.

### RTS-APP-05

**The studio's page stopped**

Something in the page threw while drawing. Reload. The error and its stack are on screen and in the launch log; give them to your LLM with this code.

## Opening a set

### RTS-LCH-01

**The session could not be opened**

The Ableton session chosen could not be read. Save it in Live, check it is not a backup copy, and choose it again.

### RTS-LCH-02

**The set folder could not be used**

The set folder in the band's Dropbox could not be read or created. Check the band's folder in Settings and that Dropbox is running.

## First run

### RTS-ONB-01

**The folder could not be chosen**

The folder dialog failed or the folder could not be read. Try again; choose a folder on this Mac that you can open in the Finder.

## Settings: folders

### RTS-OPN-01

**The folder could not be chosen**

Choosing or remembering a folder failed. Try again; if it is in Dropbox, make sure the Dropbox app is running.

## Set tools

### RTS-SET-00

**A set tool failed**

A Set tools action failed without a more specific code. The message says what; save the set in Live and try again.

### RTS-SET-01

**The set could not be read**

The .als could not be read or parsed. Save it in Live (a half-written set cannot be read) and pick it again.

### RTS-SET-02

**No songs chosen for slates**

Choose at least one song under "Working on" before adding slates.

### RTS-SET-03

**Slates could not be written**

Speaking or writing the slates failed. The slate voice helper may not be running — quit and reopen the studio — or the set's folder could not be written.

### RTS-SET-04

**No chords to write: every song already has them**

Every chosen song already has chords in the chosen notation. Choose another notation or other songs.

### RTS-SET-05

**Chords could not be written**

Writing the chord track into a copy of the set failed. The message says why; check the set has a MIDI track with clips to model one on, and that the set's folder can be written.

### RTS-SET-06

**No song info to write**

Tick at least one kind of information, for songs that have it.

### RTS-SET-07

**Song info could not be written**

Writing the song info clips into a copy of the set failed. The message says why; check the set's folder can be written.

### RTS-SET-08

**No locator text to write**

Choose at least one song.

### RTS-SET-09

**Locator text could not be written**

Writing locator names as MIDI clips failed. The message says why; check the set's folder can be written.

### RTS-SET-10

**The return mix could not be printed**

Summing the return bus for the song failed — often a part's audio file is missing or unreadable. Check the song plays in the player first.

### RTS-SET-11

**No patch changes to write**

None are programmed in the player for these songs and there are no rig files from the band. Program some, or choose the band's folder so theirs can be found.

### RTS-SET-12

**Patch changes could not be written**

Writing the patch-change MIDI clips into a copy of the set failed. The message says why; check the set's folder can be written.

## Set tools ▸ Slates

### RTS-SLT-01

**The set's songs could not be read for slates**

Reading the songs to make slates for failed. Rescan, or pick the set again.

### RTS-SLT-02

**The file could not be opened**

The file picked for slates could not be read. Pick it again.

### RTS-SLT-03

**The slates could not be spoken**

The voice helper did not answer. Quit and reopen the studio; macOS's voices must be installed (System Settings ▸ Accessibility ▸ Spoken Content).

### RTS-SLT-04

**The slates could not be written into the project**

Writing the spoken slates into the project failed. Check the project's folder can be written and the set is saved.

### RTS-SLT-05

**A single slate could not be made**

Speaking or saving one slate failed. Try again; quit and reopen the studio if the voice helper is not answering.

### RTS-SLT-06

**The slate voice helper is not running**

Slates are spoken by a small helper the studio starts. Quit and reopen the studio to start it again.

## Set tools ▸ Lyrics

### RTS-LYR-01

**The lyrics engine did not start**

The engine (Whisper, in Python) failed to start. Its first start fetches Python and its models and needs the network; its log is ~/Library/Logs/Rehearsal Tool Studio/lyrics-studio.log.

### RTS-LYR-02

**A song's lyrics could not be heard**

Listening to the chosen track failed. If the message carries an RTS-LSE code, look that up; otherwise try another track, or quit and reopen the studio.

### RTS-LYR-03

**Lyric clips could not be written**

Writing the +LYRICS track into a copy of the set failed. Check the set has a MIDI track with clips to model one on, and that the set's folder can be written.

### RTS-LYR-04

**The song has no audio track to listen to**

No audio track has a clip inside this song. Check the song in Live.

### RTS-LYR-05

**No words were heard**

The track was listened to but no words came back. Choose a track with the lead vocal on it (Ref Vox), or tick "Isolate the voice first" for a track with music on it.

### RTS-LYR-06

**Stopped before it was listened to**

The run was stopped before this song. Tick it and run again.

## Lyrics engine

### RTS-LSE-00

**The lyrics engine refused a request**

The engine answered with an error that has no more specific code. The message says what; quit and reopen the studio, and check ~/Library/Logs/Rehearsal Tool Studio/lyrics-studio.log.

### RTS-LSE-01

**Audio file not found**

The set names an audio file for the track that is not on this Mac at that path. Open the set in Live and let it find missing files (File ▸ Manage Files), save, and try again. A Dropbox file that is online-only must be made available offline.

### RTS-LSE-02

**macOS refused the lyrics engine access to the audio**

macOS's folder permissions stopped the engine reading the file. The studio restarts the engine once by itself; if it still fails, quit the studio, open System Settings ▸ Privacy & Security ▸ Files and Folders, allow Rehearsal Tool Studio the folder the audio is in, and try again.

### RTS-LSE-03

**ffmpeg could not read the audio file**

ffmpeg, which cuts the song out of the track's file, could not read it. The message has ffmpeg's own words: a damaged or unusual file, or a format it cannot decode. Re-export the file from Live as WAV and try again.

### RTS-LSE-04

**ffmpeg is not available**

The engine needs ffmpeg and could not find or fetch one. With the network on, quit and reopen the studio so it can fetch its own; or install it: brew install ffmpeg.

### RTS-LSE-05

**No lyrics found on that track**

The track's audio was read but nothing was heard, or every part was too short. Choose the vocal track, or tick Isolate the voice first.

### RTS-LSE-06

**The audio track is not in the set**

The track chosen is no longer in the set as saved. Save the set in Live and run again.

### RTS-LSE-07

**The track has no audio on it**

The chosen track has no audio clips. Choose another track.

### RTS-LSE-08

**Not a Live set the engine can work on**

The set path given to the engine is not a readable .als. Save the set in Live and try again.

### RTS-LSE-09

**Part of the track's audio could not be cut**

Cutting the song out of the audio file failed for a reason other than ffmpeg reading it. The message says what; try again, and check free disk space.

### RTS-LSE-10

**The transcription stopped with an error**

Whisper or the engine itself failed while listening. The message has the Python error; quit and reopen the studio and try again, and see ~/Library/Logs/Rehearsal Tool Studio/lyrics-studio.log.

### RTS-LSE-11

**The audio file could not be opened**

The file is where the set says but could not be opened, for a reason other than macOS permission. The message has the system's words; check the file in the Finder, and that Dropbox has it downloaded.

## Set tools ▸ New songs from stems

### RTS-NEW-01

**Some stem files could not be read**

The files named could not be read and were left out. Check they are audio files and fully synced.

### RTS-NEW-02

**The folder of stems could not be read**

Reading the chosen folder of stems failed. Choose it again.

### RTS-NEW-03

**The new songs could not be written**

Laying the new songs out in a copy of the set failed. Save the set in Live and check the set's folder can be written.

### RTS-NEW-04

**A song by that name is already in the set**

Rename the new song, or untick it.

## Prepare the set

### RTS-PREP-01

**The set could not be read for preparing**

The .als could not be read or parsed. Save it in Live and open the dialog again.

### RTS-PREP-02

**Files written, but the band's library was not**

The songs were prepared, but library.json in the band's folder could not be written, so the band does not see them yet. Check the band's folder in Settings, then prepare again or press Update the band.

### RTS-PREP-03

**The prepare was stopped**

You stopped it. The message says whether anything had been written over; Undo puts it back, and running again rewrites the rest.

### RTS-PREP-04

**Preparing the set failed**

Writing the prepared songs failed. The message says why — often an audio file could not be read, or the band's folder could not be written.

### RTS-PREP-05

**The prepare could not be undone**

Putting back the songs the last prepare wrote over failed. Their earlier versions are in the folder Dropbox keeps (version history) if needed.

### RTS-PREP-06

**The silent parts could not be removed**

Removing the parts that turned out silent from the prepared songs failed. The message says why; it is safe to leave them.

### RTS-PREP-07

**The prepare could not start**

Choosing or reading the band's folder failed. Choose it again.

### RTS-PREP-08

**Click or cue samples can't be read**

Samples the click or cue parts play are in a folder the studio has not been allowed. Use "Allow a folder…" to allow it (Settings ▸ Samples elsewhere), then prepare again.

## Prepare a song

### RTS-PSG-01

**The song could not be read for preparing**

The set could not be read, or the song is no longer in it, or it is not on AbleSet's setlist. The message says which.

### RTS-PSG-02

**The silent parts could not be removed**

Removing silent parts from the prepared song failed. It is safe to leave them.

### RTS-PSG-03

**The song prepare was stopped**

You stopped it. Parts already written are on disk; running it again rewrites them.

### RTS-PSG-04

**Preparing the song failed**

Writing the song's parts failed. The message says why — often an audio file could not be read, or the band's folder could not be written.

### RTS-PSG-05

**The song's words and sections could not be updated**

Rewriting the words and sections for the song failed. The message says why.

## Update the band

### RTS-UPD-01

**Updating the band failed**

Refreshing what the band sees failed. The message says why; check the band's folder in Settings.

### RTS-UPD-02

**The band's folder could not be chosen**

Choosing the band's folder failed. Choose it again.

## Auto-update on save

### RTS-AUTO-01

**An update after a save didn't finish**

Updating the prepared set after Live saved it failed part way. The message says why; Undo puts back anything written over, and the next save tries again.

### RTS-AUTO-02

**Auto-update has no band's folder to write to**

Auto-update writes where a prepare last wrote. Prepare the set once by hand, choosing the band's folder; saves update it after that.

### RTS-AUTO-03

**The auto-update could not be undone**

Putting back the songs the last auto-update wrote over failed. Their earlier versions are in Dropbox's version history if needed.

### RTS-AUTO-04

**The auto-update was stopped**

You stopped it. The message says whether anything had been written over; Undo puts it back, and the next save writes the rest.

## The band

### RTS-BND-01

**The band's settings could not be read**

Reading the band's mixes or rig files from their folder failed. Check the band's folder in Settings.

### RTS-BND-02

**The band's settings could not be saved**

Writing to the band's folder failed. Check it is still there and Dropbox is running.

## The player

### RTS-PLY-01

**The song could not be loaded**

Decoding the song's audio failed — a file is missing, unreadable, or in a folder the studio has not been allowed. Rescan; allow outside folders in Settings ▸ Samples elsewhere.

## Print a mix

### RTS-BNC-01

**The mix could not be printed**

Rendering or saving the mix failed. The message says why; check there is disk space and the destination can be written.

## Timecode

### RTS-TC-01

**The timecode could not be saved**

Writing the timecode setting failed. Try again.

## Audio output

### RTS-OUT-01

**The audio output could not be changed**

The chosen output device could not be used. Check it is connected and shows in macOS's Sound settings.

## MIDI

### RTS-MIDI-01

**The MIDI test did not pass**

The MIDI check found a problem; the message says which. This window has no Web MIDI, so MIDI is written into the set rather than sent live.

## The Mac app

### RTS-MAC-01

**The studio didn't start**

Nothing answered on port 5177 after launch. The launcher's log (~/Library/Logs/Rehearsal Tool Studio/launch.log) says why. Quit and reopen; another app using port 5177 is a common cause.

### RTS-MAC-02

**The studio's page stopped twice in a minute**

WebKit shut the page down, usually for memory. Reload (⌘R); if it keeps happening, close song runs holding many songs and rescan.

### RTS-MAC-03

**The studio didn't answer the update check**

Nothing was listening on port 5177 when checking for updates. The launcher's log says why; quit and reopen.

### RTS-MAC-04

**Updating must wait: a set is being written**

An update restarts the studio, which would stop a prepare mid-write. Check for updates again when it has finished.

### RTS-MAC-05

**The update couldn't start**

The script that swaps in the new app could not be written or run. Install the newest installer by hand from GitHub Releases.

### RTS-MAC-06

**The update didn't download**

GitHub did not send the update. Check the network and try again, or download the installer from GitHub Releases.

### RTS-MAC-07

**A download didn't finish**

A file the page offered to download failed. Try again.

### RTS-MAC-08

**The new app could not be swapped in**

The update downloaded but could not replace the app (no password given, or no permission). The old app is kept. Try the update again, or install the newest installer by hand.
