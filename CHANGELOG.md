# Changelog

Every change to the studio, newest first, as it was described when it was made.
Written by `node scripts/changelog.mjs` from the commits themselves — so a change is
logged by describing it in its commit message, not by editing this file. No commit
ids: they change when a commit is amended, and the log would go stale in the writing.

## 2026-11-10

**Follow AbleSet's setlist as it is saved, and drop the band tab**

The running order was AbleSet's, but only as of the last scan: reordering the show in AbleSet and saving the setlist changes nothing in the .als, so the set's watch never noticed, and the order stayed where it was until somebody pressed Refresh setlist. The watch now looks at the AbleSet folder beside the set too — AbleSet/Setlists, name, size and date of each setlist, a readdir every few seconds — and a change that holds still for a look reads the folder again, so the running order and which songs are in the show follow on their own. Unless auto-update is paused, the prepared set follows as well: its running order, and any song just put on the setlist by whatever jobs are switched on.

## 2026-10-17

**Choose a song's lyric file in the Finder, in the Lyrics tool**

A song's lyric file was found only by its title, in the lyrics folder. A file named for a working title, or one kept somewhere else, was never found, and a title that matched the wrong file left no way round it but renaming files.

**Read the setlist again on request, with Refresh setlist**

The running order is read once: at the scan, from AbleSet's saved setlists and its log, and again when a prepare dialog opens, from AbleSet itself or its log. When either caught it wrong — AbleSet had not yet written down a reorder, or a setlist was mid-save — the only way to check again was to close the dialog, press Rescan and open it again.

## 2026-10-08

**Keep lyric timing to where the song is sung, not across the breaks**

Whisper infers word times from attention, not from the waveform, and is at its worst across a stretch with no singing: the last word before an instrumental break was held through it, the first after was pulled back into it, words were invented in it ("Thank you."), and pasted lyrics with no heard word to take a time from were spread evenly over the whole gap. The clips made from those words started early, ran through the break, and merged sections that were really apart.

**Say what each update changed, in its release and from the app menu**

A release's notes said which build it was and pointed at CHANGELOG.md, whose newest entries are the newest commits — not necessarily this update's, and nothing at all about what had come in since the build installed. Now each release carries its own changelog: every commit since the release before it, subject and description as CHANGELOG.md tells them, written by the same script with --since. The installer job checks out the whole history to have them.

**Follow every warp marker of a file that changes tempo**

A warped clip was read as one straight line: the rate between its first marker and its farthest, set against the song's opening tempo. That is right for a stem exported at the song's tempo, which is nearly every stem, and wrong for a file whose tempo moves. Amsterdam's record is warped bar by bar onto a set that goes from 72 to 81; its markers average 76.6, so every part was rendered at 0.94 of its speed from bar 1 — six per cent slow from the top, about six seconds behind the click by the first chorus, and its last twenty seconds cut off the end. A stem made at one tempo in a song that changes tempo had the opposite fault: Live stretches it to follow the song, and the render played it straight on.

**Say "select" in the Lyrics tool, and offer Select all**

The Lyrics tool asked for songs to be ticked and had an "Untick all" that did nothing with none ticked. It now says select throughout — "Select the 4 without lyrics", "Select songs to hear lyrics for" — and the second button is "Select all" while nothing is selected, picking every song with a track to listen to, and "Deselect all" once anything is. The lyric codes' help in the error list says the same.

**Publish a song's tempo map whole, from bar 1**

A song's tempo map was its own tempo changes, and a set's automation usually has no point where a song starts — its tempo is whatever an earlier point left it at. So a song that steps from 136 to 140 at bar 91 was published as [{ bar: 91, bpm: 140 }]. The band's player takes the map's first point as the song's tempo, as the contract says it may ("the full map, first entry included"), and played the first ninety bars at 140: every marker, chord and click before the change in the wrong place.

## 2026-10-07

**Take a song's words from its lyric file in a lyrics folder**

