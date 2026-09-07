# Prepared sets

What Rehearsal Tool Studio writes into the band's folder when a song or a set
is prepared, and what the Rehearsal Tool website should make of it.

This is the contract's home. The Studio is the writer, and what it writes is
whatever this file says on the day; a reader — the website, when it is built
again — should take a copy of this file into its own repository and keep that
copy current from here, since a reader working from an old contract is the
one way the two can quietly disagree.

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
  Sets/
    TS TEST FOR RTS 2026-09-02/        one prepared set, named in the Studio
      set.json                         the manifest
      Cruel Summer {85, G, 4-4}/       one song
        Cruel Summer [ref drums].mp3
        Cruel Summer [ref vox].mp3
        Cruel Summer [bass].mp3
        Cruel Summer [guitar].mp3
        Cruel Summer [band].mp3        a combined part, named in the Studio
        Cruel Summer.lrc
        Cruel Summer.cho
      august {90, 4-4}/
        ...
  Resources/                           the one-shots sampler parts strike,
    MetronomeUp-1a2b3c4d.wav           once for every set in the folder
    MetronomeDown-5e6f7a8b.wav
    Chorus-9c0d1e2f.wav
    slates/                            the spoken titles, kept apart
      Fix You-3d4e5f6a.wav
  Prints/                              mixes of songs that already exist
    136BPM Stems/
      Fix You (no vocal v1 2026-08-13 rehearsaltool).wav
```

- `Sets/`, at the root of the band's folder, is the only place prepared sets
  are written; every folder directly inside it is one set. `Prints/` holds
  mixes the Studio rendered of songs that already exist, to be attached to
  those songs on scan rather than listed as songs of their own; `Resources/`
  holds the samples sampler parts strike. All three sit at the root.
- **Older bands have all of this under a wrapper folder,** `Rehearsal
  Tool/Sets/`, with prints as anything under `Rehearsal Tool/` that was not
  under `Sets/`. The wrapper doubled the app's name in the path — the band's
  folder already lives inside a Dropbox app folder called Rehearsal Tool —
  and is not written any more, but nobody's files are moved: a reader looks
  for a folder called `Sets` (and `Prints`, and `Resources`) wherever it
  sits, and a band that prepares again simply has the two shapes side by
  side.
- The set folder is named in the Studio when the set is prepared: by default
  the Ableton set's file name plus the day, `YYYY-MM-DD`, but it can be
  called anything the band would recognise. The Studio remembers the name
  per set, so preparing one song later writes into the same folder as the
  rest, and a set prepared a song at a time still ends up in one place.
- Characters a file name cannot carry (`\ / : * ? " < > |`) are stripped from
  every name, and runs of spaces are collapsed to one.

## The song folder

`<Title> (<date rendered>)` — for example `Cruel Summer (2026-09-06)`.

The title, and the day the song's audio was last rendered, so a folder says
how fresh its files are. A song whose audio has not changed keeps its folder
and its date across later prepares; a song rendered again on a later day
gets a new folder, and its old one is taken out of the set (kept aside for
undo, in a hidden `.undo` folder a scan must ignore). The set's `set.json`
always names the folder each song is in now.

**A song's identity is the title part of its folder name** — the name with
the trailing ` (YYYY-MM-DD)` removed — not the folder name itself, which
moves with the date. Key per-song state, rig files and anything else that
must survive a re-render by set + song name, never by folder. Strip the date
from the title when showing it.

Older sets named the folder `<Title> {<tempo>, <key>, <num>-<den>}`; a
reader should still strip that curly block from the title and may still
lift the facts from it. Everything it carried now travels in `set.json` and
in the folder's own `song.json` (`tempo`, `timeSignature`, `originalKey`),
and both kinds of folder can sit in one set.

## The parts

`<Title> [<label>].mp3`, one file per part. Square brackets are what make a
file a part. Every part of a song starts at the same instant, runs the
length of the song, and is meant to be played alongside the others.

