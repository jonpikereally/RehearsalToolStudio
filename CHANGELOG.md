# Changelog

Every change to the studio, newest first, as it was described when it was made.
Written by `node scripts/changelog.mjs` from the commits themselves — so a change is
logged by describing it in its commit message, not by editing this file. No commit
ids: they change when a commit is amended, and the log would go stale in the writing.

## 2026-10-03

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

**Render a click that is an audio clip, rather than striking it**

The set's click was always written as a pattern of samples, which is right for a MIDI track striking a drum rack and wrong for a click that is an audio clip: a song-length file placed like any stem, trimmed and sometimes cut in two. Struck as a one-shot from the file's top, a clip that starts three seconds in landed three seconds early and a clip cut in two played twice over itself. A click with no rack notes is now rendered like a stem, as a [click].mp3 the player already treats as the click; one with any is a pattern still, and the cues always are.

**Choose the output folder in the Finder**

The launch window's output side offered only a list of the band's set folders where the input side opened the Finder. Now both do: Another folder… opens the folder dialog in the band's Sets folder, and what is picked says what it is — a set folder inside a band's Sets is that set, another band's moving the studio to it; the band's folder, or any other, becomes the band's, with its sets in the dropdown that has taken the list's place. A set folder made by hand gets its manifest, fed by the chosen session. The band folder is worked out from the pick and granted by path, so no second dialog is needed.

## 2026-09-09

**Write each song's locator name out as a clip**

The locator is where a song's facts live in these sets — its key, its tempo, its length — and typing them onto forty locators is the kind of job that gets done for six. A new set tool writes the name each locator should have, from what the set knows, as a one-bar MIDI clip at the song's start on a track of its own, in a copy of the set: the text sits beside the locator it is for, ready to be copied across in Live. Which facts, in which of the two shapes the parser reads — AbleSet's own or the slash-separated setlist form — and which songs are all choices, and each shape reads back exactly as it was written. Lengths are timed through the arrangement rather than read off the locators as they are; time signatures are left out, since their slash is the field separator.

**Build one installer for another Mac**

The packaged app was a zip to unzip and drag, with Lyrics Studio in a second one. make-installer.sh wraps both in a macOS installer package: double-click, the admin password, and both apps are in Applications, an older install replaced in place with the Mac's own folders and caches kept. The packaged window is compiled for both kinds of Mac when the tools can, as the Node beside it already is, and the installer tells Installer which Macs it runs on so the others are refused plainly. The README says what Gatekeeper does with an unsigned download on macOS 15, which is no longer right-click → Open.

**Keep the record in a prepare when its track is switched off**

A track that sounds nowhere in a song has been left out of a prepare since yesterday, which is right for the six alternate takes switched off in Mine — and threw out the record with them. REF SONG is switched off in nine songs, exactly as the preflight asks so the record never sounds at a gig, and the rule read that as silence. A reference with a clip to play inside the song is now a part however its track is switched; one with nothing to play, no clip here or every clip deactivated, still is not. The studio's own player goes on muting it as Live does. The contract says which tracks become parts.

## 2026-09-08

**Key a song prepared on its own, and say when changed audio is left alone**

A song prepared from its own dialog was written without its audio key — a whole set has always carried one — so from then on the folder could only say "prepared before this could be told", never whether a cut made in it since was a change. Mean, cut after being prepared that way, showed nothing but an update that said no audio had changed: the stems were switched off for saves, and the banner counted only what it wrote. The song dialog now keys the song like a set does, and a save that finds changed audio it is not allowed to render names the songs and says to prepare them by hand, in the banner and in the log.

**Offer a song the three jobs a set gets, and ask before each**

Preparing one song had a single button that rendered everything, and a second for the words alone; the submixes it would write were not named, and there was no way to write only them. Now it offers what a set does: Prepare stems, Prepare submixes and Prepare info, each pressed twice — the first press says what it will do to what, the second does it. The note above names the submixes the band's lists ask for, from the parts as chosen, and the submixes-only job writes them into the folder the song already has, its stems untouched.

