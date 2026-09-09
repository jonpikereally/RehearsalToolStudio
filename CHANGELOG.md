# Changelog

Every change to the studio, newest first, as it was described when it was made.
Written by `node scripts/changelog.mjs` from the commits themselves — so a change is
logged by describing it in its commit message, not by editing this file. No commit
ids: they change when a commit is amended, and the log would go stale in the writing.

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

**Read a submixes folder as its song's, and tell the band whose submix it is**

Filing submixes in a folder of their own broke two things at once, and both only showed in the band's own library. The scan read each submixes/ folder as a song, so a set of nineteen songs published as thirty-eight, half of them called "submixes". And the library's variants never carried what makes a submix one — hidden, submixFor, submixOf are in the manifest, and the publish dropped them — so the band's app would have played a member's submix as an ordinary fader, on top of the very parts inside it.

**Put a song's submixes in a folder of their own**

A song folder of eight stems and four submixes is a folder nobody can read at a glance: the parts the band play are lost among the things the studio summed for them. So each song's submixes go under submixes/ inside it, and their manifest entries carry the path from the song folder — `submixes/Cruel Summer [submix alex].mp3` — where every other part's file is a bare name.

**Keep whole songs out of submixes, and out of the choosing**

The record was already left out of every submix, but it was still offered as a part to keep — a choice that changed nothing, which is worse than no choice at all. It is gone from the chips now, along with the click and the cues, and so is a full mix: a whole song summed into a submix puts everything in it twice, whether it is the record the band play against or their own bounce.

**Give the band a tab of its own**

Who the set is prepared for is not a setting: it decides how every song is written, and it is work of the same kind as the songs and the tools. So it comes out of Settings and becomes a tab — the band, their submixes, and what each of them keeps on a fader of their own, with the head saying who they are and how many submixes a song carries.

**Only offer a reload when reloading would change something**

The banner compared this page with the build the server process started with, so a page already showing the newest bundle was told a newer one was ready — and the Reload button loaded the same bundle again and the banner came straight back. Nothing to see, nothing to do, no way to tell why.

**Never sum the click or the cues into anybody's submix**

They are the set's own timekeeping, not something to play along to, and one summed into a member's submix is a click they can never turn down. It held already for the usual case — a click is a pattern striking samples, which cannot be summed — but a set that renders its click as audio would have had it folded in for anyone who hadn't thought to keep it out.

**Hold the band until it is saved, then say which songs are behind**

Ticking a part wrote the file there and then, which is the wrong moment: what is written for the band only becomes true when the songs are prepared again, and that is hours of rendering. So the panel holds the changes, says nothing is written yet, and saves when it is told to — with a way to put it back.

**Write each member the one part they need beside the ones they play**

A phone holding eight parts per song holds and decodes eight files, when the person carrying it plays one of them and wants the rest as a single thing to play along to. So the studio writes that single thing: one submix per member per song — everything they are not keeping on a fader of their own, summed here from the multitrack at the same 192 kbps the stems are written at, rather than on every phone from stems already compressed once.

**Do it in the page when the app is too old to have the window**

The Changes button asked the app for a window and the app, built before that window existed, dropped the message without a word — so the button did nothing at all. The app is rebuilt by hand, so it can always be older than the page the server is showing it; the page can't assume it understands.

**Point the set tools with their head, and drop the lone .als**

"Open a single .als…" opened a set from anywhere with none of its audio to hand, from when the studio was pointed at a folder of sets and a file off another machine had nowhere to belong. The Open window does that now — any session, any folder — so the button and the mode behind it go, and with them every branch that asked whether the set had a folder.

**Find AbleSet where it actually answers, and read the names it gives**

AbleSet serves on port 80, not the 3000 that was guessed at, and its answer carries each song's locator name under the cue rather than as a lastKnownName. Both now read, and checked against the running app: the order it hands back is the one on AbleSet's screen, a reorder included, and the scan says so — "as AbleSet has it open right now".

**Ask AbleSet for the order it has, and allow samples in more than one folder**

The running order was read out of AbleSet's log, which turns out to hold it only sometimes: today's log has one setCueMeta line, written when AbleSet loaded the setlist, and none for the reorder made afterwards — so a setlist changed on screen and then saved was invisible. AbleSet's own server is asked first now, while it is running, and what it says is the order on its screen whatever any saved setlist says. The log stays as the fallback, and is read across the last few launches rather than stopping at the newest one that happens to have a line. The scan says which it used.

**Keep a log of what each save came to, in a window of its own**

The bar along the top says what is happening to the band's folder and is then dismissed, which left no answer to the question you actually ask after a rehearsal: what did it do while I was playing? So every save Live makes, and every answer the studio gives one — written again, nothing to do, left alone, stopped, undone — is written down with its time, and shown in a small window of its own: File ▸ Changes, or the button in the set bar, which is where Open used to sit. Opening belongs in the File menu now: ⌘N makes a new set folder, ⌘O opens one, both through the same window.