- **The label is the Ableton track name**, lowercased, with Live's trailing
  duplicate number removed: a track called `Bass 1` becomes `[bass]`.
- **A reference part says so**: a track filed under the set's `REF` group
  comes out as `[ref drums]`, `[ref vox]` and so on, so the record's lead
  vocal can never be mistaken for the band's. The prefix is not added when
  the label already contains `ref`. These are **reference stems** — the
  record's own drums or vocal, playing alongside the band's parts like any
  other. They are not the reference *master*, which is a whole mix and is
  what SWITCH plays. `set.json` names them outright under `parts`, and the
  player is expected to label such a fader with the instrument alone —
  `[ref drums]` is "drums" — and say "reference" beside it rather than
  inside the name, where it would compete with the instrument for the same
  few characters.
- **The record itself is tagged as such.** A set often keeps the finished
  song — a track called `REF SONG` or `Ref Master` — beside the record's
  parts, and it wants the opposite handling: not a fader in the mix but a
  whole song to switch to on its own, for checking the band against. Its
  `parts` entry carries `role: "mix"` and `record: true`, as well as
  `reference: true`; a reference *part* carries neither. The band's own full
  bounce (`Full Mix`) is a `mix` too, but not the record.
- **A combined part** is several tracks summed into one, under a name typed
  in the Studio, `[band]` by default. It is pulled down as a whole if the sum
  would clip, and left alone otherwise. How far it was pulled down is written
  as `gainDb` on its entry.
- **A submix** is a combined part chosen for a member rather than typed, and
  named for what is in it rather than for them:
  `submixes/<Title> [submix drums+bass+keys].mp3` inside the song's folder,
  everything that member does not keep on a fader of their own, summed at
  unity. Named that way, one file serves everybody who keeps the same things
  — it is written once and downloaded once — and a long list is cut short
  with four letters of its own hash on the end, so two lists never share a
  name. It is a part like any other — same lead-in, same 192 kbps, same rate
  — and the only one that does not sit in the song folder itself: a song
  folder of eight stems and four submixes is one nobody can read at a glance.
  Its `file` carries the path from the song folder, `submixes/…`, where every
  other part's `file` is a bare name. It is declared with three fields on its
  `parts` entry:

  ```json
  {
    "label": "submix drums+bass+keys+ref vox",
    "name": "submix drums+bass+keys+ref vox",
    "file": "submixes/Cruel Summer [submix drums+bass+keys+ref vox].mp3",
    "role": "stem",
    "hidden": true,
    "submixFor": ["Alex", "Casey"],
    "submixOf": ["drums", "bass", "keys", "ref vox"]
  }
  ```

  - **`hidden: true` is required**, and is what makes it safe to write before
    anything reads it: a player that drops hidden parts ignores the file
    rather than playing it on top of the parts inside it.
  - **`submixOf`** names the parts it stands for, by their own `name` fields —
    `"drums"`, not the file name — so one fader can go up in place of four.
  - **`submixFor`** is the members it was worked out for — a list, since one
    submix serves everybody who keeps the same things — each matched the way a
    rig file's `member` is: trimmed, case ignored. A player whose user is
    named loads that part plus every part not in `submixOf`, and nothing else;
    anyone else, and any song with no submix, loads every part as before. A
    set prepared before this carries a single name rather than a list.

  The band's library carries the same three on the variant, beside its path,
  so a player reading `.rehearsal-tool.json` needs no manifest of its own. A
  `submixes/` folder is a folder of one song's parts, never a song: anything
  scanning the band's folder has to read it as belonging to the folder above.

  A whole song is never in a submix — the record the band play against, or
  their own full bounce — since one summed in puts everything in it twice.
  Neither is the click or the cues, whoever the submix is for and whether
  they are sampler parts or rendered audio: they are the set's own
  timekeeping, and one summed into a submix is a click nobody can turn down.
  None of the three is offered as a part to keep, because keeping them was
  never a choice. A submix that would stand for fewer
  than two parts is not written: that is a part under a worse name. Who the
  band are, and what each of them keeps separate, is `members.json` at the
  root of the band's folder — the Studio's own file, and the only thing that
  has to be set for any of this to happen. A member keeps parts by name in
  `keeps`, and by word in `contains`: a set spells one instrument several
  ways — `gtr`, `guitar`, `guitar pop`, `ref gtr` — and one word says all of
  them, in this set and in the next one.