**Count a song's bars up to where it ends, not a bar past it**

A song's endBar is where the next locator or the stop sits: the bar line it runs up to, not a bar it plays. Four places added one to the gap anyway, so every set.json said 66 bars and 186 seconds for a 65-bar Cruel Summer whose files, and click, ran 65 — and the info clip in Live said the same. One definition now, songBars, used by the manifest, the info clip, the render span and the set review. The render itself was already the right length.

**Read a freeze clip that begins off the bar line from the top of its file**

Live's freeze writes a file that starts exactly where the clip does, but counts the clip's beats from the bar line before it: Cruel Summer's record begins a quarter-beat before bar 3, so its freeze clips carry a first warp marker of "second 0 is beat 3.89" and a LoopStart of 3.89 to match. The parser read that LoopStart as beats into the file and skipped 2.75 seconds of it, so every stem and submix of the song — locked to each other to the sample — played most of a bar early against the click, the cues and the words. Mean, whose record begins 0.79 seconds before its bar line, had the same. The marker at the file's first second now says where the beats begin, for frozen and for warped clips alike; a file whose markers start at beat zero reads exactly as before.

**Tell the website how a submix is named**

A prompt of its own for the naming, since it has just changed: the parts in alphabetical order, lowercased and joined with +, never the member's name, a long list cut short with four letters of its own hash — and the one thing that matters more than any of it, that the name is not the identity. A submix is matched by `submixOf`, as a set, so a song prepared before the order was fixed carries its parts in the arrangement's order and plays exactly as it did; nothing on disk needs renaming and the site must not rename it.

**Notice a part that came out silent, and offer to take it away**

A track can sound in a song's bars and still be silent — a clip of an empty file, a fader all the way down, a take that was never recorded — and nothing in the arrangement says so. Only the audio does, and the audio is in hand at the moment the part is encoded, so each part's peak is measured there. Under -70 dBFS is quieter than anything recorded: an empty file, dither, or a fader at the bottom.

**Leave out a track that sounds nowhere, and name a submix in order**

Two things about what a prepare writes.

**Say how many stems and how many submixes a run wrote**

"Wrote 10 parts across 1 song" hides the half of the work that matters when the band changes: whether the submixes were written. The three kinds a run writes are now counted apart and named — "6 stems, 2 submixes and 2 patterns" — with only the kinds that happened said, in both the set's dialog and one song's. Checked against a song in the band's folder: 10 parts is 6 stems, 2 submixes and 2 patterns, which is what the entry holds.

**Ask before a prepare goes ahead**

The four buttons started the work on the press. A prepare writes over the band's folder — for the stems that is every stem the set points at, gigabytes read and an hour of rendering — and the difference between "prepare the info" and "prepare all" is one button's width.

**Print every track of a song, unless told otherwise**

Preparing one song came up with its reference tracks already set to Skip. Preparing a whole set has always printed them, so the same song came out with different parts depending on which button was pressed — and a song prepared on its own quietly lost the reference the band play against, which is the thing they check themselves by.

**Say when the stems were made, and when the submixes were**

A prepared song said when its audio was rendered and nothing more, so a band looking at a song could not tell how fresh it was in the two ways it can be. Preparing the stems and preparing the submixes are separate jobs — a member added has every stem beside their new submix exactly right — so a song can honestly hold stems from Tuesday and submixes from Friday, and one date could not say that.

**Cover the run-finished count with a test**

Six checks over the counting the sync bar now leans on: a run's end counted once, two overlapping runs counted once when the last of them finishes, something writing the folder outside a run saying so itself, and nobody told after they have stopped listening.

**Ask again the moment a run ends, rather than looking every two seconds**

The sync bar went on saying four songs were behind after they had been written. It watched `prepareRunning()` on a two-second timer and took true-then-false for a run having ended — and refreshing four songs' words takes a second or two, so the whole run began and ended between two looks. Nothing asked again, and the bar kept its stale count until the page was reloaded.