**Say what is open in one panel, instead of asking the same things twice**

Settings still carried the old way in: a folder to point at, a switch to read from it, a menu of the .als files beside it, a Forget button — and then, below, the set folder and the session again, each with its own way to change them. None of that is a choice any more. The session decides its own folder, opening one is what turns reading on, and both halves are chosen in the Open window.

**Hand the chooser's whole choice over, and say so while it opens**

The chooser window closed on Open and the studio behind it sat where it was: the window sent the folder flattened into the message, and the studio was looking for the folder itself, so it dropped every choice on the floor. The set folder now travels whole, and the window that receives it says which session it is reading — and says what went wrong if it can't, rather than showing the same waiting screen for ever.

**Read a key change written as a move, and say it on the song's info clip**

A set that marks its modulation "KEY CHANGE +2" was saying nothing about it: key marks were only read when they named a key outright, and the info clip only ever carried the key the song opens in. A move is now read as a move — +2, up 2, -1, down 3 semitones — and worked out against the key in force where it sits, so Love Story reads "Key: C → D from bar 101". The chord tools count in the new key from that bar for the same reason.

**Give the chooser a window of its own, and name both halves in it**

Choosing what to open is not the studio's work, so it is no longer the studio's window: the Mac app puts a small window in front — 760 by 540, where the studio's is 1280 by 860 — running the same page told by its query which window it is. What it chooses is handed to the window behind, which is the one that holds the set, so closing it without choosing changes nothing and File ▸ Open no longer puts down what is open.

**Ask for both halves at once: what fills the folder, and where it goes**

A launch used to ask two questions on two screens — the set folder, then the session — when it is really one question: which folder, filled from which session. Both are now chosen in one window, side by side, and opened together; each side offers what it opened last and can be told to take it without asking, so a studio that always works on the same pair comes up in the tabs. File ▸ Open (⌘N) puts the window back, and always asks.

## 2026-09-06

**Begin with the set folder the band plays from, and the session that feeds it**

The studio used to be about a folder of Ableton projects: point it at one, scan every set in it, pick one, and only when preparing find or name a folder in the band's Dropbox — a link it kept repairing from a remembered name, the manifest's origin, then the songs' keys. Now the band's set folder comes first. A launch asks for the band's folder once, then which folder under Sets/ to work on — each saying what it holds and what feeds it, with a way to make a new one, name and session together — and then the Ableton session, which the folder's manifest remembers, so that step is silent from the second launch on. The session's own folder is where stems are read, and that one file is the set; there is no songs folder to point at any more, and no newest-file rule.

**Transcribe a song's track into lyric clips from the Lyrics tab, with Lyrics Studio driven from here**

Getting words into a set meant leaving the studio for Lyrics Studio's own page and its own workflow. Now the Lyrics tab asks which song and which of its tracks — the record's vocal by default — how finely to cut the words, whether to isolate the voice first, and any known lyrics to steer by, and one button does the rest: Lyrics Studio listens to that track inside that song, reading the set itself so its warping and tempo map are honoured, and the words come back with beats through the map and become clips on an ADD THIS LYRICS +LYRICS track in a copy of the set that holds only that track. Lyrics Studio is started here when it is not running.

**Say after a stop whether anything was written, and whether undo applies**

A prepare stopped during its first song's rendering had touched nothing — a folder is moved aside only just before its first file is written — yet the message implied files had been written and said nothing about undo, so the absent Undo button read as a fault. The dialog and the auto-update bar now say either that the stop came before any song was written and the folder is as it was, or how many songs had been written over and that undo puts them back.

**Read each chord for what it is when converting, so a mixed track comes out as one kind**

A chord track was judged by its majority: a song written mostly in numbers with a few names left in it counted as already in numbers, and the stragglers were never converted. Each chord is now read for its own kind — a chord already in the chosen kind stays, the rest are converted, and a song counts as done only when every chord of one of its tracks is that kind throughout. The choice of kinds says how many chosen songs mix kinds on one track.

**Count each chord in the key at its bar, from the key changes the clips mark**

A song that modulates had every chord counted in the key its locator named, so everything after the change came out wrong. Key changes are marked on the timeline as clips — the song info clips the studio writes carry one at the top, and a later one marks the modulation — and the parser now reads them off any MIDI track's clip names, `Key: A`, `KEY CHANGE Bb`, `key = F#m`, into the song in its own bars. The word has to be there and stand on its own, so a chord clip and a lyric say nothing. A mark at the top names the song's key when the locator did not.

**Notice a save made while closed, compare the words too, and write chords in any of three kinds**