The Lyrics tool heard every song's words, and what it heard was what went into the clips — misheard words and all, to be corrected by hand. Most songs' words already exist somewhere, typed out.

**Keep the Changes window from putting up the Open window**

The Changes window is the studio's page again in a small window of its own, and the page, finding no set open in it, did what it does on launch with nothing open: asked for the Open window. So looking at the log brought the chooser up in front of it every time. The question of what to open is now never asked from a small window — what is open is the studio's own window's business.

**Follow a song's whole map of tempo and time signature**

A song was counted in the meter it starts in from beginning to end: a bar of 2/4 partway through was noted as a caveat and otherwise ignored, so every bar after it — sections, chords, the click, loops, cues — was numbered and placed a beat or two out. And the render placed clips and measured the song at its opening tempo, so a song with a tempo change came out the wrong length.

**Count a song in its own time signature from its first bar**

A song in another meter than the set — a 6/8 song in a 4/4 set — was read in 6/8 only when Live's signature marker sat at or before its locator. A marker a beat or so after it, as happens when the locator is dropped just ahead of the bar line, left the song in 4/4 with a note that it changed partway in. A change inside the song's first bar now counts as the meter it starts in.

## 2026-10-06

**Count a reference as silent when everything it feeds is muted**

Check set called any reference track that was switched on and had clips playing a problem — "the record itself would sound at the gig" — looking only at the track. Sets often leave the reference tracks on and silence them further along: a REF folder that is muted, a bus track such as B-REF that they are routed into and that is muted, or an output of None. Those were flagged though nothing would be heard.

## 2026-10-05

**Pause auto update from the top bar**

Auto update is three switches on the Setlists page, and holding all of it off for a while — a session of edits that should not be rendered as they are saved — meant unticking them and remembering which were on. The set bar now has a "Pause auto update" toggle beside Changes…: while it is on, saves are still noticed and offered in the bar, but nothing runs on its own, and the jobs stay ticked for when it is resumed. Resuming answers a save that is waiting, the same as ticking a job does. It is kept with the settings, so a pause survives a restart.

**Hold "ref master" to the same reading as "ref song"**

A set may keep its record on a track called REF MASTER rather than REF SONG. Every place that reads a track's name already took the two alike — the role (a whole mix), the record flag a prepared part carries, the new-set category and model-track match, the member keeps that tidy a whole song away — but nothing said so. The self-test now reads both names through each of them and fails if they ever part.

**Publish each song's history for the band's site to show**

Every song Studio writes now carries a changelog — in set.json and its song.json, and in the band's .rehearsal-tool.json — in the form the website reads: when, a summary line, and optional detail lines, oldest first, the newest fifty kept.

**Say part by part what a run did to each song in the Changes window**

An entry said which songs were written again, and how many parts were copied rather than rendered — not which. A prepare now notes, for each song it writes, what became of every part: rendered and encoded, written as a pattern (the click and cues), copied unchanged from the last prepare, or skipped and why. The Changes window shows it song by song under the entry — outright for a run of a few songs, folded behind "Which parts, song by song" for a long one — so a cue edit reads as "rendered: Cues — copied unchanged (6): REF SONG, REF VOX, …".

**Key the parts of unchanged songs without rendering them**

Parts were given keys only when they were rendered, so a set prepared before parts had keys had none: the first edit to any song after the update — a cue moved — still rendered every part of it, there being no key to say the rest had not changed. A song whose own key still matches its entry is exactly what that entry's files are, so its parts can be keyed as they stand. That is now done whenever the set is looked at — on opening, on every save, and before a prepare — writing only the keys into the band's set.json and touching no audio. From then on an edit renders only the parts it changed, the first one included.

**Name the Slates track ADD THIS in the copy, even when the set had one**

Every track the studio adds to a copy of a set is named ADD THIS, so it is plainly the thing to drag into the real one. A set with a Slates track of its own was the exception: the slates went onto that track, to keep its routing, group and mix, and it kept its name — a "Slates" in the copy that read as the set's own. It is now named ADD THIS Slates there too; its routing, fader and everything else are unchanged.

