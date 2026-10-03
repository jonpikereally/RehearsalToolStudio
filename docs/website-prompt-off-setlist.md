# Website prompt: songs taken off the setlist

Paste this to whoever, or whatever, builds the band's website. The full
contract is `docs/prepared-sets.md`.

---

The band's setlist is AbleSet's. Rehearsal Tool Studio now treats a song
that is in the Ableton set but **not on AbleSet's setlist** as not in the
show. It is never rendered or updated again — but its folder in the band's
Dropbox is **not deleted**: the files stay, and so does its entry in the
set's `set.json`, marked.

## What is on disk

In `Sets/<set>/set.json`, each entry of `songs[]` that is off the setlist
carries one more field, and the entries that have it come after every song
that is on it:

```json
{ "folder": "Sparks Fly (2026-10-02)", "title": "Sparks Fly", "offSetlist": true, … }
```

**contract**

- `offSetlist: true` means: **this song is not in the set.** Leave it out of
  the set's running order, its song count and its total length, and don't
  offer it as part of the set.
- Absent means in the set. The field is never written as `false`.
- Everything else about the entry — tempo map, sections, parts — is as it
  was, because the files are still there. Nothing about the song is wrong;
  it is just not being played.
- A song put back on AbleSet's setlist loses the mark on the Studio's next
  update, and takes its place in the order again.
- The set's `set:` setlist in `library.json` already leaves such songs out
  of its `songIds`. If the site follows that setlist for the running order,
  it is already right; if it walks `set.json`'s `songs[]`, it has to drop
  the entries marked `offSetlist`.

## What to change

1. Wherever the site lists a set's songs from `set.json`, skip entries with
   `offSetlist: true`.
2. Don't treat a marked song as missing, broken or deleted, and don't remove
   anything of the user's (a saved mix, a rig file) keyed to it — it may come
   back.
3. Nothing else changes. A set with no marked songs reads exactly as before.