A save made while the studio was closed went unnoticed: the watch only knew saves it was awake for. It now remembers the last save it saw of each set and, on launch, announces a newer one like any other. And "nothing has changed" only ever meant the audio; a lyric, a section, a note or the key never counted. The set is now compared against the prepared copy on those as well, everywhere the standing is shown — and the update refreshes only the songs whose words moved, naming them, rather than every unchanged song. A change of running order still rewrites them all, since every entry's place has moved.

**Say whether Live is open, keep only the added tracks in a copy, and join info lines with a slash**

The set bar now says what the watch on the set is doing: a breathing green dot while Live is running and the set is looked at for a save, a grey one when Live is not open, amber while a scan or a prepare has the watch paused. The server reports whether Live is running; the page says so only when that changes.

**Give the band each set's running order, and choose the open set from Settings**

A newly prepared set showed on the website in alphabetical order. The manifest listed its songs as AbleSet plays them, but the band's library file carried no setlists at all, and a library of songs alone loses the order they are played in. Every publish now writes one setlist per prepared set into the band's library, in the manifest's order and named for the set's folder; a setlist made by hand on the website is left as it was. The contract says so, and the website prompt gains the point.

**Offer to update a set that has been prepared, rather than to prepare it again**

The Setlists page offered to prepare the whole set whether or not the band's folder already held it. Now it looks the set up the way the auto-update does — the set read, a stat per file, the folder recognised by its songs — and when a folder is found it offers an update instead, saying when the set was prepared, into which folder, and how many songs have changed or are new since. The dialog is titled to match, and a run with nothing ticked can still refresh the words and sections of the unchanged songs, which used to be a button that said "nothing chosen".

**Name a song's folder for the day it was rendered, and give it a file of its own**

A song folder used to be named for its tempo, key and meter, which was how a folder of files told a reader what it held. Now it is the title and the day the song's audio was last rendered — `Cruel Summer (2026-09-06)` — so the folder says how fresh its files are, and a song rendered again on a later day moves to a new folder while its old one is kept aside for undo. The facts the old name carried travel as fields instead: tempo, meter, length in bars and seconds, and when it was rendered.

**Let a wrong memory of a set's folder give way, and never render a whole set unasked**

The first auto-update after a rename remembered the folder it had settled on, and a remembered name was trusted outright — so the by-content check that would have found the right folder never ran, and every save after that wrote the whole set again. Now a remembered folder that holds none of this set's songs, while another folder holds some, gives way to that other, and the memory is corrected.

**Know a set's folder by the songs in it, and let a prepare be undone**

A prepared folder renamed in Dropbox to match a renamed set turned out to have come from a different set altogether, and every song in it was written again for nothing. The name was all the studio had to go on once the manifest's origin no longer matched. Now, before falling back to the name, it scores each prepared folder by how many of its songs carry the set's audio keys as they stand, and takes the best: a renamed set is the same songs and the same files, and a folder that merely shares the name is not.

**Find a renamed set's prepared folder, and let it be located by hand**

A set renamed on disk got a fresh default folder name — the new file name and today — and the auto-update looked for a prepared set there, found none, and asked for a first prepare that would have written a folder with no audio in it. When nothing is remembered for a set, the auto-update and the prepare dialog now look in the band's folder for the set it already produced, the way the update tool does: by what the manifest says it came from, or by the folder's name. Found once, the name is remembered.

**Tidy the four tabs, take a folder dropped on the app, and follow Live's saves**

The GUI first. Set tools was an intro paragraph, a "The set" field and a song-count notice that all repeated what the set bar already said, then a tall song picker, and only then the tools. It now has a header bar like the other tabs, the picker folds into one line that opens when songs are being chosen, and the tool's controls sit in a card under the tab strip. Songs loses the long scan banner for a short one with the AbleSet note on its own quiet line, and its filter and order share a row.

## 2026-09-05

**Write patch changes into a set as MIDI clips, one track per band member**

A band member drives their own rig from their own laptop, over USB MIDI, from the website; the set's changes reach them through the manifest, and they set changes of their own there, which the website writes into the band's folder as one file per member under the prepared set's rigs/ folder. The Studio now reads those files and writes the changes into a copy of the set as MIDI clips — the way the set drives a rig itself, and the only way anyone here reads — one "ADD THIS RIG <member> (<rig>)" track per member, plus one for what was programmed in the player. Each track is modelled on a rig track the set has, the member's own where there is one, so the routing and Live's controller numbering are the set's: program and bank in the clip box as bytes, each CC an envelope pointed at the new track's own target for it, each clip running to the next change or a bar. Changes the set already sends from its clips are left out. The locator writer is no longer used.

**Say what went wrong instead of going black, name added tracks ADD THIS, and end chord clips at the next chord**

The studio's window went black twice tonight and said nothing. Its page is dark by design, so a crash — React unmounting the tree when a render throws — looked like a window with nothing in it, and a WebKit content process killed for memory looked the same. Now a render that throws is replaced by the error and its stack, written to the launch log as well through a new file-server op, beside the launcher's own lines; every uncaught error and rejection goes to the log too. And the Mac app reloads the page when WebKit ends its content process, logging that it did, or says so instead of looping when it happens twice in a minute.

