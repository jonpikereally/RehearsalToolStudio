# Prompt for the Rehearsal Tool website: the band, and what each member keeps

*Paste this into a session on the website repo. It describes `members.json`,
which both apps write. The parts marked **contract** are the shape on disk;
changing them means changing `docs/prepared-sets.md` in the Studio repo too.*

---

The band's folder now holds a file saying who is in the band and what each of
them wants on a fader of their own. The Studio writes it from its "The band"
tab; the website should be able to write it too, so a member can set their own
without asking anybody to open a laptop.

## Where it is, and what it says

**contract** — `members.json` at the **root of the band's folder**, beside
`Sets/` and `Resources/`. Not inside a set: the band outlives the sets they
play.

```json
{
  "writtenBy": "rehearsaltool",
  "writtenAt": "2026-09-07T17:29:47.059Z",
  "members": [
    { "member": "Alex", "keeps": ["guitar", "ref gtr"], "contains": ["vox"] },
    { "member": "Robin", "keeps": ["bgvs"], "off": true }
  ]
}
```

- **`member`** — their name, spelled as their rig file spells it: that is how
  the two are matched, trimmed and case-ignored. Write it the same way for the
  same person or the two files will disagree about who somebody is.
- **`keeps`** — parts they keep on their own faders, by the same `name` the
  parts carry in `set.json` (`"drums"`, not `"Cruel Summer [drums].mp3"`).
- **`contains`** — parts kept by a word in their name. A set spells one
  instrument several ways — `gtr`, `guitar`, `guitar pop`, `ref gtr` — and one
  word covers them all, in this set and in the next one. Case-ignored
  substring, nothing cleverer.
- **`off`** — in the band, but no submix written for them.
- Anything else in the file is left alone by the Studio. Add what you need.

Three things are never in a submix and so are never worth listing: the record
or any whole mix, the click, and the cues. The Studio drops them from a list
that names them, and does not offer them as things to keep.

## What it is for

Everything a member does not keep is summed into one part per song — their
submix — written beside the stems by the Studio. Their phone loads that one
file in place of the parts inside it. See
`docs/website-prompt-submixes.md` for how a submix is declared and what the
player does with it; this file is only where the shape of one is decided.

Changing the file changes nothing on its own: the Studio writes the submixes
on its next prepare, and says in its own window which songs are behind until
it does. A site that writes this file should say the same — the band's folder
is not up to date the moment somebody ticks a box.

## Two writers, one file

**contract** — neither app may write it blind.

The Studio reads what is on disk at the moment of saving and merges by member
name:

- a member added elsewhere is kept;
- a member changed elsewhere, that the Studio was not editing, keeps that
  change;
- only what was edited in the Studio wins over what it was edited from;
- a member removed in the Studio is removed;
- keys the Studio does not understand are carried through untouched.

Write it the same way: read the file, merge by `member`, keep what you do not
understand, and leave `writtenBy` and `writtenAt` saying who wrote last. Do
not hold a copy in a database and write it back wholesale — the file is the
truth, and the Studio is writing to it from another machine while you have the
page open.

## What the site could offer

- A page per member: their name, the parts of the current set as ticks, and a
  field for words to keep by. The parts to offer come from `set.json` — the
  `name` of every part that is not hidden, not `role: "mix"`, not the record,
  and not the click or the cues.
- Their own submix is the parts they have not kept. Naming it is not
  necessary: the Studio names the file for its contents.
- After a save, say what it means — "your submix will change when the set is
  next prepared" — rather than implying the audio has already moved.