- **The click and cues are sampler parts, not files.** A click is a short
  sample struck on every beat and a cue track a handful of spoken files
  along the song; rendering either into a song-length MP3 made megabytes of
  file out of kilobytes of audio, timed by an encoder. Instead each becomes
  a part with `kind: "sampler"` in the manifest (and so in the library): a
  pattern of `notes` and the `samples` they strike, in exactly the shape the
  website already plays for a hand-written library. The samples are copied
  once, byte for byte, into `Resources/` at the root of the band's folder —
  named for what they contain, so one kick serves every set that fires it
  and two different kicks never collide — and `Resources/` is a folder the
  scan never reads, so nothing in it is mistaken for a song. Spoken slates,
  which the Studio writes onto a Slates track and which play as cues, go
  under `Resources/slates/` so a person opening the folder can tell a set's
  worth of titles from its click; to the player they are cues like any
  other, reached by the path on the sample. Sets prepared
  before this carry `[click].mp3` and `[cues].mp3` instead; a player should
  go on treating `[click]` as the click track when it meets one.
- The audio is what Live would play: clips laid end to end with gaps silent,
  fades applied, clip and track gain in, a clip's own transposition and warp
  speed rendered in. Anything on a return bus is ignored, and third-party
  plugins are not rendered.
- MP3 at 192 kbps, at the rate the Studio's audio engine was running at when
  the set was prepared — the Mac's output rate, every source having been
  resampled to it on decode — and the encoder's lead-in measured at that same
  rate; with the source's
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
      "folder": "Cruel Summer (2026-09-06)",
      "title": "Cruel Summer",
      "renderedAt": "2026-09-06T08:31:12.000Z",
      "tempo": 85,
      "timeSignature": "4/4",
      "bars": 96,
      "durationSec": 271.06,
      "firstBarOffsetSec": 0.0261,
      "originalKey": "G",
      "notes": "Piano intro. Watch the drummer for the stop.",
      "tempoMap": [{ "bar": 1, "bpm": 85 }, { "bar": 41, "bpm": 90 }],
      "markers": [{ "bar": 1, "name": "Intro" }, { "bar": 5, "name": "Verse 1" }],
      "chords": [{ "bar": 5, "text": "IV" }, { "bar": 7, "text": "V" }],
      "parts": [
        { "label": "ref song", "name": "song", "role": "mix", "reference": true, "record": true,
          "file": "Cruel Summer [ref song].mp3", "sources": ["REF SONG"], "frozen": true,
          "shifted": { "semitones": -2, "speed": 1 }, "covers": { "fromBar": 1, "toBar": 96 },
          "sizeBytes": 4351020, "bitrate": 128, "sampleRate": 48000 },
        { "label": "ref drums", "name": "drums", "reference": true, "file": "Cruel Summer [ref drums].mp3", "sources": ["REF DRUMS"] },
        { "label": "bass", "name": "bass", "file": "Cruel Summer [bass].mp3", "sources": ["Bass"], "gainDb": -3.5,
          "covers": { "fromBar": 9, "toBar": 96 } },
        { "label": "click", "name": "click", "kind": "sampler",
          "id": "cruel summer {85, g, 4-4}#sampler:click", "role": "stem", "rev": "1a2b3c4d+5e6f7a8b", "order": 2,
          "samples": [
            { "note": 44, "path": "Resources/MetronomeUp-1a2b3c4d.wav",   "rev": "1a2b3c4d…", "sizeBytes": 40960, "gain": 1.58 },
            { "note": 46, "path": "Resources/MetronomeDown-5e6f7a8b.wav", "rev": "5e6f7a8b…", "sizeBytes": 38210 }
          ],
          "notes": [
            { "bar": 1,    "note": 44 },
            { "bar": 1.25, "note": 46, "velocity": 0.79 },
            { "bar": 1.5,  "note": 46, "velocity": 0.79 }
          ] }
      ],
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
| `session` | no | the Ableton session that feeds this folder, as its absolute path on the Mac the Studio runs on — what the Studio opens when the folder is chosen at launch. The Studio's own; ignore it |
| `paddingSec` | no | the encoder lead-in for this run, in seconds |
| `songs` | yes, a list | one entry per song folder, in the running order: AbleSet's setlist when the project keeps one, the arrangement's otherwise. Play them in this order |
| `songs[].folder` | yes | the song folder's name, relative to the set folder, as it is now; how the entry is matched to the scanned song, case-insensitively |
| `songs[].title` | no | the song's title, in case the folder name had to be cleaned. Prefer it to the folder name |
| `songs[].renderedAt` | no | when the song's audio was last rendered, ISO; the folder name carries the day |
| `songs[].tempo` | no | the tempo at the song's start, to one decimal — what the folder name used to carry. `tempoMap` has the rest |
| `songs[].timeSignature` | no | the meter, as `4/4` |
| `songs[].bars` | no | the song's length in bars |
| `songs[].durationSec` | no | the song's length in seconds, through its tempo map |
| `songs[].firstBarOffsetSec` | no | seconds from the start of each file to the downbeat of bar 1 |
| `songs[].originalKey` | no | the key the set gave the song |
| `songs[].notes` | no | free text about the song, from the info text of its group track in Live; line breaks kept, worth showing as typed |
| `songs[].tempoMap` | no | `{bar, bpm}` list, 1-based bars; the full map, first entry included |
| `songs[].markers` | no | `{bar, name}` list of sections |
| `songs[].chords` | no | `{bar, text}` list, one chord per bar it changes on |
| `songs[].lanes` | no | the set's `+LYRICS` tracks kept apart: `{id, name, kind: "lyrics" \| "chords", items: [{bar, text}]}` |
| `songs[].audioKey` | no | the Studio's own note of what the song's audio was made from, so its next prepare can skip a song whose audio has not changed. Opaque text; ignore it |
| `songs[].parts` | no | one entry per part written. An audio part is `{label, name, reference?}`: `label` is exactly what stands in the file's square brackets, and is how a file is matched to an entry; `name` is what to put on the fader; `reference` true means the record's own part, to be said beside the name; `role` is `stem` (a fader, the default when absent) or `mix` (a whole song, switched to on its own); `record` true marks the record itself — always a `mix` and a `reference` — which the player must never put under a fader. An audio part may also say what it was made from: `file` (its name in the folder), `sources` (the Live tracks it was rendered from; several for a combined part), `frozen` (rendered from Live's own freeze, devices included), `shifted: {semitones, speed}` (transposed or stretched from its file in the render), `covers: {fromBar, toBar}` (the bars of the song it has audio in, 1-based, inclusive), `gainDb` (the fader level it was rendered at; absent at unity), `sizeBytes`, `bitrate`, `sampleRate`. Facts to show, not to act on. A sampler part adds `kind: "sampler"`, `id`, `role`, `rev`, `order`, `samples: [{note, path, rev, sizeBytes, gain?}]` and `notes: [{bar, note, velocity?}]` — `bar` 1-based and fractional through the tempo map **with `firstBarOffsetSec` added, like everything else**; `note` a MIDI number; `velocity` the raw MIDI velocity over 127, which the player squares; `gain` a per-sample level the website ignores |
| `songs[].patchClips` | no | rig patch changes, `{id, bar, patch: {channel, program?, bank?, controls?, source?}, lengthBars?, endPatch?, member?, name?}`. `bar` is 1-based and may be fractional; `program` and `bank` are the bytes sent (bank = MSB × 128 + LSB), `controls` a list of `{cc, value}`. `member` is whose rig it is, from a track named `RIG <member> (<rig>)` in the set; `name` the clip's name. Send a change a quarter-second before its bar: bank, then program, then the CCs, on `channel` |

Rules the reader follows, and a writer can rely on:

- **Unknown fields are ignored**, so a later Studio may add some. Known fields
  are checked strictly for type, and a manifest that fails applies nothing;
  the errors are shown rather than swallowed, since a `set.json` can be
  written by hand.
- **Matching is by folder name**, case-insensitive, and the manifest names
  the folder each song is in now. A song in the folder that the manifest does
  not mention is left exactly as scanned. Across prepares, a song is the same
  song by the title part of its folder name — the Studio's own matching goes
  by that, so a song rendered on a new day replaces its older entry rather
  than joining it.
- **A manifest's values replace the song's where the manifest has them.**
  Where it has none, what the library already held stays: a manifest with no
  `patchClips` does not wipe patch changes programmed in the app.
- Markers keep the ids they already had when the bar and name match, so the
  library file does not churn on every scan.
- **Partial runs merge.** Preparing one song reads the manifest already in
  the folder, replaces that song's entry, keeps every other, and writes the
  whole back in set order. Songs no longer in the set keep their entry at the
  end rather than being dropped, because their files are still there.

## `song.json`

One per song folder, written with the parts and rewritten whenever the
song's words or sections are refreshed. It is the song's own `set.json`
entry with three fields in front — so a reader that has the folder knows
everything about the song without the set's manifest, and the stems' facts
are sure to be there:

```json
{
  "preparedBy": "rehearsaltool",
  "set": "YBWM Set 2026.09.06",
  "fromSet": "/YBWM Set 2026.09.06.als",
  "folder": "Cruel Summer (2026-09-06)",
  "title": "Cruel Summer",
  "renderedAt": "2026-09-06T08:31:12.000Z",
  "tempo": 85,
  "timeSignature": "4/4",
  "bars": 96,
  "durationSec": 271.06,
  "originalKey": "G",
  "notes": "Piano intro. Watch the drummer for the stop.",
  "firstBarOffsetSec": 0.0261,
  "tempoMap": [], "markers": [], "chords": [], "lanes": [], "patchClips": [],
  "parts": [
    { "label": "bass", "name": "bass", "file": "Cruel Summer [bass].mp3", "sources": ["Bass"],
      "covers": { "fromBar": 9, "toBar": 96 }, "sizeBytes": 4351020, "bitrate": 128, "sampleRate": 48000 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `preparedBy` | exactly `"rehearsaltool"`, as in `set.json` |
| `set` | the set folder's name, the one under `Sets/` this song belongs to |
| `fromSet` | the `.als` the set came from, as in `set.json` |
| everything else | the song's `set.json` entry, field for field, as documented above |

Where `song.json` and `set.json` disagree, `set.json` is the set's word on
order and membership and `song.json` the song's word on itself; they are
written together and should not disagree.

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


It also carries **`setlists`: one per prepared set, in running order.** The
manifest's `songs[]` order — AbleSet's where the project keeps one — is
what the band plays in, and a library of songs alone would lose it; so each
set under `Sets/` is a setlist too, `{id, name, songIds, notes, updatedAt}`:
`id` is `set:` and the set folder's path lowercased, `name` the set folder's
name, `songIds` the library ids of its songs in the order to play them,
`updatedAt` the prepare's time. Rebuilt on every publish; a setlist whose id
does not start with `set:` is somebody's own and is left as it was.

## What the website is expected to do

1. Find every folder called `Sets`, at whatever depth, and scan each folder
   directly inside it as a set: an ordinary library folder. Group files by
   base name once every tag is stripped; `[square]` files are stems, `(round)`
   files are versions, `{curly}` values are tempo, key and time signature.
2. Treat what is under a folder called `Prints` — or, for an older band,
   under `Rehearsal Tool/` but not under `Sets/` — as a print, and attach it
   to the song whose title it carries. Never read `Resources/`.
3. Apply every `set.json` found under a `Sets` folder by the rules above.
4. Offset all bar maths by the song's `firstBarOffsetSec`.
5. Play a `kind: "sampler"` part by striking its samples: at each note's
   `bar` — through the tempo map, with `firstBarOffsetSec` added as for every
   other part — start the sample for that `note` and let it ring, at
   `velocity` squared. The part labelled `click` is the click track. A note
   whose number has no sample is skipped and said so. Neither the click nor
   the cues is ever transposed with the song. A `[click]` or `[cues]` file
   from an older set is the same thing rendered; treat it as before.
6. Label a part by its `parts` entry where the manifest has one — the name
   without the reference marker, with "reference" said beside it — and fall
   back to the bracketed label when it does not. A set prepared before `parts`
   existed carries none, and `[ref …]` in the label is then the only clue;
   read it the same way. A part with `record: true` is the record itself:
   give it no fader, and play it on its own in place of the band's parts when
   asked — the way SWITCH does. Treat any other `role: "mix"` as a whole
   version to switch to, not to blend. A set prepared before `record` existed
   says nothing, and a `[ref song]`, `[ref master]` or `[reference]` label with
   no instrument word left in it is then the record.
7. Play the parts of a song together; they are the same length and start at
   the same instant.
8. Take a song's title from `title`, else from the folder name with its
   trailing ` (YYYY-MM-DD)` — or, for an older set, its curly block —
   removed. Take its tempo and meter from `tempo` and `timeSignature` when
   present, else from the curly block of an older folder name.
9. Key anything you keep per song — a member's rig file, a saved mix, a
   note — by set + song name (the title part), never by folder name: a song
   rendered again on a later day is in a new folder. Ignore any folder
   whose name starts with a dot; `.undo` is the Studio's kept-aside copy of
   folders it wrote over, there to be put back, not to be played.
10. Read `song.json` inside a song folder for that song alone, when the set's
   manifest is not to hand or the stems' facts are wanted.
11. **Show a set's songs in its running order, never alphabetically**: the
   library's `set:` setlist for it, or `set.json`'s `songs[]`, which agree.
   The alphabet is for a search box.

## Rigs: patch changes from the band

A member drives their own rig from their own laptop, over USB MIDI, from the
website. The set's own changes reach them through `patchClips` above. A
member can set their own, and the website writes them into the band's
folder, one file per member per prepared set:

    <band>/Sets/<set>/rigs/<member>.json

```json
{
  "member": "Alex",
  "rig": "Neural DSP Quad Cortex",
  "updatedAt": "2026-09-05T23:40:00Z",
  "songs": {
    "22": [
      { "bar": 1,  "name": "Scene A", "patch": { "channel": 1, "program": 3, "bank": 2, "controls": [{ "cc": 43, "value": 0 }] } },
      { "bar": 33, "name": "Scene C", "patch": { "channel": 1, "controls": [{ "cc": 43, "value": 2 }] } }
    ]
  }
}
```

- Keyed by song name — the title part of the folder name, without its
  render date (an older folder name with its curly block is read the same
  way). `bar` counts from the song's own first bar. The patch is the same
  shape as in `patchClips`.
- The website should send a member their own file's changes for their rig,
  and the set's `patchClips` only where their file says nothing for a song —
  otherwise the leader's Cortex scene fires on the guitarist's Helix. A
  `member` on a set change says whose it is; one with none is the set's.
- The Studio reads these files and writes them into a copy of the set as
  MIDI clips, one `ADD THIS RIG <member> (<rig>)` track each. The leader
  drags those tracks into the real set. The next prepare reads them back as
  the set's own, with `member` set from the track's name, and the loop is
  closed. A change that has come back this way needs no file any more; the
  website may keep the file for editing, and the Studio takes the file as
  the newer word whenever both exist.
- Channels are the member's own: their laptop talks to their rig alone.

Everything above is what the code in `src/lib/prepare.ts`, `src/lib/prints.ts`
and `src/lib/preparedSet.ts` does. When they disagree with this file, the
code is right and this file is behind.