**Read Roman numerals as chords, bracket what is written back, and put new tracks first**

Converting a set's Nashville chart to names gave the chart back unchanged: the converter knew degrees only as digits, and a lane of I V ii IV was not a degree it could read, so every chord fell through to its own text. Numerals are degrees now, their case the chord's quality — ii in E is F#m, vii° stays diminished, bVII is D, IV/5 is A/B. And every chord written back onto a lyrics track goes in brackets, since that is the one way AbleSet reads a clip as a chord and the parser had taken them off on the way in.

**Read the patch changes a set sends from its MIDI clips**

A set drives its rig from MIDI clips, not locators: a clip on the Quad Cortex track carries a program change and bank in its own box and the scene as a CC envelope, and when the clip starts Live sends the program and every envelope's value, then each later step of an envelope as it comes, all on the channel the track is routed to. The studio only knew patch changes as its own *rig locators, so a set like that had none.

**Write each song's facts as an AbleSet clip, and give the set tools' picker a search and an order**

AbleSet shows the current clip of any +LYRICS track as a line, and reads a backslash in a clip's name as a line break — so one clip at the top of a song can carry the song's facts for whoever is looking: the key it is played in, the tempo, the length through its tempo map, the sections, the notes from the set. A new set tool writes one such clip per chosen song onto a track of its own, in a copy of the set named "(info)", with the facts ticked as the reader wants them and the clip running the song or its first bar. Which is why a chord-track clip may now be longer than a bar, and why the file server lets an "(info)" copy be written again.

**Play in AbleSet's order, keep Resources out of the band's library, and say when a set is prepared**

AbleSet is what runs the show from a set, and its setlist, not the arrangement, is the order the songs are played in. It keeps that beside the set under AbleSet/Setlists/, a JSON list of the song locators in order by position and last name; and until a setlist is saved, the order on screen lives only inside AbleSet — though every change goes to its server as a request that its log keeps in full. The Studio now reads both. The scan gives a set's own setlist the newest saved order, matching songs by locator position first and by name when a locator has moved, with anything the setlist leaves out following in arrangement order; and when AbleSet's log holds a newer order for the same project, that one, said as unsaved and dated. The prepare dialogs ask the log afresh when they open, so a reorder made after the last scan still lands, and the manifest lists songs in that order for the band's app to play. A setlist made by hand in the Studio keeps its own order when prepared from.

**Keep the page working when its window is covered, never write over a set, and open the tools without one**

A prepare still stalled for minutes at a time, and the pattern was not the Mac sleeping: a part every eight seconds whenever the window was in front, nothing whenever it was behind Finder or another app. WebKit runs the page in a WebContent process of its own and naps that process when the window is covered, whatever the app itself asserts. Two answers. The app turns off WebKit's two switches for it — pageVisibilityBasedProcessSuppression and hiddenPageDOMTimerThrottling — reached the way developerExtras already is, and only where this WebKit answers to them. And the page plays a tone nobody can hear for as long as a prepare runs, since a page playing audio is the one page no browser throttles when it cannot be seen.

**Hold the Mac awake through a prepare, and write only the songs that changed**

A prepare left alone took hours. The set's folder told the story in file times: a part every seven seconds while somebody watched, then three minutes to the next, twenty to the one after, then nothing for two hours until the Mac was woken. Minutes of work that touches nothing is idleness to macOS — the display sleeps, the app is napped, the machine sleeps. So a prepare now holds the machine awake: a screen wake lock from the page, re-taken whenever the page comes back, and a word to the Mac app, which asserts user-initiated, no-idle-sleep activity for the run. Both let go when it ends, stops or fails. The app side needs the app rebuilt.

**Let the app's own rebuild find node, and keep a timed dry run of a prepare**

Every build the launcher ran from the Dock failed with "env: node: No such file or directory", and the log said so, while the same command worked from a terminal. An app starts with a bare PATH; the launcher finds node and npm the long way, but npm's scripts look node up by name and found nothing. So the app has been serving whatever was last built by hand. Node's own folder now leads the PATH for the build.

**Play Live's own render of a frozen track, and shift the rest with Signalsmith**

Two ways to a better-sounding, faster prepare of a set in other keys.

**Shift a song's clips several at a time, and tag the record itself in a set**

Two things a prepare got wrong about sets that carry the record.

**Find Lyrics Studio by what answers, not by the port it was meant to have**

Lyrics Studio could not be opened on its own, and the reason was nothing in Lyrics Studio. Another app on this Mac — a light controller — had taken to listening on 8765, its home port, and answering every URL with the lamp's state. Each launcher only asked whether 8765 was busy, decided the server was already up, and opened a browser on a stranger's JSON. The server itself never started, and the studio's "is it running?" check, fooled the same way, left no way in.

