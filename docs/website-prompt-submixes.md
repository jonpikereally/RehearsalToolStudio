# Prompt for the Rehearsal Tool website: submixes are being written now

*Paste this into a session on the website repo. It describes what the Studio
now writes into the band's folder. The parts marked **contract** are the shape
on disk; changing them means changing `docs/prepared-sets.md` in the Studio
repo too.*

---

The Studio now renders **submixes**: one part per song holding everything a
band member does not keep on a fader of their own, summed on a laptop from the
multitrack at the same 192 kbps as the stems. A guitarist who keeps only their
guitar separate loads two files for a song instead of eight — a quarter of the
download and a quarter of the decoding.

The files are already in the band's folder. Nothing on the site has to change
for it to keep working: every submix is declared `hidden`, and the site already
drops hidden parts before anything sees them. What follows is how to start
using them.

## What is on disk

Inside each song folder, a `submixes/` folder:

```
Sets/YBWM Set 2026.09.06/
  Opalite (2026-09-07)/
    Opalite [bass].mp3
    Opalite [ref vox].mp3
    …
    submixes/
      Opalite [submix bass+drums+other+piano].mp3
```

**contract**

- A submix is a part like any other: same lead-in, 192 kbps MP3, the source's
  rate, the source's channel count up to stereo. It starts at the same instant
  as every other part of the song, sample for sample.
- It is **named for what is in it**, not for whose it is, with its parts in
  alphabetical order. One list of parts is one file, however many people want
  it: two members who keep the same things share it. A list too long for a
  name is cut short with four letters of its own hash on the end, so two lists
  can never come out alike. Match a submix by `submixOf` and never by its
  name — see `docs/website-prompt-submix-names.md`, and note that a set
  prepared before the order was fixed carries its parts in the arrangement's
  order and plays exactly as it did.
- A `submixes/` folder holds parts of the song above it. **It is not a song.**
  Anything that walks the band's folder has to read it as belonging to its
  parent, or a nineteen-song set reads as thirty-eight, half of them called
  "submixes". (This is exactly what the Studio's own scan got wrong first.)

## How it is declared

**contract** — in `set.json` and in each song's `song.json`, as an ordinary
part entry with three fields more:

```json
{
  "label": "submix bass+drums+other+piano",
  "name": "submix bass+drums+other+piano",
  "file": "submixes/Opalite [submix bass+drums+other+piano].mp3",
  "role": "stem",
  "hidden": true,
  "submixFor": ["Alex", "Robin"],
  "submixOf": ["drums", "bass", "other", "piano"],
  "sizeBytes": 5725440,
  "bitrate": 192,
  "sampleRate": 48000
}
```

- **`file`** is the path from the song's folder, so it carries `submixes/`.
  Every other part's `file` is a bare name — read it as a path, not a name.
- **`hidden: true`** is on every submix. A player that does nothing about
  submixes must go on dropping them, or it plays a submix on top of the very
  parts inside it.
- **`submixOf`** is the parts it stands for, by their own `name` fields —
  `"drums"`, not `"Opalite [drums].mp3"`.
- **`submixFor`** is a **list** of member names, matched the way a rig file's
  `member` is: trimmed, case ignored. Sets prepared before this carry a single
  string rather than a list — accept both.

The same three fields are on the variant in `.rehearsal-tool.json`, beside its
`path`, so a player reading the library needs no manifest of its own.

## What the site should do with it

For the member signed in:

- Find the part whose `submixFor` names them. Load it, plus every part **not**
  named in its `submixOf`, and nothing else.
- Its `submixOf` names parts by `name`, so match on the same field the mixer
  labels faders with.
- No submix for them, no `submixFor` at all, or a song that has none: load
  every part exactly as today.

A submix is a fader like any other once loaded — it just stands for several.
Whether it is labelled "the band" or "everything else" is yours; the name in
the file is for the folder, not for the screen.

## Two things to check on your side

1. **The device-render cache.** The Studio's prompt for this feature said not
   to write into `Submixes/` because that name was the site's own cache of
   device renders, keyed by a digest. The Studio was later asked to use
   `submixes/` inside each song folder anyway, and does. Dropbox and macOS are
   case-insensitive, so if that cache still lives under that name in the same
   place, the two now share a folder under two naming schemes — and anything
   that prunes the cache by digest would take the band's submixes with it.
   Move the cache, or key it somewhere else, or say so and the Studio will
   rename its folder.
2. **Rendering submixes on the device is now redundant** where the Studio has
   written one, and worse: a device render is a lossy copy of already lossy
   stems, where the Studio's is one encode from the multitrack. Prefer the
   file when one is there.

## Who decides what is in them

The band and what each of them keeps separate is `members.json` at the root of
the band's folder, written by the Studio's "The band" tab:

```json
{
  "writtenBy": "rehearsaltool",
  "writtenAt": "2026-09-07T17:29:47.059Z",
  "members": [
    { "member": "Alex", "keeps": ["guitar", "ref gtr"], "contains": ["vox"] }
  ]
}
```

`keeps` names parts outright; `contains` keeps any part whose name holds that
word, which is how one line covers `vox`, `ref vox` and `bgvs vox` in this set
and the next one.

**contract** — the site may write it, and is meant to: this is where band
settings stay in step between the two. The Studio never writes it blind — it
reads what is on disk at the moment of saving and merges by member name, so a
member the site added is kept, a member it changed that the Studio was not
editing keeps that change, and only what was edited in the Studio wins over
what it was edited from. Keys the Studio does not know are carried through
untouched. Write it the same way: read, merge by `member`, keep what you do
not understand, and leave `writtenBy` and `writtenAt` saying who wrote last.

The Studio rewrites the submixes on the next prepare, and its band page reads
the file again whenever it is looked at, so a change made on the site shows up
without anything being restarted.

Three things are never in a submix, whoever it is for: the record (`ref song`)
or any whole mix, the click, and the cues. A submix that would stand for fewer
than two parts is not written at all.