**Let the set tools take in songs left off AbleSet's setlist**

The set tools worked on the songs AbleSet's setlist names, as the rest of the studio does — but they work on the project, and a song off tonight's setlist still wants its chords, lyrics and slates. "See songs not in current setlist", beside the songs being worked on, takes in every song in the project; it says how many the setlist leaves out and, on hover, which, and is remembered on this Mac. It appears only when the setlist leaves something out. The set is read whole and scoped as it is shown, so turning it on or off needs no reading again.

**Render only the parts of a song that changed**

A song is written again when anything about its audio changes — and it was written again whole: a cue moved on one track, and every stem of the song was decoded, rendered and encoded once more. Each part now has a key of its own, made of the same facts as the song's but only its own tracks', clips, faders and files, and it goes into the manifest beside the part. When a song is written again, a part whose key still matches is read back from the folder the last prepare wrote and copied into the new one; only the parts that changed are rendered.

**Name exactly which songs changed in the Changes window**

A Changes entry listed the songs a run had been asked about — every song chosen, every song with submixes behind — which was not what it did: "words and sections refreshed for 1 song" sat over a song whose words had not been touched. A prepare now says which songs it wrote, and each entry names its songs by what happened to them: audio written again, submixes written, words and sections refreshed, audio changed but left for a prepare by hand, parts that came out silent; for a stopped run, the songs written over and added before it stopped; for an undo, those put back and those removed; for a running order change, the order now. An older entry still shows its single list.

## 2026-10-04

**Give every error a code, with a public list to look it up in**

Each error the studio shows now carries a code — RTS-<area>-<nn> — beside its message: in the page, in the Mac app's dialogs and error pages, and in the Lyrics engine's answers. Hovering an error says to check the error list; the code itself links to its entry there. The list, docs/errors.md, is public on GitHub so anyone can hand it to an LLM with the code and the message, and says what each failure usually means and what to do.

**Write down that every error a user sees carries a code**

A CLAUDE.md for the repo: errors shown to a user carry a short, stable code beside the message, so troubleshooting with an LLM can start from the code. Alongside it, the conventions the repo already follows: prose commits with the changelog regenerated from them, the checks to run, and how changes reach main and the installer.

**Say why lyrics audio is unreadable, and restart an engine a past build left**

"No lyrics found on that track (0 regions transcribed, 1 unreadable)" was all the Lyrics tool could say, for every song. Unreadable hid two different things: a file the engine could not find or open, and ffmpeg failing to cut it, whose own words were thrown away. Each is now said: the file not found, by its path; ffmpeg's last line; or, when macOS refuses the engine the file, "Operation not permitted" and where — which the studio already answers by starting the engine again under itself and asking once more.

**Keep macOS's folder permissions across updates**

Every update asked again for access to the folders the studio reads. macOS keeps that permission against an app's designated requirement, and an ad hoc signature's requirement is the hash of that very build, so each update looked like a new app. The packaged app is now signed with a requirement naming its bundle id alone, which is the same from build to build: permission given once stays given. The build says when that signing fails rather than passing over it.

**Offer every track with audio in the song to listen to for lyrics**

The Lyrics tool's track picker offered the song's own group: the tracks filed under the song. A track with audio inside the song but filed elsewhere — a cue track, a pitch reference, a break — was not there to choose. The parser now lists, per song, every audio track with a clip inside its bars, wherever it sits in the set, and the picker offers all of them: the song's own first, then the rest, a group named where two tracks share a name. Ref Vox is still the one chosen to start with.

**Keep update news out of the studio's window**

Checking for updates put banners across the top of the window: "Looking for a newer build…", "This is the newest build", "A newer build is ready", "the studio's own server is still…". Everything about updates now belongs to the app: the menu item says when one is available, and Check for Updates answers in a dialog of its own — up to date, a newer build with Reload / Later, or that a set is being written and updating must wait. The page's only part is answering whether it is safe to update now.