**Bring the folder up to date on opening, not only on a save**

Auto-update answered saves and nothing else, so a folder that fell behind for any other reason sat there until somebody clicked. It falls behind for other reasons often enough: a set edited while the studio was closed, a run stopped halfway, or the studio itself changing how it writes something — four songs went stale this afternoon because the chords it derives now spell a minor with a dash.

**Mark a track that sends patch changes +PATCH, and read it by that**

A set says what a track is in its name — AbleSet reads a text track by its +LYRICS — but a track that drives a rig was only ever guessed at, from words like MIDI, PC or Cortex in its name and from sitting outside any song's group. A guess is wrong both ways: a track called "Program" that plays a pad is read as a rig, and one called "Ben's board" is not read at all.

**Mark a minor the way its own notation marks it**

Converting to Nashville numbers wrote `6m`, and a chart of numbers is written `6-`. That came of a rule meant for names: minors were being tidied to `m` everywhere, so the one notation that spells them with a dash was having its own convention taken off it.

**Ask for a newer build from the menu, and be told what came of it**

The studio is built from the checkout beside it, so an update is a build: until now it happened when the app was clicked, and there was no way to ask for one with the app already open.

**Draw a converted chord as long as the chord it came from**

Writing a chart into another notation capped every clip at a bar, so a chord held for two bars came out as a one-bar clip and the copy no longer looked like the chart it was read from.

**Read the set as it is now, not as it was when the tab opened**

Two songs had a key added in Live and saved; Set tools went on saying they had chords but no key, and asked for the keys by hand. The set was right — parsing the file on disk gives both songs their key — but the tab had read it once, when the set was chosen, and never again. Every tool here is judged on that parse: which songs have chords, what key each is in, what the info clips say.

**Let a save do the jobs asked of it, not all three or none**

Auto-update was one switch: on, and a save of the set prepared the songs whose audio had changed, wrote nothing for the submixes, and refreshed the words and sections of the rest. But the three are not one job. The stems are an hour of rendering, the submixes minutes, the words and sections seconds, and which of those somebody wants happening behind them differs — wanting the words kept current should not mean agreeing to an hour of rendering on every save.

**Keep a page open when the browser's storage is full**

The studio died on a QuotaExceededError: nineteen songs with their words, chords, sections and patch changes came to four and a half megabytes, Safari allows five, and the write went off unguarded in the middle of drawing and took the page down with it.

**Offer the four jobs a prepare is really made of, and let the info be chosen**

One button did everything, which is fine when everything needs doing and wrong the rest of the time: a set whose sections have moved does not want twenty minutes of rendering, and a band that has changed does not want its stems written again. The window offers the four jobs instead — prepare all, the stems, the submixes, the info — each acting on the songs ticked, and the one the window was opened for leads.

**Offer the button that would help, not the one that wouldn't**

Two ways of being behind, and only one of them a reload fixes. A server still running the code it started with is caught up by opening the app again, since the servers come up with it — so that banner now carries a Quit and reopen button, which quits and opens it a second later, rather than a sentence telling somebody to do it themselves.

**Mark a minor one way: m on a name, lower case on a numeral**

A set marks its minors however whoever typed them marks them — Am, A-, Amin, "A minor" — and the dash went straight through the conversion: a classical track came out reading A- where a chart says Am, and a Roman one came out VI- where the numeral's own case is what says minor. Neither was read as minor at all, so a seventh on it came out attached to a major chord.

## 2026-09-07

**Let the chords go out in more than one kind at once**

A band reading Nashville numbers and somebody reading classical names want the same set, and the tool made you choose: pick a kind, write a copy, pick the other, write over it. The kinds are ticks now — any of the three — and each becomes a track of its own in the one copy, converted from whatever the set has, each song in its own key.

**Say in green when the submixes are written, and never lose the saying of it**

