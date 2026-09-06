# Website prompt: dated song folders and `song.json`

Paste this to whoever, or whatever, builds the band's website. The full
contract is `docs/prepared-sets.md`; this is the change.

---

Rehearsal Tool Studio has changed how it lays out a prepared set in the
band's Dropbox folder. Please update the website's reading of
`Sets/<set>/` to match. Everything below is documented in the Studio's
`docs/prepared-sets.md`, which is the contract.

1. **Song folders are now named `<Title> (<YYYY-MM-DD>)`** — the title and
   the day that song's audio was last rendered — for example
   `Cruel Summer (2026-09-06)`. They used to be
   `<Title> {<tempo>, <key>, <num>-<den>}`. Both kinds can sit in one set.
   - Take the title from the manifest entry's `title` when present; else
     strip a trailing ` (YYYY-MM-DD)`, or the older ` {…}` block, from the
     folder name.
   - Take tempo and meter from the entry's new `tempo` (number, bpm at the
     song's start) and `timeSignature` (`"4/4"`), falling back to the curly
     block only for an older folder that has one. `tempoMap`, `originalKey`
     and the rest are unchanged.
2. **A song's identity is its name, not its folder.** A song whose audio is
   rendered again on a later day moves to a new folder; its old folder
   leaves the set. Key anything you keep per song — a member's rig file
   under `Sets/<set>/rigs/<member>.json`, saved mixes, notes — by set + song
   name (the title part). Rig files are now keyed by song name, e.g.
   `"22"` rather than `"22 {104, F, 4-4}"`; accept either when reading old
   ones.
3. **Ignore dot-folders.** The Studio keeps the folders it writes over in
   `Sets/<set>/.undo/` so a prepare can be undone. Never list or play from
   a folder whose name starts with a dot.
4. **Each song folder now contains `song.json`**: the song's own manifest
   entry with `preparedBy: "rehearsaltool"`, `set` (the set folder's name)
   and `fromSet` in front. Use it when you have a song folder but not the
   set's `set.json`, or when you want the stems' facts.
5. **Manifest entries carry more**: `renderedAt` (ISO), `tempo`,
   `timeSignature`, `bars`, `durationSec`; and each audio part in `parts`
   may carry `file`, `sources` (the Live tracks it was rendered from),
   `frozen`, `shifted: {semitones, speed}`, `covers: {fromBar, toBar}`,
   `gainDb`, `sizeBytes`, `bitrate`, `sampleRate`. These are facts to show
   (a stem inspector, a "rendered 6 Sep" badge), not to act on; the
   existing `label`/`name`/`role`/`reference`/`record` rules still decide
   playback.
6. Nothing else changes: part files are still `<Title> [<label>].mp3`,
   `.lrc` and `.cho` sit beside them, `set.json` still lists songs in
   running order and is still matched to folders by `folder`, and
   `firstBarOffsetSec` still applies to every bar calculation.
7. **Show a set's songs in its running order, never alphabetically.** The
   band's library file (`.rehearsal-tool.json`) now carries `setlists`: one
   per prepared set, `id` = `set:` + the set folder path lowercased, `name`
   = the set folder's name, `songIds` in the order to play. It agrees with
   `set.json`'s `songs[]` order, which is AbleSet's order when the project
   keeps a setlist. Use either; sort alphabetically only in a search box.
   Setlists whose id does not start with `set:` are the website's own.