**Put a list of songs in the order that answers the question being asked**

A list of songs is looked at for different reasons, and one order serves none of them well. Finding a song wants names. Working out which songs sit well together wants keys side by side. Shaping a set wants tempos. And playing it wants the running order, which is the one nobody chose the list to show by default until now.

## 2026-09-04

**Never sweep a build out from under an open page**

A page already open keeps running the bundle it loaded, and fetches more of it as it goes: the encoder spawns a worker per part from a file under assets/. A rebuild used to empty dist/ first, and one that renamed that file would have failed every part of a prepare after it — the launcher does exactly this when the app is clicked with a window already open, and so did a commit's rebuild today, mid-run.

**Show how far a prepare has got, and tidy the dialog it runs from**

A bar for the whole run. The loop now says which part of how many it is on as well as which song of how many, and the figure weights songs equally and parts equally within them, with the encode — nearly all of a part's time — carrying most of a part. It starts at nothing, the second of two songs starts at half, done is full, and it never goes backwards; the single-song dialog gets the same bar over its parts.

**Name a prepared set, and write it at the root of the band's folder**

Two things about where a set goes and what it is called.

**Make the contract's home this file, not a pair of them**

The prepared-set contract said it lived in both repositories, the website's copy kept for the reader. The website's repository is going, and a promise of a twin nobody keeps is worse than none. The file now says it is the contract's home, and that a reader — the website, when it is built again — takes a copy and keeps it current from here.

**File the checker's findings so a long report can be worked through**

Twenty songs give a hundred and thirty-nine findings, and a flat list is fine to glance at and hopeless to act on. Every finding now carries a subject — parts, playback, devices, tempo, keys, lengths, sections, slates, stops and segues, the set — so the report can be read by song or by subject, each group folding shut as it is dealt with, the three severities switched on and off, a box to search by, and from any song's group a way straight to that song. Worst first or as checked. Copy it out as text, arranged as it is on screen. How it is arranged is remembered on this device: the way you read a report is a habit, not a choice per set.

**Pin an output in Chrome, read a song's notes off its group track, and prepare from the setlist and the song**

Three things, sharing files, committed together.

**Loop a section with one tap, and file slates apart from the click**

Two small things for the room.

**Default to 48 kHz wherever a rate has to be assumed**

The rig runs at 48, and everywhere the code had to guess a rate it guessed 44.1: the lead-in measurement when no rate was given, a bounce with no track to take the rate from, a set that omits a sample's rate. Slates were not a guess but a fixed 44.1 — the helper's output, the track writer's figure for placing them in the set, and the duration the tools showed all agreeing on it — so the three move to 48 together, which is what a set at 48 wants to be handed. Slates already in sets go on working; Live resamples.

**Measure the encoder's lead-in at the rate the set is actually encoded at**

Prepare decodes, renders and encodes at the audio context's rate — the Mac's output rate at the moment — but measured the encoder's lead-in at 44.1 kHz whatever that rate was. The lead-in is a fixed count of samples, which is a different number of seconds at 48 kHz than at 44.1, so a set prepared on an interface running at 48 was stamped with a lead-in about two milliseconds too long, and every part of every song played that much early against its grid. The parts stayed locked to one another, all carrying the same error, which is why nobody heard it as anything in particular.

**Write the click and cues as sampler parts, not song-length files**

A click is two short samples struck on every beat, and a cue track a handful of spoken files placed along the song. Rendering either into a song-length MP3 made megabytes out of kilobytes and put its timing at the mercy of an encoder. The set had the pattern all along; now the pattern is what gets written.

**Package the studio as an app that installs like any other**

The app in /Applications has always been a window onto this folder: it needs Node on the machine and the repo on the disk, and rebuilds itself on launch. Right for the Mac the studio is developed on, where a commit is the deploy, and no use at all on a Mac that only plays sets.

**Call a reference stem by its instrument, and say what it is underneath**

A set keeps the finished record beside the band's parts — a REF folder with a REF DRUMS or a REF VOX to check a line against — and those play alongside the band like any other part. They are not the reference master, which is a whole mix and the thing SWITCH plays; that stays as it was.

**Fail a stuck prepare, make room for it, and say what has nothing to play**

Three things out of one stall: a prepare that sat at 82% for ten minutes with no way out of the dialog.

**Update what a set says about a song, without re-rendering it**

Almost everything the studio publishes about a song is not the audio. The sections, the chords, the lyric lanes, the key and the rig's patch changes live in set.json beside the parts, with the words also written out as .lrc and .cho. Adding a section name changes none of the MP3s — so re-encoding gigabytes of stems to publish a spelling correction is a wait nobody should have to sit through, and after a rehearsal where three section names changed it is the difference between the band having them tonight and next week.