**Rebuild Set tools ▸ Lyrics around the set's songs**

The Lyrics tool was two tools stacked: a one-song form and Lyrics Studio's own page in a frame. It is now one screen doing three things.

## 2026-10-03

**Take AbleSet's skipped songs from its log when its answer leaves them out**

With AbleSet running, the studio asks it for the setlist on screen, and took the order from that answer. The order came through, but the songs skipped in it did not: the answer does not mark them, while AbleSet's log does, as `skipped`, every time the setlist changes. When the answer marks none, the skips now come from the log's newest order of the same setlist, matched by position and then by name.

**Update the installed app in place, without Installer**

Every update went through the whole installer: download, Installer, click through, password, open the app again. A release now carries the app itself, zipped beside the .pkg, and the installed app updates from that: it downloads and unpacks the new app, checks it is the build GitHub named, and offers Restart Now. A small script waits for the app to quit, swaps the new one in where it was — putting the old one back if anything fails — and opens it again.

**Treat songs switched off in AbleSet as off the setlist**

A song left off AbleSet's setlist was only noticed when the setlist left it out altogether. AbleSet can also keep a song in the list and switch it off — disabled, skipped — and that song was counted as in the show. A cue flagged so, on itself, its cue or its meta, in a saved setlist, in AbleSet's own answer or in its log, now keeps its place in the order but is marked off the setlist like a song it never named.

**Move Lyrics Studio into Set tools and give it its own ffmpeg**

The Lyrics tab is gone. Set tools ▸ Lyrics now does all of it: straight to lyric clips on the set, as before, or Lyrics Studio's own page — review, edit, align to pasted words, export — shown in the tool and opened on the set that is open. The Set tools are held once opened, the way the player is, so a queue Lyrics Studio is working through survives a look at another tab. Old links to /lyrics land on the tool.

**Mark songs left off AbleSet's setlist in the song list**

A song AbleSet's setlist leaves out used to vanish from the studio altogether. It is now listed with the rest of its set, greyed and struck through with a "not in setlist" badge, and can still be opened and played. It stays out of the show: the set's running order skips it, and nothing prepares, refreshes or auto-updates it. Preparing it on its own says why rather than claiming the song is gone from the set.

**Update the installed app from GitHub's newest installer**

The app from the installer has no checkout, so it never looked for an update: a new build meant noticing one on GitHub and downloading it by hand. Now it looks itself, on launch, on coming back to it and every half hour, at which installer GitHub's Releases page has as latest — by the build in its tag, held against the build inside this app — and Check for Updates reads "Update Available — Install…" when there is a newer one. Installing downloads the .pkg into Downloads, says what will happen, and on agreement opens it in Installer and quits, so Installer can put the new app in its place. The development app still updates from its checkout.

**Warn before preparing when the click or cue samples can't be read**

A click is written as its samples and where they fall, and its samples usually live in a shared Resources folder outside the set's. When the studio had not been allowed that folder, a prepare could read none of them, left the click out of every song, and said so only in its list of what it skipped — the first anyone knew was a band site with no click. Now the Prepare window tries each click and cue sample as soon as the set is read, the way a prepare would, and says up front which part will be left out or which cues will be silent, in which songs, and which files it cannot read — with a button to allow their folder there and then. It asks again whenever a folder is allowed.

**Tell the band's site which songs are on the setlist, without deleting any**

A song left off AbleSet's setlist kept its entry in the band's set.json just as before, so the band's site went on listing it as part of the set. Its folder should stay — the files are still good, and it may come back — but the set's order is AbleSet's. Now each set.json entry not on the running order is marked offSetlist and kept after the rest; a song put back loses the mark and takes its place again. The library's set: setlist leaves marked songs out, and a change to the setlist alone — a song taken off, put back or moved — rewrites set.json on the next prepare or save, whichever auto-update jobs are on, with no audio written. The contract and a prompt for the website say what the mark means.

