# Rehearsal Tool Studio

The workshop side of Rehearsal Tool, as a Mac app for one machine: the one the
Ableton sets live on. It reads the sets off this disk, prepares them into
folders of small files anyone can play, publishes those to the band, and plays
them itself — songs, stems, versions, loops, charts. Nothing here deploys,
signs in, or talks to Dropbox's API; the folder it reads is inside Dropbox,
and the desktop client carries what it writes to the band.

The band's own player is a separate codebase, the website in the *Rehearsal
Tool Suite* repo. This repo is only the studio.

## What it does

- **Reads Ableton sets.** Every `.als` in the folder is opened on a rescan.
  Locators name the songs, group tracks hold their stems, `+SECTIONS` and
  `+LYRICS` tracks carry the words — no exports, no file naming.
- **Plays them.** Every version of a song decoded and played together with one
  audible, so switching is instant and sample-accurate. Bar-accurate jumps and
  loops, transposition rendered offline and cached, a metronome, markers,
  setlists, a mixer over the stems.
- **Prepares a set for the band.** Each song written out as small files into
  the band's folder, with a library naming them, so their app has tempos, keys,
  sections and a running order — not just audio.
- **Set tools.** A preflight check of everything the parser can see going wrong
  live, spoken slates onto a Slates track, chord-language conversion, timed
  lyric clips via Lyrics Studio, patch changes written into the `.als`, and a
  printable setlist whose durations come from the arrangement. Everything
  writes to a copy, never the original.
- **Prints a mix** to a file, and drives nothing: this window has no Web MIDI.

## Installing it

Needs Node, `uv` (for Lyrics Studio) and the command line tools (`xcode-select
--install`) — not Xcode.

```bash
npm install
bash scripts/make-mac-apps.sh
```

That builds **Rehearsal Tool Studio.app** and a **Lyrics Studio.app** stub into
`/Applications`. Run it from a normal terminal, not a sandboxed agent: macOS
refuses apps stamped with a sandbox's provenance. Run it again if this folder
moves, since the studio app carries the repo's path.

Click the app. On the first run it asks for the folder your sets live in — the
macOS folder dialog — and remembers it from then on. Rescan reads every set.

## How it runs

```
Rehearsal Tool Studio.app        a WebKit window (mac/RehearsalToolStudio/)
   └─ scripts/app-launch.sh      builds dist/ if the commit or source has moved
        ├─ scripts/serve-studio.mjs   serves dist/ on localhost:5177, loopback only
        │    └─ scripts/studio-files.mjs   /__fs/: the folder, read and written by path
        └─ scripts/slate-helper.mjs   spoken slates via `say`, on 5175
```

A WebKit window has no File System Access API, so the page never touches the
disk itself. It asks its own server, which runs on the same machine as the
files. The server answers only the page it served, only for folders picked
through its dialog, and never for a path that climbs out of one. The folders
it remembers live in `~/Library/Application Support/Rehearsal Tool
Suite/studio-folders.json`, which is why nothing ever has to be "reopened".

`build.json` in `dist/` carries the commit the build came from. The launcher
holds it against git and rebuilds when they differ; an open window notices a
newer build on focus and offers a reload. Settings shows the build and when it
was made. A failed build serves the previous one and says why in
`.studio-build.log`.

Lyrics Studio is its own local server (`lyrics-studio/`, Python, on 8765),
opened in the default browser. Links out of the studio window go there too.

## Working on it

```bash
npm run serve      # the real server on 5177 — the dev server passes /__fs to it
npm run dev        # Vite on 5174, against the working tree
npm run typecheck && npm test && npm run build
```

`npm test` is a self-test of the pure logic and of the server's file API,
which it stands up against a scratch folder. `npm run build` writes `dist/`,
which the app serves; there is no other build, no staging copy and nothing to
deploy.

## Two folders

The studio holds two, kept apart on purpose. **Your sets** is the workshop it
reads: sets, stems, gigabytes of WAV. **Publish to** is the band's own Dropbox
app folder — a different app folder, and the only one their app can read — so
what the studio prepares is written there rather than beside what it was made
from. Both are chosen once in Settings and remembered.

## What a prepared set looks like

Each song becomes a folder of small files under `Prints/Prepared/<set>/`, with
a `set.json` manifest beside them carrying sections, chords and lyrics. The
files follow one naming convention so nothing depends on this app to read
them:

| Bracket | Means | Example |
| --- | --- | --- |
| `{curly}` | song info — tempo, key, time signature | `{128, F#m, 4-4}` |
| `[square]` | a stem, mixed alongside the rest | `[guitar]` |
| `(round)` | a complete alternate mix, exclusive | `(no vocal)` |

The time signature is written `4-4`, since a slash cannot appear in a file
name. A `set.json` can also be written by hand for a folder of audio that never
came from Ableton; the schema is in `src/lib/preparedSet.ts`.

## Ableton conventions it reads

- A **locator** starts each song: `Fix You / 5:00 / Eb / 136BPM`. `AUTOSTOP`
  ends one. AbleSet's `+PAUSE`-style flags are kept.
- A **group track** named after the song holds its stems; a track called
  `Ref Master` or similar is a reference mix, not a stem.
- `+SECTIONS` and `+LYRICS` MIDI tracks carry section names and chord or lyric
  text as clip names.
- `*rig` locators carry patch changes, and are what the Patch changes tool
  writes back.
- `Backup`, `Samples`, `Ableton Project Info` and `AbleSet` folders are never
  scanned.
