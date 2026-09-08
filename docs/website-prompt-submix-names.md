# Website prompt: how a submix is named

Paste this to whoever, or whatever, builds the band's website. The full
contract is `docs/prepared-sets.md`; the submix feature itself is
`docs/website-prompt-submixes.md`. This is the naming, which has changed.

---

Rehearsal Tool Studio names a submix for **what is in it**, and as of this
build the parts are always in **alphabetical order**. Here is the whole rule,
and what the website should and should not do with it.

## The name

A submix's part is labelled

    submix <part>+<part>+<part>

and its file, inside the song's `submixes/` folder, is

    Sets/<set>/<Song> (<date>)/submixes/<Song> [submix bass+drums+keys+vox].mp3

- **The parts are the parts it stands for**, by the same `name` the mixer
  shows for them — `bass`, `drums`, `lead vox` — lowercased, joined with `+`.
- **Alphabetical, always.** It used to follow the order the tracks sat in the
  arrangement, which made `[submix bass+drums]` in one song and
  `[submix drums+bass]` in the next: two names for one thing. Sorted, the same
  combination is the same name everywhere.
- **Never the member's name.** One list of parts is one file however many
  people want it — two members who keep the same things share it — so naming
  it "Alex" would make a file the others have to be told about. Who it is for
  is a field (`submixFor`), not part of the name.
- **A long list is cut short.** Past 52 characters the name keeps as many
  parts as fit and ends with `+<four characters>` — four letters of a hash of
  the full list, so two different long lists can never come out alike:

      submix bass+drums+gtr+keys+organ+percussion+piano+9x2f

  Those four characters are not a part. Don't parse them, don't show them.

## What the name is *not*

**It is not the identity.** Match a submix by `submixOf` — the list of parts
it stands for — never by its label or file name:

```json
{
  "label": "submix bass+drums+keys+vox",
  "name": "submix bass+drums+keys+vox",
  "file": "submixes/Cruel Summer [submix bass+drums+keys+vox].mp3",
  "role": "stem",
  "hidden": true,
  "submixFor": ["Alex", "Casey"],
  "submixOf": ["bass", "drums", "keys", "vox"],
  "renderedAt": "2026-09-08T15:44:09.484Z"
}
```

- `submixOf` is now sorted the same way as the name. Compare two lists **as
  sets, case-insensitively** — order and case must not decide whether two
  submixes are the same, because a set prepared before this build has them in
  arrangement order and its files still play perfectly.
- A set can hold submixes named both ways at once: a song rendered last week
  keeps its old name until it is next written. Both are valid; neither needs
  fixing, and the website must not rename anything on disk.
- `submixFor` is a list of member names, matched trimmed and case-insensitively
  (a set prepared long ago may carry a single string — accept both).

## What to show

- Name a submix by what it stands for, from `submixOf` — "bass, drums, keys,
  vox", or "everything but the guitar" if you can work that out from the
  member's list. The raw label is a file name, not a caption.
- Where you do show the label, show it as it is. Don't re-sort it, don't strip
  the `submix ` prefix into something else, and don't reconstruct it from
  `submixOf` — a long list's name is deliberately not the whole list.
- Nothing about the name says how fresh it is. `renderedAt` on the part, and
  `submixesAt` on the song, are the dates — see
  `docs/website-prompt-render-dates.md`.

## What has not changed

Everything else about submixes: they are `hidden`, they are `role: "stem"`,
they live in the song's `submixes/` folder, they never contain the click, the
cues, the record or any whole mix, and a player that doesn't understand them
drops them. If the site already loads a member's submix plus every part not in
its `submixOf`, that code needs no change at all — it matches on `submixOf`,
and only the spelling of a name has moved.