**Stand the mixer on end, and make pan a knob**

The mixer now runs either way up. Rows stay as they were — a couple of lines per channel with a fat horizontal fader, which is what works on a phone. Strips stand the channels side by side like a desk, so eight faders are in view and in reach at once, which is what you want on a laptop with a mix to balance. Per device and the same on every song; it changes nothing about the mix, so it never goes near the library.

## 2026-09-02

**Make the set tools sub-tabs, under what they all share**

They were a row of chips sitting between the set and the songs to work on — two controls that are the same whichever tool is picked. A shared control underneath a switcher reads as belonging to whatever is switched, so both now sit above it and everything below the bar is genuinely the chosen tool.

**Say on the button what loading several songs costs**

The tooltip named the control rather than answering the question anyone hovering it has: what is this for, and what does it cost me. Holding a run decoded is the one thing in the studio that can bog a machine down, so the button says so where the choice is made, not only in Settings where the budget lives.

**Open several songs at once, and hold them ready**

Tick songs on the Songs page and they open together as a run, in the order the setlist plays them rather than the order they were ticked. Opening a song decodes every one of its parts, which for a set of WAV stems is seconds of work — fine once, tiresome as the only way to get from song three to song four. A run names the songs the next hour is about, builds them in the background one at a time, and holds them, so Previous and Next cost nothing but rebuilding the audio graph.

**Keep the studio's own things under its own name**

The folders the studio remembers, and the browser profile the launcher uses, sat in an Application Support folder called Rehearsal Tool Suite — the name of the website's repo, not of this app. Alex's rule: the website is Rehearsal Tool, a separate but connected project, and anything to do with this app is Rehearsal Tool Studio. The state moves to a folder of that name, copied over once from the old one so nobody picks their folders again, and the README says which project is which.

**Publish the band's library under both names for now**

The site in production reads only .learning-songs.json until the release that knows .rehearsal-tool.json goes out. A studio writing just the new name would leave the band a library frozen on the day of the rename, so both are written, and the old one can go once production reads the new.

**Drop the old name from the studio**

Nothing here was ever "Learning Songs": the web app manifest, the media session, the cache database and the console tags now say Rehearsal Tool Studio. The library file becomes .rehearsal-tool.json — in the sets folder and in the band's — and is read under its old name when the new one is not there yet, so nothing published before today is lost; the next save writes the new one.

**Write down what a prepared set is**

The website reads what the studio writes, and nothing said what that was except the code. docs/prepared-sets.md now does: where a set goes, how song folders and parts are named, the encoder's lead-in, the .lrc and .cho beside each song, set.json field by field with the rules the reader follows, and the band's library file. The README's folder path for prepared sets was also two renames out of date.

**Say plainly when a song has been prepared**

When preparing finished, the sheet went quiet: the Prepare button greyed out, a line said what was written, and nothing said the job was over. It now says so — "Done — the song is prepared", in green — and the only button left is Close, already focused, so Return or Escape or a click ends it.

**Keep the song loaded while Settings is open**

Opening Settings unmounted the player, and with it the song: every stem decoded again on the way back, and whatever was playing stopped. The player is now held, hidden, behind Settings, and let go only when the page goes somewhere else. A bar above Settings says which song is still loaded and takes you back to it. While hidden, the player's shortcuts stand down, so a space in Settings does not start the band.

**Say on the songs page which songs are missing audio**

A song whose stems were not there to play looked like any other in the list until it was opened. Each row now asks after the song's own files — not the set's click and cues, which are the set's affair — and wears a "3 files missing" badge when some are not in the folder or lie in one the studio may not read. One answer per song per state of the folders, shared by every row that asks, so the page does not ask twenty times over each time it is shown.

**Ask about a file by the path the set wrote**

The missing-files check lowercased every path before asking the server whether it was there. The server matches a path against the folders it was given letter for letter, so a sample in an allowed folder came back "not a folder the studio was given", and the notice offering to allow that folder never went away — allowing it changed nothing. The paths are still keyed without case, so one file is asked about once, but they are asked about as written.

**Every part loads, always**

A device could choose not to load parts of a song — a parts picker, and a per-song list of skips it wrote — and the mixer then lacked them. Meant for a phone on a data allowance, it made no sense in a studio reading its own disk, and it swallowed a set's click and cues. Gone: the picker, its button, the skip list, and the notice that had just been added to explain them. Every part of a song loads; what is not there to play is said on the page.

**Show a part switched off on this device, and the engine's rate**

The parts picker — and an older picker on its own initiative — could record a part as not to be loaded, and the mixer then simply lacked it. A set's cues vanished that way. The song page now says which parts are switched off on this device and turns them back on in one tap.

**Name a cue clip that could not be read**

An arranged part quietly dropped any clip whose file would not read or decode. It still plays the rest, and now the page says which files were left out and why.