A submix run finished into silence: the dialog only knew how to show what a stems prepare had written, so a run that wrote nothing else left the form sitting there as though nothing had happened. It has its own word now, in the same green as a prepare's — how many submixes, into which folder, and that the stems were not touched.

**Let the submix job arrive with its songs already chosen**

Clicking "Submixes 7 behind" opened the dialog with nothing ticked and nothing to press. The songs were chosen and then unchosen a moment later: the dialog unticks every song whose audio is unchanged, which is every song a submix run is for — their stems are right, that is the point of the pass.

**Count the words and sections apart from the stems that carry them**

"Stems 1 behind" was the whole story a song could tell, so a set whose sections and chords had moved said nothing about them — and a song whose audio had also moved by a hair looked like nothing but a re-render.

**Give the band's file its own prompt for the site**

It was a section inside the submix prompt, which was right while the site only read it. The site is meant to write it now — a member setting what they keep without asking anybody to open a laptop — so the file that two apps write gets a page of its own: the shape, how names are matched, the merge both sides owe each other, and what a page for it could offer.

**Say in the bar how far behind each half is, and let them be prepared apart**

Preparing the stems and preparing the submixes are separate work — the stems follow the arrangement, the submixes follow the band — so they are two questions now, asked continuously and answered separately in a bar under the set: "Stems 1 behind · Submixes 7 behind", or up to date. A count that goes up flashes, because it changes while nobody is looking: the studio sits beside Live for hours.

**Ask the folder about submixes instead of hashing them into the audio key**

Putting the band's submixes into a song's audio key was wrong twice over. A key is a hash, so it could only ever say that something was different, never what — and it went stale on things that change no audio at all: renaming submixes for their contents rather than their member made every song in every folder look changed, when every file in them was already right.

**Write down that an inversion is a slash chord here, not figured bass**

`I6` is ambiguous between the two readings — the I chord with a sixth on it, and first inversion — and this reads it the first way, as every other notation in the app does. Said where the conversion is, so the next person to meet it knows it was chosen rather than missed.

**Share the band's file with the website rather than owning it**

members.json already sat where it belongs — the root of the band's folder, beside Sets/ and Resources/, the band's own file rather than any one set's. What it lacked was room for a second writer. A studio that wrote it whole on every save would have taken a member added on the website out again the next time somebody ticked a box on a laptop.

**Say the session before the folder it fills**

The bar named the folder first and the session it came from after, which is the work backwards and the other way round from how the chooser asks for them. It reads the way it runs now: this session fills that folder.

**Choose what the chooser is offering, and let it fit a small window**

It came up saying "opened last" on both sides and "not chosen" along the bottom, with Open greyed out — a window arguing with itself about the thing it exists to do. What each side opened last is now chosen as soon as it is known, and choosing something else is the click it always was.

**Let a member keep parts by a word, not one label at a time**

A set spells one instrument several ways — gtr, guitar, guitar pop, ref gtr — and ticking them off one at a time says what a guitarist wants in this set only: the next set, and the song added next week, arrive with the guitar summed into the thing they play along to. So a member can keep by word as well as by name, and one word covers every spelling, now and later.

**Write the site the prompt for submixes**

The other repo has to be told what is in the band's folder now, and in one piece rather than in pieces: what a submix is, where it sits, the three fields that declare it, the two shapes submixFor comes in, and the one thing the site must go on doing — dropping hidden parts — for a player that does nothing about submixes to stay correct. The two open questions go with it: the device-render cache that shares the name, and device rendering being the worse of the two ways to get the same file.

**Name a submix for what is in it, and write one file for everybody who wants it**

A submix is a sum of parts and nothing else, so naming it after the person it was worked out for said the wrong thing about it: two members who keep the same things want the same sum, and a file called "submix robin" is one nobody else can be told to use. It is named for its contents now — "Cruel Summer [submix drums+bass+other+piano].mp3" — and a list of parts is written once however many people it serves, with their names on the entry rather than on the file. A list too long for a name is cut short and marked with four letters of its own hash, so two lists can never come out alike.