## 2026-10-02

**Leave out of the studio any song AbleSet's setlist leaves out**

A set's songs were all the studio's, whatever AbleSet's setlist said: a song not on it still came into the library, followed the setlist's songs in the running order, and was prepared and auto-updated with the rest. A song left off the setlist is not in the show, so now it is left out of the studio. When a scan finds AbleSet's setlist for a set — saved beside it, or open in AbleSet — only the songs it names come into the library, and the scan's note says which were left out. Preparing, the prepared set's standing, auto-update and the set tools all read the set as those songs alone, so nothing is rendered, refreshed or updated for the others; the Prepare window names them. A set with no AbleSet setlist is read whole as before, and so is one whose setlist matches none of its songs.

**Find the vocal to transcribe by LV and BV too, and prefer Ref Vox**

Set tools → Lyrics guesses which of a song's tracks to listen to from its name, and knew a vocal only as vox, vocal, voice, lead or sing. A set that calls its lead vocal REF LV matched none of them, so the guess fell to the song's first track — usually the whole record. Now LV is a lead vocal and BV (with backing and harmony) a backing one; a track called Ref Vox is taken first, then a lead vocal, and a backing vocal only when there is no lead. The Lyrics tab's preferred source track starts as Ref Vox, so a set with one per song opens on all of them read together.

**Move Check for Updates into the Rehearsal Tool Studio menu**

It sat at the bottom of the File menu, among the things the studio opens, where nobody looks for it. A Mac app keeps it in the menu named after the app, so that is where it goes now, at the top, above Hide and Quit — still ⌘U, and still retitled "Update Available — Install…" when GitHub is ahead.

**Say when no AbleSet order was found for a set being prepared**

A set whose running order AbleSet could not supply — not open in AbleSet, open from another folder, no setlist saved beside it — was prepared in the arrangement's order with nothing said, and the first anyone knew was the band's app showing the songs out of order. Now the Prepare window says so, once AbleSet has been asked: that no order of AbleSet's was found, that the arrangement's is being used, and what would let AbleSet's be used instead. An order that did come from AbleSet is named as before.

**Write submixes only when Prepare submixes is asked for**

Preparing a set's stems wrote every member's submix beside them as well, and Prepare all added the submixes of any song that lacked one — so a fresh set, prepared without anyone pressing Prepare submixes, came out with a submixes/ folder in every song: one more render per member per song that nobody chose. The same went for a single song's Prepare stems. Now Prepare all and Prepare stems write the stems and the words and no submixes, and the buttons and the confirmation say so. Submixes are written by Prepare submixes, and by auto-update only when its submixes switch is on, as it already was for songs whose stems were unchanged.

**Build the installer on GitHub and put it on the Releases page**

The installer could only be made on a Mac with the repo, Node, uv and the command line tools, and it landed in a folder kept out of git — so there was nothing to download from GitHub. Now a workflow runs the same make-installer.sh on GitHub's Macs whenever a change to main touches the app, or by hand from the Actions tab, and publishes the .pkg as a release named by its build and when it was built. The newest is always at releases/latest/download/Rehearsal-Tool-Studio.pkg. A pull request that touches the packaging builds it too, as a check, and publishes nothing.

**Make Lyrics Studio a tab of the studio, not an app of its own**

Lyrics Studio was a second app beside the studio: its own Dock icon, its own launcher, a page opened in the browser, and a second package in the installer. Now it is the studio's Lyrics tab. Its page opens inside the studio's window, held once opened so a queue of songs keeps transcribing while another tab is looked at, and the Set tools' "Open Lyrics Studio instead" hands the set straight to that tab rather than to a browser.

## 2026-09-25

**Open with what to do, then where it goes**

The launch used to ask its two questions side by side — which session, filling which folder — with the tools as a link along the bottom, and a new session from stems buried in Set Tools behind an open set. Now it asks in order. First what this is: open an Ableton session, lay a new one out from a folder of stems like a session already there, or just use the tools that need no set. Then the output folder in the band's Dropbox — one already there, one picked in the Finder, or a new one named on the spot; optional for the tools alone.