**Let the server say which build it is, so a stale one gets replaced**

The server answered "which build" by reading the stamp on disk afresh, so a rebuilt bundle behind a server still running last week's file API looked current, and the launcher never replaced it — a page asking for a folder slot the server had never heard of got "no such slot". The server now says the build it started with as well; the launcher replaces one that is behind the disk, and a server too old to say is replaced too. The page's "newer build" banner follows the server it is talking to, not the file on disk.

**A file that is nowhere is missing, not forbidden**

A set's stale path to a sample on another machine was reported as a folder the studio had not been allowed to read, and offered to allow it. A file that is not there is missing whatever its folder; reading it is still refused.

**Say what is not here, instead of asking what to download**

Opening a song with a file out of reach put up the band site's download chooser — versions, ticks, a price in megabytes — for a studio that downloads nothing. It is gone from the way in. The page now says what is not here to play: files not in the folder, by part; files in a folder the studio has not been allowed to read, with the folder they share and a button to allow it; parts that failed to load and why. A part that cannot be loaded is left out and the song opens with the rest, where it used to fail whole.

**Play a set's drum-rack click and cues, from samples kept elsewhere**

A set's click and some of its cues are MIDI: notes on a track playing a drum rack, each pad a sample. None of that was audio the player could see. Now a rack track's pads are read — which note plays which sample, at what level, from where in the file, the note being 128 less than Live writes it — and every note on the track's clips, the loops unrolled for as long as each clip runs, becomes that sample laid at the note. They join the song's click and cues as clips like any other.

**One click: the set's, when it has one**

A set's click track came in as a part beside the player's own rendered metronome, so a song could carry two clicks. Now the set's click is the click: the metronome is taken down when a song brings one, the transport's click button and the mixer's mute drive whichever is in use, and the mixer shows one click row either way.

**Bring the set's click and cues into every song**

A set keeps its click and its cues outside any song's group, on tracks that run the length of the set — a slate per song, a pitch reference here and there, a click track. None of that reached the player, which had only the song's own group. Now every song gets them as parts of its own: every cue track summed into one "Cues", every click track into one "Click (set)", each cut to the clips inside the song with the track's fader folded in. Neither is ever transposed. A slate file named after its song is no longer mistaken for a version of it.

**Cache a prepared part's render under its own file**

A part Live plays transposed is shifted before it is encoded, and the render was cached under the semitones, the speed and the buffer's length and sample rate — which six stems of one song share, so every part came out as the first one rendered: the drums, six times over. The file's own path is part of the key now, as it always was for the player's renders.

**Never reload the page under someone, and ride out a server gap**

The shell reloaded the page whenever the app came back with a newer build behind it — once in the middle of preparing a song. Now it only sends the page the focus event a WebKit window withholds, and the page's own banner offers the reload; the person decides.

**Leave a return bus's processing to the venue**

The EQ and compression on a set's return buses shape what goes out of the interface, not what the band should hear while rehearsing. They are read still, but the player no longer builds them, asks about them or warns about them: a part reaches the output at its own fader, and only the devices on its own track and groups are imitated.

**Imitate the set's devices in Web Audio, if asked**

A web view cannot host a plugin, so what a track runs through in Live was simply absent here. Now the set's devices are read — on the tracks, on the groups above them, and on the return buses the tracks send into, with the routing between them — and a song that runs through any of them asks, once, whether to imitate them or play raw.

**Say a bar in another meter in one breath**

A single 2/4 bar read as two caveats, the change and the change back. A stretch that comes straight back is one sentence now: which bar, or which bars, and in what.

**Start the mixer where the set has it, and say what cannot follow**

Every part opened at unity, centred, whatever Live had it at. A part now carries the set's fader — the track's times every group's above it, the song's own group included — its pan, and a clip's own gain, and the mixer starts there until you move it on this device. The preparer prints parts at those levels too, and a combined part sums them as Live mixes them. A clip's gain rides through the arranged render with its fades.

**Read a hairline warp pair, and mirror a clip's pitch and warp**

A file dropped onto a warped track gets a warp pair a few milliseconds apart, and the parser dismissed that as too short to be a rate — so the clip counted as unwarped, its beat offset was read as seconds, and the vocal after the dropped-in phrase started 10 seconds in instead of 7. The hairline pair states the tempo exactly and is used now.

**Play a part's arrangement, not just its first file**

A track playing more than one clip — a phrase dropped in from another take, the vocal picked up again ten seconds further in — reached the player as one file placed once, so everything past the first clip played from the wrong place and a dropped-in file never played at all. The set knew the arrangement; the preparer rendered it; the player did not. A part now carries every clip whose file is in the folder, and the loader lays them out flat with the same renderer the preparer uses before handing the engine one buffer. One clip is still just the file.

**Say nothing about Dropbox in the studio**

