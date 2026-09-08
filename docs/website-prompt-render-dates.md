# Website prompt: when the stems and the submixes were made

Paste this to whoever, or whatever, builds the band's website. The full
contract is `docs/prepared-sets.md`; this is the change.

---

Rehearsal Tool Studio now records **when each song's audio was made**, and
records the stems and the submixes separately, because they are made
separately. Please show it. Everything below is in the Studio's
`docs/prepared-sets.md`, which is the contract.

## What is new

Three fields, all optional, all ISO 8601 strings in UTC
(`"2026-09-08T15:44:09.484Z"`):

| where | field | what it says |
| --- | --- | --- |
| `set.json` → `songs[]` | `renderedAt` | when this song's **stems** were last rendered. It already existed; what is new is that it never moves for a submix. |
| `set.json` → `songs[]` | `submixesAt` | when this song's **submixes** were last written. Absent when the song has none. |
| `set.json` → `songs[].parts[]` | `renderedAt` | when that one **file** was written. |

The same three appear in each song folder's own `song.json`, which carries
the same entry.

```json
{
  "folder": "Cruel Summer (2026-09-06)",
  "title": "Cruel Summer",
  "renderedAt": "2026-09-06T08:31:12.000Z",
  "submixesAt": "2026-09-08T15:44:09.484Z",
  "parts": [
    { "label": "bass", "name": "bass", "file": "Cruel Summer [bass].mp3",
      "renderedAt": "2026-09-06T08:31:12.000Z" },
    { "label": "alex gtr vox", "name": "alex gtr vox", "hidden": true,
      "file": "submixes/Cruel Summer [alex gtr vox].mp3",
      "submixFor": ["Alex"], "submixOf": ["gtr", "lead vox"],
      "renderedAt": "2026-09-08T15:44:09.484Z" }
  ]
}
```

## Why two dates and not one

Preparing the stems and preparing the submixes are separate jobs in the
Studio, and either can happen without the other:

- A member is added, or changes what they keep, and every song wants a
  submix it hasn't got — written on their own, with every stem beside them
  untouched and still right.
- An arrangement changes and a song's stems are rendered again — which
  writes the song's folder afresh, submixes and all.

So a song can honestly hold **stems from Tuesday and submixes from
Friday**, and that is worth showing rather than hiding behind one date.

## What to do with them

1. Show the stems' date where you say what a song is — a "rendered 6 Sep"
   line under the title, a column in a set list, a tooltip. Prefer a short
   local date; the value is UTC, so convert.
2. Where a song has submixes, show `submixesAt` beside them rather than
   instead of `renderedAt` — for example "stems 6 Sep · submixes 8 Sep".
   When the two fall on the same day, one date reads better than two.
3. In a per-part view (a stem inspector, a mixer's info panel), show the
   part's own `renderedAt`. It is the truthful answer for that file, where
   the song's two dates are the summary.
4. **Absent means say nothing.** A set prepared before this carries none of
   the three, a song with no submixes has no `submixesAt`, and a part
   written by an older build has no `renderedAt`. Never show "unknown", a
   dash, or the epoch — leave the line out.
5. **Never sort or decide by them.** These are for a person to read. They
   do not say what is stale, they are not a cache key, and they must not
   gate playback or drive a "needs updating" badge: whether a set is behind
   is the Studio's question, against the Ableton set the website cannot
   see. The set the band is given is always the whole answer.
6. Do not confuse them with `preparedAt` at the top of `set.json`, which is
   when the manifest was last written — a run over the words alone moves
   `preparedAt` and neither of the others.

## What has not changed

Nothing about playback. The parts, their labels, `role`, `reference`,
`record`, `hidden`, `submixFor` / `submixOf`, the folder layout, the
running order — all exactly as they were. This is three fields to read and
show, and a set that lacks them behaves as it did before.