## 2026-09-24

**Choose the studio's colour scheme in Settings**

The studio was drawn in one scheme, dark with amber, which is right at night in the room with the rig and wrong at a desk by a window, where a dark screen reads as a mirror. A new Appearance panel in Settings offers Dark, as before; Black, the same with its greys taken down to black for a dark room; Light; and Match the Mac, which follows the Mac between light and dark as it changes. Beside it an accent — amber, blue, teal, pink or violet — for everything that says on, playing or chosen, each in a brighter form on the dark schemes and a deeper one on light so it reads on either. The choice is per machine, like the folded panels, and is applied before the first paint so a light page never opens as a flash of dark. For that the colours written into rules here and there — badges, notices, the loop region, the muted-fader hints — are now tokens every scheme sets. The confidence monitor is left stage black whatever is chosen.

## 2026-09-16

**Name a build by when it was built as well as its commit**

A commit hash answers "which build" only to somebody with the log open; with the date and time beside it — 914c26d (16 Sep 2026, 02:19) — it answers "is that this morning's?" on its own. One helper names a build that way, in the machine's local time, and everything that showed a bare hash uses it: the update banners in the page, the line in Settings, and the app's own dialog and log. The server's answer carries when the build on disk was made and when the build it started as was, so a page can name a newer build before it has loaded it. A build with no time on record is still named by its commit alone.

## 2026-09-15

**Say in the File menu when GitHub has an update**

Check for Updates pulls from GitHub and rebuilds, but nothing said whether there was anything to pull. The app now looks for itself — on launch, on coming back to it no more than every ten minutes, every half hour, and again after an update — with a fetch in the background and a count of the commits the tracked branch has that this checkout hasn't. When there are any, the menu item reads "Update Available — Install…" and the same command installs them; while it runs it reads "Updating…". The launch log notes when GitHub pulls ahead or is caught up. The packaged app has no checkout and never looks.

**Bring the checkout up to date with GitHub before building**

The studio is built from the checkout beside it, and until now an update was whatever had reached that folder by other means. With the code on GitHub, every launch and File ▸ Check for Updates first fetch from it and fast-forward onto the branch tracked, then rebuild if anything moved — so a commit made anywhere arrives on the next check. Work in progress is never pulled over: uncommitted changes, or commits here that GitHub hasn't, leave the checkout alone and the log says which. A fetch that does not answer in fifteen seconds is given up on and the app opens on what it has. The packaged app has no checkout and is unchanged.

**Lay out new songs from a folder of stems the way the set's own are**

A song arrives as a folder of bounces, named every which way by whoever made them, and getting it into a set was an hour of the same clicks: a group, a REF folder, a track per stem routed and sent like the others, the click onto the click track, a locator and an AUTOSTOP. A new set tool does them. Nothing in it knows a format — each set has its own — so a song already in the set is the model: each file is matched to one of its tracks by what it is, and that track, with its folder, routing, sends, devices and switch, is copied with the file in its clip. The page shows what was read from the names and lets any of it be changed first; the tempo is measured from the click's audio, since the number in a click's name is often double or wrong. It writes a copy beside the set, with the songs added after everything in it or in a new set of only them, and checks the copy reads back before writing anything.

## 2026-09-12

**Print a song as one of the set's returns hears it**

In a set built for the stage the returns are the outputs — every track sent to its bus, the buses on to the interface or into each other — so what reaches a bus is a mix in its own right, with its balance in the sends. A new set tool prints it: each stem at its send level, after the sender's fader unless the bus takes its sends pre, each bus sent into it at its own output, the sum through the bus's devices and then its fader and pan, as an MP3 under Prints/ in the band's folder where the scan attaches it to the song. The page says what the bus carries before anything is rendered. For that the parser records which fader a send follows, reads Live's pre/post switch per return, and gives the set's click and cues the sends of their groups.