The studio reads a folder; where that folder syncs to is nobody's business here. The folder panel, the first-run screen and the two prepare notices no longer mention it.

**Prepare one song for the band, choosing its parts**

Preparing was a whole-set affair in Settings, every track of every song written out. A song page now carries one big button: prepare this song for Rehearsal Tool. It lists the set's tracks for the song, each to be printed as a part of its own, combined with the others into one part — a "band" to play along to — or skipped, and then renders them as the arrangement has them, encodes them small, and writes them into the band's folder under a name their app reads without help: tempo, key and time signature in the folder name, the part in brackets, words and sections beside, manifest and library updated.

**Start a part's file where the set placed its clip**

Every part's file played from the song's bar 1, and the region gate muted it until the clip's start — so a set whose clips begin two bars after the locator, as Cruel Summer's do, played the first two bars of every file under the mute and lost the intro. A part now carries where its file sits: at which bar the file's start lands, and how far into the file it enters. The engine starts each source there — late when the clip is placed later, partway in when it began before the song — and the loop points, the song's length, the end-of-song detection and the offline print all follow the same clock.

**Count an unnamed rig clip**

A MIDI clip on a rig track sends what it sends whether or not anyone named it, and most are not named. Text tracks still drop an unnamed clip, since a clip with no words is nothing to show.

**A Rig block of its own, and headings you can read from a stand**

The Rig block only appeared where the window could send MIDI, which a WebKit window never can — so the studio had no Rig block at all. It is always there now: the patch lane, the timecode tool moved in from the Song block, and a note that Live is what drives the rig from here.

**Play a song at the tempo Live plays it**

A song's tempo came from its locator's name, and failing that from the set tempo — so a set whose songs are timed by tempo automation, with plain locators, played every song's bar grid at the set's 111 while the audio ran at 85 or 164. The audio was right and everything measured in bars was wrong: lyrics, markers, loops, the click. The tempo in force where the song starts is what Live plays it at, and is what the song now gets; a locator's BPM is a label, and the set tempo only what is left when nothing else says.

**Only the reference song switches; REF parts are parts**

A track with "REF" in its name became an exclusive mix, so a REF folder holding the record's own drums and vocals — REF DRUMS, REF VOX, REF LV — turned into versions to switch between rather than parts to blend. Only the reference song is that: "REF SONG", "Ref Master", "Full Mix", a bare "Reference". A reference word followed by the name of a part now makes a stem, mixed alongside the rest like any other.

**Read the folder on every launch**

A newer build makes more of a set than the one before it did, but the library it found waited in the file until somebody pressed rescan — so a fix to the parser looked like no fix at all. The folder is the truth and is read on every launch now: once per page, after the file has been read, whenever there is a folder to read.

**Show every song in the set, audio here or not**

A song whose stems were not in the folder was dropped from the import, so a set of twenty read as a list of two. It is still a song in the set: it keeps its place in the running order, its tempo, key and sections, and it should say what is wrong rather than vanish. Every song now imports; one with nothing to play is marked "no audio" in the list, explains itself in the player, and is counted on the set chooser as "without audio here".

**Match a song to its group whatever the two were called**

A song's stems come from the group track named after it, and the two names are typed separately and drift. In the first real set: the group "Forever & Always" against the locator "Forever and Always" — and worse, Live escapes the ampersand in the file, so the group read back as "Forever &amp; Always" and matched nothing; a locator carrying "- Play in F" that the group never did; a group called just "22" for "22 Song". Four songs had "no audio tracks" that plainly had them.

**Reload the window when the server has a newer build**

A window left open kept the page it loaded, and only offered a reload when the page noticed a newer build on focus — a focus event a WebKit window does not reliably send. The shell now remembers which build it loaded and asks the server again whenever the app is activated; when the answer has moved on, the page is reloaded from the origin. The first load also bypasses any cache, so a relaunch is always the build on disk.

**Offer every set the scan found, and find moved stems by name**

The chooser listed only sets whose songs had audio here, so a set whose stems were elsewhere — every one of them, in the first real folder it met — left nothing to choose. A set is a set whether its stems are here or not: it can still be checked, given slates and chords, its setlist printed. The sets the scan finds are now remembered and offered, each saying how many of its songs have audio here.

**Open on a set, and keep only a set's songs**

The studio is about one Ableton set at a time. Opening it now asks which — a list of the sets the folder holds, scanned first if it never was — and from then on Songs shows that set's songs, Setlists its running order and any list made out of its songs, Set tools works on it, and Prepare prepares it. A bar under the tabs names the set and changes it. The choice lasts a session: every launch asks again.

**Rehearsal Tool Studio, on its own**

The studio was one of two builds of a codebase shared with the band's website, told apart by a build-time flag and carrying everything the site needed: Dropbox, sign-in, the service's API, a staging copy. It is one tool for one machine, and it now has a repo of its own with only what that tool is.
