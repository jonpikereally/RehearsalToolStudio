# Prepared sets

What Rehearsal Tool Studio writes into the band's folder when a song or a set
is prepared, and what the Rehearsal Tool website should make of it.

The same file lives in both repositories. The Studio is the writer, so its
copy is the one to change first; the website's copy is there so the reader
has the contract to hand.

## The one idea

A prepared set is an **ordinary library folder**. Small MP3s, one folder per
song, tempo and key in the folder name, parts told apart by bracketed labels.
Nothing in it needs the Studio, Ableton or this document to be played: the
website reads it by exactly the rules it reads a hand-made folder by.

Two small files carry what a file name cannot: a `set.json` beside the songs
(tempo map, sections, chords, lyric lanes, the encoder's lead-in) and the
band's library file at the root of their folder. Both are optional to the
player, and both are what make the set more than a pile of audio.

## Where it goes

```
<band folder>/                         the band's Dropbox app folder
  .rehearsal-tool.json                 the band's library, rebuilt on publish
  Rehearsal Tool/
    Sets/
      TS TEST FOR RTS 2026-09-02/      one prepared set: "<set name> <date>"
        set.json                       the manifest
        Cruel Summer {85, G, 4-4}/     one song
          Cruel Summer [ref drums].mp3
          Cruel Summer [ref vox].mp3
          Cruel Summer [bass].mp3
          Cruel Summer [guitar].mp3
          Cruel Summer [band].mp3      a combined part, named in the Studio
          Cruel Summer [click].mp3
          Cruel Summer [cues].mp3
          Cruel Summer.lrc
          Cruel Summer.cho
        august {90, 4-4}/
          ...
```

- `Rehearsal Tool/Sets/` is the only place prepared sets are written. Anything
  under `Rehearsal Tool/` that is **not** under `Sets/` is a print: a mix the
  Studio rendered of a song that already exists, attached to that song on
  scan rather than listed as a song of its own.
- The set folder is the Ableton set's file name plus the day it was prepared,
  `YYYY-MM-DD`. Preparing one song writes into the same day's folder as the
  rest of the set, so a set prepared a song at a time still ends up in one
  place.
- Characters a file name cannot carry (`\ / : * ? " < > |`) are stripped from
  every name, and runs of spaces are collapsed to one.

## The song folder

`<Title> {<tempo>, <key>, <num>-<den>}`

| Field | What it is | Notes |
| --- | --- | --- |
| tempo | the tempo Live plays the song at, to one decimal | the tempo automation's value at the song's start when there is any, else the set's tempo |
| key | the song's key, as the set's locator wrote it | left out when the set does not say |
| time signature | the set's, hyphenated | `4-4`, never `4/4`: a slash cannot appear in a file name |

The website's scan lifts these from the folder name and strips the curly block
from the title, the same as for a folder someone named by hand. A song may
change tempo part way through; the folder name carries only the first tempo,
and the manifest carries the rest.

## The parts

`<Title> [<label>].mp3`, one file per part. Square brackets are what make a
file a part. Every part of a song starts at the same instant, runs the
length of the song, and is meant to be played alongside the others.

- **The label is the Ableton track name**, lowercased, with Live's trailing
  duplicate number removed: a track called `Bass 1` becomes `[bass]`.
- **A reference part says so**: a track filed under the set's `REF` group
  comes out as `[ref drums]`, `[ref vox]` and so on, so the record's lead
  vocal can never be mistaken for the band's. The prefix is not added when
  the label already contains `ref`.
- **A combined part** is several tracks summed into one, under a name typed
  in the Studio, `[band]` by default. It is pulled down as a whole if the sum
  would clip, and left alone otherwise.
- **`[click]` and `[cues]`** are the set's own click and cue tracks, one file
  each, when the set has them. They are written like any other part; the
  player treats `[click]` as the click track.
- The audio is what Live would play: clips laid end to end with gaps silent,
  fades applied, clip and track gain in, a clip's own transposition and warp
  speed rendered in. Anything on a return bus is ignored, and third-party
  plugins are not rendered.
- MP3 at 192 kbps, at the source file's sample rate, with the source's
  channel count up to stereo.

Parts that could not be written are skipped and named in the Studio, not
silently left out with a placeholder. A song with no part written gets no
folder.

## The lead-in

MP3 encoders add a short silence at the front, and browsers do not all trim
it. Every part of every song gets the same lead-in, so parts stay locked to
each other, but **bar 1 of a song sits `firstBarOffsetSec` seconds into each
file**, not at zero. The manifest carries the figure per song, and the set's
`paddingSec` is the same figure for the whole run. The player must add it
before any bar maths, or every song plays fractionally late against its grid.

## `<Title>.lrc` and `<Title>.cho`

- The `.lrc` holds the song's lyrics with a timestamp per line, `[mm:ss.xx]`,
  computed from the bar each line sits on, through the tempo map. Timestamps
  are **song time**: zero is the downbeat of bar 1, so the lead-in above has
  to be added to place them in the file.
- The `.cho` is the same song as a ChordPro chart for a person: chords over
  the words, sections named, key and tempo at the top. Any songbook app reads
  it. The website does not need it.

Neither is written when the set has no lyrics or no chords.

## `set.json`

One per set folder, written after the parts. It is what the folder names have
no room for. Without it the set still plays, at one tempo with no chart, the
way a hand-made folder would.

```json
{
  "preparedBy": "rehearsaltool",
  "preparedAt": "2026-09-02T14:05:11.000Z",
  "fromSet": "TS TEST FOR RTS Project/TS TEST FOR RTS.als",
  "paddingSec": 0.0261,
  "songs": [
    {
      "folder": "Cruel Summer {85, G, 4-4}",
      "title": "Cruel Summer",
      "firstBarOffsetSec": 0.0261,
      "originalKey": "G",
      "tempoMap": [{ "bar": 1, "bpm": 85 }, { "bar": 41, "bpm": 90 }],
      "markers": [{ "bar": 1, "name": "Intro" }, { "bar": 5, "name": "Verse 1" }],
      "chords": [{ "bar": 5, "text": "IV" }, { "bar": 7, "text": "V" }],
      "lanes": [
        { "id": "lead", "name": "LYRICS", "kind": "lyrics", "items": [{ "bar": 4, "text": "Yeah, yeah, yeah, yeah." }] },
        { "id": "chords", "name": "CHORDS Nash", "kind": "chords", "items": [{ "bar": 5, "text": "IV" }] }
      ],
      "patchClips": [
        { "id": "als:…:0", "bar": 1, "patch": { "channel": 1, "program": 12 } }
      ]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `preparedBy` | yes, exactly `"rehearsaltool"` | how the scan knows the file is meant for it; anything else is ignored |
| `preparedAt` | no | ISO time of the run |
| `fromSet` | no | the `.als` it came from, relative to the Studio's sets folder; absent when written by hand |
| `paddingSec` | no | the encoder lead-in for this run, in seconds |
| `songs` | yes, a list | one entry per song folder, in the set's running order |
| `songs[].folder` | yes | the song folder's name, relative to the set folder; how the entry is matched to the scanned song, case-insensitively |
| `songs[].title` | no | the song's title, in case the folder name had to be cleaned |
| `songs[].firstBarOffsetSec` | no | seconds from the start of each file to the downbeat of bar 1 |
| `songs[].originalKey` | no | the key the set gave the song |
| `songs[].tempoMap` | no | `{bar, bpm}` list, 1-based bars; the full map, first entry included |
| `songs[].markers` | no | `{bar, name}` list of sections |
| `songs[].chords` | no | `{bar, text}` list, one chord per bar it changes on |
| `songs[].lanes` | no | the set's `+LYRICS` tracks kept apart: `{id, name, kind: "lyrics" \| "chords", items: [{bar, text}]}` |
| `songs[].patchClips` | no | rig patch changes, `{id, bar, patch: {channel, program?, bank?, controls?}, lengthBars?, endPatch?}` |

Rules the reader follows, and a writer can rely on:

- **Unknown fields are ignored**, so a later Studio may add some. Known fields
  are checked strictly for type, and a manifest that fails applies nothing;
  the errors are shown rather than swallowed, since a `set.json` can be
  written by hand.
- **Matching is by folder name**, case-insensitive. A song in the folder that
  the manifest does not mention is left exactly as scanned.
- **A manifest's values replace the song's where the manifest has them.**
  Where it has none, what the library already held stays: a manifest with no
  `patchClips` does not wipe patch changes programmed in the app.
- Markers keep the ids they already had when the bar and name match, so the
  library file does not churn on every scan.
- **Partial runs merge.** Preparing one song reads the manifest already in
  the folder, replaces that song's entry, keeps every other, and writes the
  whole back in set order. Songs no longer in the set keep their entry at the
  end rather than being dropped, because their files are still there.

## `.rehearsal-tool.json`

The band's library file, at the root of their folder. It was called
`.learning-songs.json` before the app was renamed; every reader still falls
back to that name when the new one is not there, and the next publish writes
the new one. After writing a set the
Studio rebuilds it by **reading the band's folder back**, running the same
scan the website runs, applying every `set.json` it finds, and merging the
result into the library that was there. Reading back rather than writing what
it thinks it wrote is deliberate: the library must describe the files as the
website will find them.

Merging, not replacing, is what keeps last month's set and anything the band
typed against those songs. Songs keep their ids across publishes, since an id
is the folder path and base name, lowercased.

The website reads this file through its service. A rescan in the website
would produce the same songs from the same folder, and applies the manifests
the same way.

## What the website is expected to do

1. Scan `Rehearsal Tool/Sets/` as an ordinary library folder. Group files by
   base name once every tag is stripped; `[square]` files are stems, `(round)`
   files are versions, `{curly}` values are tempo, key and time signature.
2. Treat anything else under `Rehearsal Tool/` as a print and attach it to the
   song whose title it carries.
3. Apply every `set.json` under `Rehearsal Tool/Sets/` by the rules above.
4. Offset all bar maths by the song's `firstBarOffsetSec`.
5. Treat `[click]` as the click track and leave it, and `[cues]`, untransposed.
6. Play the parts of a song together; they are the same length and start at
   the same instant.

Everything above is what the code in `src/lib/prepare.ts`, `src/lib/prints.ts`
and `src/lib/preparedSet.ts` does. When they disagree with this file, the
code is right and this file is behind.
