/**
 * Self-test for the pure logic: bar maths, file grouping, and the pitch shifter.
 *
 * Run with `npm test`. Node 24 strips the TypeScript types natively, so these
 * import the real source files rather than a copy.
 */
import { readFileSync } from 'node:fs';
import { barToSec, secToBar, nudgeBars, secPerBar, formatBarBeat, totalBars } from '../src/lib/bars.ts';
import { splitVariant, mergeScan, isAudio, parseNameMeta, defaultRole, parseFileName, isUnpitched, locateSong,
         isProjectScaffolding, setOwnedFolders, isUnderAnyFolder, newestSetPerFolder } from '../src/lib/scan.ts';
import { emptyLibrary } from '../src/types.ts';

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const group = (title) => console.log(`\n── ${title} ──`);

/* ------------------------------- bar maths ------------------------------- */

group('bar maths');
{
  const song = { bpm: 120, timeSigNum: 4, timeSigDen: 4, firstBarOffsetSec: 0 };
  check('4/4 at 120bpm → 2s per bar', near(secPerBar(song), 2));
  check('bar 1 is at 0s', near(barToSec(1, song), 0));
  check('bar 9 is at 16s', near(barToSec(9, song), 16));
  check('16s is bar 9', near(secToBar(16, song), 9));
  check('round trip', near(secToBar(barToSec(33, song), song), 33));

  const song68 = { bpm: 120, timeSigNum: 6, timeSigDen: 8, firstBarOffsetSec: 0 };
  check('6/8 bar = 3 quarter notes = 1.5s', near(secPerBar(song68), 1.5));

  const offset = { bpm: 100, timeSigNum: 4, timeSigDen: 4, firstBarOffsetSec: 1.3 };
  check('offset shifts bar 1', near(barToSec(1, offset), 1.3));
  check('offset round trip', near(secToBar(barToSec(5, offset), offset), 5));

  // Forward jumps land on bar lines.
  check('forward 4 bars from bar 1', near(nudgeBars(0, 4, song), 8));
  check('forward 4 from mid-bar snaps to grid', near(nudgeBars(1.0, 4, song), 8));

  // Back should restart the current bar first, like a "previous track" button.
  check('back 1 from mid-bar restarts the bar', near(nudgeBars(9.0, -1, song), 8));
  check('back 1 from the top of a bar goes to the previous', near(nudgeBars(8.0, -1, song), 6));
  check('back 4 from mid-bar', near(nudgeBars(21.0, -4, song), 14));
  check('cannot go before bar 1', near(nudgeBars(1.0, -8, song), 0));

  // At 120bpm each bar is 2s and each beat 0.5s, so 9.0s is 1s into bar 5 = beat 3.
  check('bar.beat readout', formatBarBeat(9.0, song) === '5.3', formatBarBeat(9.0, song));
  check('bar.beat mid-bar', formatBarBeat(9.5, song) === '5.4', formatBarBeat(9.5, song));
  check('bar.beat on a downbeat', formatBarBeat(8.0, song) === '5.1', formatBarBeat(8.0, song));
  check('totalBars for 32s', totalBars(32, song) === 17, String(totalBars(32, song)));
}

/* ------------------------------- tempo maps ------------------------------- */

group('tempo maps');
{
  const { tempoAt, hasTempoChanges, clickBeats } = await import('../src/lib/bars.ts');

  const flat = { bpm: 120, timeSigNum: 4, timeSigDen: 4, firstBarOffsetSec: 0 };
  check('no map behaves as constant tempo', !hasTempoChanges(flat));
  check('and matches the old maths', near(barToSec(9, flat), 16));

  // Fix You: 136 to the top of bar 91, then 140.
  const fixYou = {
    bpm: 136, timeSigNum: 4, timeSigDen: 4, firstBarOffsetSec: 0,
    tempoMap: [{ bar: 91, bpm: 140 }],
  };
  const barAt136 = 4 * (60 / 136);
  const barAt140 = 4 * (60 / 140);

  check('a change is detected', hasTempoChanges(fixYou));
  check('tempo before the change', tempoAt(fixYou, 90) === 136);
  check('tempo at the change', tempoAt(fixYou, 91) === 140);
  check('tempo after the change', tempoAt(fixYou, 150) === 140);

  check('bar 1 is still zero', near(barToSec(1, fixYou), 0));
  check('bars before the change use the first tempo',
    near(barToSec(91, fixYou), 90 * barAt136), String(barToSec(91, fixYou)));
  check('bars after it accumulate on top',
    near(barToSec(101, fixYou), 90 * barAt136 + 10 * barAt140), String(barToSec(101, fixYou)));

  // The round trip is the property everything else depends on.
  for (const bar of [1, 45.5, 90, 91, 92, 150, 172]) {
    check(`round trip at bar ${bar}`, near(secToBar(barToSec(bar, fixYou), fixYou), bar, 1e-9));
  }

  // A constant-tempo reading would drift badly by the end.
  const naive = 171 * barAt136;
  check('constant tempo would be seconds out by the end',
    Math.abs(barToSec(172, fixYou) - naive) > 3,
    `${(naive - barToSec(172, fixYou)).toFixed(1)}s of drift avoided`);

  check('jumping back a bar still lands on a bar line',
    near(nudgeBars(barToSec(95.5, fixYou), -1, fixYou), barToSec(95, fixYou)));

  // The metronome must follow the change too.
  const beats = clickBeats(fixYou, barToSec(93, fixYou));
  const at91 = beats.find((b) => near(b.sec, barToSec(91, fixYou), 1e-6));
  const at92 = beats.find((b) => near(b.sec, barToSec(92, fixYou), 1e-6));
  check('downbeats are accented', at91?.accent === true);
  check('a bar after the change is the new tempo long',
    near(at92.sec - at91.sec, barAt140, 1e-9),
    `${(at92.sec - at91.sec).toFixed(4)} vs ${barAt140.toFixed(4)}`);
  check('four beats to the bar', beats.filter((b) => b.sec >= at91.sec && b.sec < at92.sec).length === 4);

  // A map that starts partway keeps the song's own tempo before it.
  const late = { bpm: 90, timeSigNum: 4, timeSigDen: 4, firstBarOffsetSec: 0, tempoMap: [{ bar: 5, bpm: 180 }] };
  check('tempo before the first point is the song tempo', tempoAt(late, 1) === 90);
  check('an offset still shifts everything',
    near(barToSec(1, { ...late, firstBarOffsetSec: 2 }), 2));
}

/* ----------------------------- file grouping ----------------------------- */

group('file grouping');
{
  check('audio detection', isAudio('a.mp3') && isAudio('A.WAV') && !isAudio('notes.txt'));

  check('splits on the last dash', splitVariant('Song One - no vocal').base === 'Song One');
  check('keeps dashes in the title', splitVariant('Song - Part 2 - vocal').base === 'Song - Part 2',
    splitVariant('Song - Part 2 - vocal').base);
  check('label captured', splitVariant('Song - Part 2 - vocal').label === 'vocal');
  check('no dash → main', splitVariant('Song One').label === 'main');
  check('hyphenated words are not split', splitVariant('Half-Light').label === 'main',
    JSON.stringify(splitVariant('Half-Light')));

  const files = [
    { path: '/Setlists/BRDGS/Song One/Song One - vocal.mp3', name: 'Song One - vocal.mp3', rev: 'r1', size: 100 },
    { path: '/Setlists/BRDGS/Song One/Song One - no vocal.mp3', name: 'Song One - no vocal.mp3', rev: 'r2', size: 100 },
    { path: '/Setlists/BRDGS/Song One/Song One - cues.mp3', name: 'Song One - cues.mp3', rev: 'r3', size: 100 },
    { path: '/Setlists/BRDGS/Song Two/Song Two - vocal.mp3', name: 'Song Two - vocal.mp3', rev: 'r4', size: 100 },
    { path: '/Setlists/BRDGS/Song One/notes.txt', name: 'notes.txt', rev: 'r5', size: 10 },
  ];
  const scan = mergeScan(emptyLibrary(), files, '/Setlists');
  check('two songs found', scan.library.songs.length === 2, `got ${scan.library.songs.length}`);

  const one = scan.library.songs.find((s) => s.title === 'Song One');
  check('three variants', one?.variants.length === 3, `got ${one?.variants.length}`);
  check('non-audio ignored', !one?.variants.some((v) => v.name.includes('notes')));
  // An unbracketed folder above the song is the artist; a project needs brackets.
  check('artist from folder level', one?.artist === 'BRDGS', String(one?.artist));
  check('no project without brackets', one?.project === 'Unfiled', one?.project);
  check('tempo starts unset', one?.tempoUnset === true);
  check('variant labels', one?.variants.map((v) => v.name).sort().join(',') === 'cues,no vocal,vocal',
    one?.variants.map((v) => v.name).join(','));

  // A flat folder holding several songs should still group correctly.
  const flat = mergeScan(emptyLibrary(), [
    { path: '/Songs/Alpha - vocal.mp3', name: 'Alpha - vocal.mp3', rev: 'a', size: 1 },
    { path: '/Songs/Alpha - inst.mp3', name: 'Alpha - inst.mp3', rev: 'b', size: 1 },
    { path: '/Songs/Beta - vocal.mp3', name: 'Beta - vocal.mp3', rev: 'c', size: 1 },
  ], '/Songs');
  check('flat layout splits into 2 songs', flat.library.songs.length === 2, `got ${flat.library.songs.length}`);
  check('flat layout titles from base name',
    flat.library.songs.map((s) => s.title).sort().join(',') === 'Alpha,Beta',
    flat.library.songs.map((s) => s.title).join(','));

  // User edits must survive a rescan; a re-export must be detected.
  const edited = structuredClone(scan.library);
  const target = edited.songs.find((s) => s.title === 'Song One');
  target.bpm = 92;
  target.tempoUnset = false;
  target.markers = [{ id: 'm1', name: 'Chorus', bar: 17 }];
  target.transpose = 2;
  target.variants[0].name = 'lead vox';

  const files2 = files.map((f) =>
    f.name === 'Song One - vocal.mp3' ? { ...f, rev: 'r1-NEW' } : f,
  );
  const rescan = mergeScan(edited, files2, '/Setlists');
  const after = rescan.library.songs.find((s) => s.title === 'Song One');
  check('tempo survives rescan', after.bpm === 92);
  check('markers survive rescan', after.markers.length === 1);
  check('transpose survives rescan', after.transpose === 2);
  check('custom variant label survives', after.variants.some((v) => v.name === 'lead vox'));
  check('re-export detected by rev', rescan.updatedVariants.length === 1, JSON.stringify(rescan.updatedVariants));

  /*
   * Scanning one source on its own. It can't see what the other holds, so
   * absence proves nothing: a song it never saw stays, and so does a part of a
   * song it only half saw.
   */
  const halfSeen = files.filter(
    (f) => f.name !== 'Song One - vocal.mp3' && !f.name.startsWith('Song Two'),
  );
  const partial = mergeScan(rescan.library, halfSeen, '/Setlists', new Set(), true);
  check(
    'a song the scan never saw stays',
    partial.library.songs.some((s) => s.title === 'Song Two'),
    partial.library.songs.map((s) => s.title).join(),
  );
  check('and nothing is called removed', partial.removedSongs.length === 0);
  const stillWhole = partial.library.songs.find((s) => s.title === 'Song One');
  check(
    'a part it could not see stays too',
    stillWhole.variants.some((v) => v.name === 'lead vox'),
    stillWhole.variants.map((v) => v.name).join(),
  );
  check('and is not called removed either', partial.removedVariants.length === 0);

  // A full scan is still entitled to say something has gone.
  const sawEverything = mergeScan(rescan.library, halfSeen, '/Setlists');
  check(
    'a full scan still drops what has gone',
    sawEverything.removedSongs.length === 1,
    sawEverything.removedSongs.join(),
  );

  // A lone file with no version suffix is still a playable song.
  const lone = mergeScan(emptyLibrary(), [
    { path: '/test/mysong.mp3', name: 'mysong.mp3', rev: 'x', size: 1 },
  ], '/test');
  check('single bare file becomes a song', lone.library.songs.length === 1);
  check('its variant is labelled main', lone.library.songs[0]?.variants[0]?.name === 'main');
  check('uppercase extensions are matched',
    mergeScan(emptyLibrary(), [{ path: '/t/A.MP3', name: 'A.MP3', rev: 'x', size: 1 }], '/t').audioSeen === 1);

  // Tempo/key tags are read and stripped from the title.
  const legacyMeta = parseNameMeta('Long Way Down [128bpm] [F#m]');
  check('reads legacy [128bpm] [F#m]',
    legacyMeta.title === 'Long Way Down' && legacyMeta.bpm === 128 && legacyMeta.key === 'F#m',
    JSON.stringify(legacyMeta));
  check('reads bare 128bpm', parseNameMeta('Kerosene 128bpm').bpm === 128);
  check('reads parenthesised tags', parseNameMeta('X (92 BPM) (Bb)').key === 'Bb');
  check('leaves an untagged title alone', parseNameMeta('Half-Light').title === 'Half-Light');
  check('does not mistake a word for a key', parseNameMeta('Song in D').key === null,
    String(parseNameMeta('Song in D').key));
  check('ignores an absurd tempo', parseNameMeta('Track [999bpm]').bpm === null);

  const tagged = mergeScan(emptyLibrary(), [
    { path: '/B/Kerosene/Kerosene [140bpm] [Am] - vocal.mp3', name: 'Kerosene [140bpm] [Am] - vocal.mp3', rev: 'r', size: 1 },
  ], '/B');
  check('tags on the file name still apply', tagged.library.songs[0]?.bpm === 140,
    String(tagged.library.songs[0]?.bpm));
  check('and the key comes with them', tagged.library.songs[0]?.originalKey === 'Am');
  check('title stays clean', tagged.library.songs[0]?.title === 'Kerosene',
    tagged.library.songs[0]?.title);

  // Stems vs complete mixes.
  for (const label of ['guitar', 'drums', 'vocals', 'bass', 'click', 'cues', 'keys', 'vox', 'bgvs', 'perc']) {
    check(`"${label}" is a stem`, defaultRole(label) === 'stem', defaultRole(label));
  }
  for (const label of ['vocal', 'no vocal', 'without drums', 'full mix', 'master', 'instrumental', 'backing', 'main']) {
    check(`"${label}" is a mix`, defaultRole(label) === 'mix', defaultRole(label));
  }
  check('"lead guitar" is a stem', defaultRole('lead guitar') === 'stem');
  check('"no guitar" is a mix, not a guitar stem', defaultRole('no guitar') === 'mix');

  const stemmed = mergeScan(emptyLibrary(), [
    'guitar', 'drums', 'vocals', 'bass', 'click', 'cues',
  ].map((s) => ({ path: `/B/Song/Song - ${s}.mp3`, name: `Song - ${s}.mp3`, rev: 'r', size: 1 })), '/B');
  const stemSong = stemmed.library.songs[0];
  check('all six parts land as stems',
    stemSong.variants.every((v) => v.role === 'stem'),
    stemSong.variants.map((v) => `${v.name}=${v.role}`).join(' '));

  // A user's hand-set role must survive a rescan.
  const overridden = structuredClone(stemmed.library);
  overridden.songs[0].variants[0].role = 'mix';
  const afterRescan = mergeScan(overridden, [
    'guitar', 'drums', 'vocals', 'bass', 'click', 'cues',
  ].map((s) => ({ path: `/B/Song/Song - ${s}.mp3`, name: `Song - ${s}.mp3`, rev: 'r', size: 1 })), '/B');
  check('a hand-set role survives rescan',
    afterRescan.library.songs[0].variants.filter((v) => v.role === 'mix').length === 1);

  // Bracketed names mark stems outright.
  const pf = (n) => parseFileName(n);
  check('[guitar] is a stem named guitar',
    pf('Long Way Down [guitar]').role === 'stem' && pf('Long Way Down [guitar]').label === 'guitar');
  check('the base name drops the bracket', pf('Long Way Down [guitar]').base === 'Long Way Down');
  check('multi-word stem names survive', pf('X [lead vox]').label === 'lead vox');
  check('a dash still means a mix',
    pf('Long Way Down - no vocal').role === 'mix' && pf('Long Way Down - no vocal').label === 'no vocal');
  check('brackets beat the word list for "vocal"', pf('X [vocal]').role === 'stem',
    pf('X [vocal]').role);
  check('tempo and key are not mistaken for a stem',
    pf('X [128bpm] [F#m]').role === 'mix' && pf('X [128bpm] [F#m]').label === 'main',
    JSON.stringify(pf('X [128bpm] [F#m]')));
  const legacyAll = pf('Long Way Down [128bpm] [F#m] [guitar]');
  check('legacy square-bracket tags all at once',
    legacyAll.base === 'Long Way Down' && legacyAll.label === 'guitar' &&
    legacyAll.role === 'stem' && legacyAll.bpm === 128 && legacyAll.key === 'F#m',
    JSON.stringify(legacyAll));

  // Click and cue parts must never be pitch shifted.
  for (const label of ['click', 'clicks', 'metronome', 'count-in', 'cue', 'cues', 'guide']) {
    check(`"${label}" is never transposed`, isUnpitched(label), label);
  }
  for (const label of ['guitar', 'drums', 'vocals', 'bass', 'full mix', 'no vocal']) {
    check(`"${label}" is transposed normally`, !isUnpitched(label), label);
  }
  check('"clicky guitar" is still transposed', !isUnpitched('clicky guitar'));

  /* ---- the {song info} [stem] (version) format ---- */

  const full = pf('Long Way Down {128, F#m, 4-4} [guitar]');
  check('{} carries tempo, key and time signature',
    full.bpm === 128 && full.key === 'F#m' && full.timeSig?.num === 4 && full.timeSig?.den === 4,
    JSON.stringify(full));
  check('and the title comes out clean', full.base === 'Long Way Down', full.base);
  check('[] still names the stem', full.role === 'stem' && full.label === 'guitar');

  const versioned = pf('Long Way Down {128, F#m} (no vocal)');
  check('() names a version', versioned.role === 'mix' && versioned.label === 'no vocal',
    JSON.stringify(versioned));

  check('[vocal] is a stem but (vocal) is a mix',
    pf('X [vocal]').role === 'stem' && pf('X (vocal)').role === 'mix');
  check('odd time signatures parse', pf('X {92.5, Bb, 6-8}').timeSig?.den === 8);
  check('fractional tempo parses', pf('X {92.5}').bpm === 92.5);
  check('song info alone leaves a plain mix',
    pf('X {128}').role === 'mix' && pf('X {128}').label === 'main');
  check('tag order does not matter',
    pf('X [guitar] {128}').bpm === 128 && pf('X [guitar] {128}').label === 'guitar');
  check('a nonsense time signature is ignored', pf('X {128, 4-5}').timeSig === null);
  check('a nonsense tempo is ignored', pf('X {999}').bpm === null);
  check('folders carry song info too',
    parseNameMeta('Long Way Down {128, F#m, 6-8}').timeSig?.num === 6);

  // Time signature must reach the song record.
  const sigScan = mergeScan(emptyLibrary(), [
    { path: '/B/Waltz {90, Am, 3-4}/Waltz [piano].mp3', name: 'Waltz [piano].mp3', rev: 'r', size: 1 },
  ], '/B');
  check('time signature lands on the song',
    sigScan.library.songs[0]?.timeSigNum === 3 && sigScan.library.songs[0]?.timeSigDen === 4,
    `${sigScan.library.songs[0]?.timeSigNum}/${sigScan.library.songs[0]?.timeSigDen}`);
  check('and so do tempo and key from the folder',
    sigScan.library.songs[0]?.bpm === 90 && sigScan.library.songs[0]?.originalKey === 'Am');
  check('an instrument that looks key-ish is still a stem', pf('X [bass]').role === 'stem');
  check('untagged names are unchanged', pf('Half-Light').base === 'Half-Light');

  // Bracketed stems and dashed mixes must land in the same song.
  const mixedNaming = mergeScan(emptyLibrary(), [
    'Long Way Down [128bpm] [F#m] - full mix',
    'Long Way Down - no vocal',
    'Long Way Down [guitar]',
    'Long Way Down [drums]',
  ].map((n) => ({ path: `/B/Long Way Down/${n}.mp3`, name: `${n}.mp3`, rev: 'r' + n, size: 1 })), '/B');
  check('brackets and dashes group as one song', mixedNaming.library.songs.length === 1,
    String(mixedNaming.library.songs.length));
  const mixedSong = mixedNaming.library.songs[0];
  check('title stays clean across both styles', mixedSong.title === 'Long Way Down', mixedSong.title);
  check('tempo read off a tagged file', mixedSong.bpm === 128);
  check('key read off a tagged file', mixedSong.originalKey === 'F#m');
  check('two mixes and two stems',
    mixedSong.variants.filter((v) => v.role === 'mix').length === 2 &&
    mixedSong.variants.filter((v) => v.role === 'stem').length === 2,
    mixedSong.variants.map((v) => `${v.name}:${v.role}`).join(' '));

  // A converted AAC beside its WAV master must not become a second stem.
  const dir = '/B/Long Way Down {128, F#m, 4-4}';
  const mk = (n, size) => ({ path: `${dir}/${n}`, name: n, rev: 'r' + n, size });
  const bothFormats = mergeScan(emptyLibrary(), [
    mk('Long Way Down (full mix).wav', 50_000_000),
    mk('Long Way Down (full mix).m4a', 5_000_000),
    mk('Long Way Down [guitar].wav', 50_000_000),
    mk('Long Way Down [guitar].m4a', 5_000_000),
    mk('Long Way Down [drums].wav', 50_000_000),
  ], '/B');
  const dedup = bothFormats.library.songs[0];
  check('duplicate formats collapse to one part each', dedup.variants.length === 3,
    String(dedup.variants.length));
  check('the compressed file wins',
    dedup.variants.filter((v) => v.path.endsWith('.m4a')).length === 2,
    dedup.variants.map((v) => v.path.split('/').pop()).join(' '));
  check('a part with only a WAV is still kept',
    dedup.variants.some((v) => v.name === 'drums' && v.path.endsWith('.wav')));
  check('deduping does not disturb the tags',
    dedup.bpm === 128 && dedup.originalKey === 'F#m' && dedup.timeSigNum === 4);

  /* ---- artist / project hierarchy ---- */

  const loc = (p) => locateSong('/Songs', p);
  check('artist comes from the folder above the song',
    loc('/Songs/Taylor Swift/All Too Well').artist === 'Taylor Swift');
  check('no project without brackets', loc('/Songs/Taylor Swift/All Too Well').project === null);
  check('a bracketed folder is a project',
    loc('/Songs/[Summer Tour]/Taylor Swift/All Too Well').project === 'Summer Tour');
  check('the artist is still found inside a project',
    loc('/Songs/[Summer Tour]/Taylor Swift/All Too Well').artist === 'Taylor Swift');
  check('a song directly under the root has neither',
    loc('/Songs/All Too Well').artist === null && loc('/Songs/All Too Well').project === null);
  check('a project with no artist level still resolves',
    loc('/Songs/[Summer Tour]/All Too Well').project === 'Summer Tour');
  check('tags are stripped from an artist folder name',
    loc('/Songs/Taylor Swift {130}/Song').artist === 'Taylor Swift');
  check('curly and round folders also mark projects',
    loc('/Songs/(Tour)/A/B').project === 'Tour' && loc('/Songs/{Tour}/A/B').project === 'Tour');

  const hier = mergeScan(emptyLibrary(), [
    '/Songs/Taylor Swift/All Too Well {130}/All Too Well (full mix).mp3',
    '/Songs/[Summer Tour]/BRDGS/Kerosene/Kerosene (full mix).mp3',
  ].map((p) => ({ path: p, name: p.split('/').pop(), rev: 'r' + p, size: 1 })), '/Songs');
  const atw = hier.library.songs.find((s) => s.title === 'All Too Well');
  const ker = hier.library.songs.find((s) => s.title === 'Kerosene');
  check('scan sets the artist', atw.artist === 'Taylor Swift', String(atw.artist));
  check('scan leaves an unprojected song unfiled', atw.project === 'Unfiled', atw.project);
  check('scan sets project and artist together',
    ker.project === 'Summer Tour' && ker.artist === 'BRDGS',
    `${ker.project} / ${ker.artist}`);

  // Moving a song re-derives it; staying put keeps a hand-typed artist.
  const renamed = structuredClone(hier.library);
  renamed.songs.find((s) => s.title === 'All Too Well').artist = 'Hand Typed';
  const stayed = mergeScan(renamed, [
    '/Songs/Taylor Swift/All Too Well {130}/All Too Well (full mix).mp3',
  ].map((p) => ({ path: p, name: p.split('/').pop(), rev: 'r' + p, size: 1 })), '/Songs');
  check('a hand-typed artist survives a rescan',
    stayed.library.songs[0].artist === 'Hand Typed', String(stayed.library.songs[0].artist));

  const moved = mergeScan(renamed, [
    '/Songs/[Tour]/Someone Else/All Too Well {130}/All Too Well (full mix).mp3',
  ].map((p) => ({ path: p, name: p.split('/').pop(), rev: 'r' + p, size: 1 })), '/Songs');
  check('moving the folder re-derives artist and project',
    moved.library.songs[0].artist === 'Someone Else' && moved.library.songs[0].project === 'Tour',
    `${moved.library.songs[0].project} / ${moved.library.songs[0].artist}`);

  // Scan stats explain an empty result.
  const noAudio = mergeScan(emptyLibrary(), [
    { path: '/test/notes.txt', name: 'notes.txt', rev: 'x', size: 1 },
    { path: '/test/song.als', name: 'song.als', rev: 'y', size: 1 },
  ], '/test');
  check('counts files it saw', noAudio.filesSeen === 2, String(noAudio.filesSeen));
  check('counts zero audio', noAudio.audioSeen === 0);
  check('samples the skipped names', noAudio.skippedSamples.includes('song.als'),
    noAudio.skippedSamples.join(','));
  check('empty folder reports zero seen', mergeScan(emptyLibrary(), [], '/test').filesSeen === 0);

  // A deleted file should drop out.
  const removed = mergeScan(edited, files.filter((f) => !f.name.includes('cues')), '/Setlists');
  const afterRemove = removed.library.songs.find((s) => s.title === 'Song One');
  check('deleted file removed', afterRemove.variants.length === 2, `got ${afterRemove.variants.length}`);
  check('removal reported', removed.removedVariants.length === 1);
}

/* ----------------------------- pitch shifting ---------------------------- */

group('pitch shifting');
{
  // The real engine, loaded the way the worker loads it: from the package's own text.
  const { loadStretch, stretchOffline } = await import('../src/lib/stretch.ts');
  const source = readFileSync(new URL('../node_modules/signalsmith-stretch/SignalsmithStretch.mjs', import.meta.url), 'utf8');
  const engine = await loadStretch(source);
  const render = (left, right, semitones, tempo = 1, channels = 2) =>
    stretchOffline(engine, { left, right, sampleRate: SR, semitones, tempo, channels });

  function goertzel(buf, freq, sr, start, len) {
    const coeff = 2 * Math.cos((2 * Math.PI * freq) / sr);
    let s1 = 0, s2 = 0;
    for (let i = start; i < start + len; i++) {
      const s0 = buf[i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }
  function dominant(buf, sr, start, len) {
    let best = 0, bestP = -1;
    for (let f = 100; f <= 2000; f++) {
      const p = goertzel(buf, f, sr, start, len);
      if (p > bestP) { bestP = p; best = f; }
    }
    return best;
  }

  const SR = 48000, N = SR * 3, F0 = 440;
  const sine = new Float32Array(N);
  for (let i = 0; i < N; i++) sine[i] = Math.sin((2 * Math.PI * F0 * i) / SR) * 0.5;

  for (const semitones of [-5, -2, 2, 7, 12]) {
    const t0 = Date.now();
    const [outLeft] = render(sine, sine, semitones);
    const ms = Date.now() - t0;
    const expected = F0 * Math.pow(2, semitones / 12);
    const got = dominant(outLeft, SR, Math.floor(N * 0.4), 16384);
    const cents = 1200 * Math.log2(got / expected);
    let peak = 0;
    for (let i = 0; i < outLeft.length; i++) peak = Math.max(peak, Math.abs(outLeft[i]));
    check(
      `${semitones > 0 ? '+' : ''}${semitones} st → ${expected.toFixed(1)} Hz`,
      Math.abs(cents) < 25 && outLeft.length === N && peak > 0.2,
      `got ${got} Hz (${cents.toFixed(1)} cents), ${outLeft.length}/${N} frames, peak ${peak.toFixed(2)}, ${ms}ms for 3s audio`,
    );
  }

  const short = new Float32Array(1000);
  const [r] = render(short, short, 3);
  check('a buffer shorter than the look-ahead still comes back its own length', r.length === 1000);

  // Duration is what keeps the bar grid valid after transposing, and every stem must agree.
  for (const semitones of [-7, -3, 4, 12]) {
    const [out] = render(sine, sine, semitones);
    check(`duration preserved exactly at ${semitones} st`, out.length === N, `${out.length}/${N}`);
  }
  for (const tempo of [0.9, 1.1, 1.25]) {
    const [out] = render(sine, sine, 0, tempo);
    check(`a stretch by ${tempo} is round(frames / tempo) long`, out.length === Math.round(N / tempo), `${out.length}`);
  }
  check('mono in, mono out', render(sine, null, 2, 1, 1).length === 1);

  // The audio must not be time-shifted, or bar navigation would drift after a
  // key change. Bursts every half second; each must land where it started.
  const bursts = new Float32Array(N);
  const onsets = [];
  for (let t = 0.5; t < 2.8; t += 0.5) {
    const at = Math.round(t * SR); onsets.push(at);
    for (let i = 0; i < 240; i++) bursts[at + i] = Math.sin(i * 0.5) * Math.exp(-i / 60);
  }
  const centroid = (buf, at, win) => {
    let num = 0, den = 0;
    for (let i = Math.max(0, at - win); i < Math.min(buf.length, at + win); i++) { const e = buf[i] * buf[i]; num += i * e; den += e; }
    return den ? num / den : NaN;
  };
  const win = Math.round(SR * 0.03);
  const inCentre = onsets.map((o) => centroid(bursts, o + 60, win));
  for (const [semitones, tempo] of [[-4, 1], [5, 1], [0, 1.1], [3, 0.9]]) {
    const [out] = render(bursts, bursts, semitones, tempo);
    const worst = Math.max(...onsets.map((o, i) => Math.abs(centroid(out, Math.round((o + 60) / tempo), win) - inCentre[i] / tempo) / SR * 1000));
    check(`onsets stay aligned at ${semitones} st, tempo ${tempo}`, worst < 2, `worst drift ${worst.toFixed(2)} ms`);
  }
}

/* --------------------------- Ableton locator names -------------------------- */

group('ableton locator names');
{
  const { parseLocatorName } = await import('../src/lib/alsParser.ts');
  const p = (s) => parseLocatorName(s);

  const fix = p('Fix You / 5:00 / Eb / 136BPM');
  check('title is separated from its metadata', fix.title === 'Fix You', fix.title);
  check('duration read', fix.durationText === '5:00');
  check('key read', fix.key === 'Eb', String(fix.key));
  check('tempo read', fix.bpm === 136);

  // The sharp in a key must not be swallowed as a #tag.
  check('C#m survives', p('Violet Hill / 3:30 / C#m / 76BPM').key === 'C#m',
    String(p('Violet Hill / 3:30 / C#m / 76BPM').key));
  check('flat keys keep their case', p('Amsterdam / 5:20 / Eb / 73BPM').key === 'Eb',
    String(p('Amsterdam / 5:20 / Eb / 73BPM').key));

  // Field order varies between songs.
  const sky = p('A Sky Full of Stars / 4:29 / 125BPM / F');
  check('tempo before key still parses', sky.bpm === 125 && sky.key === 'F',
    `${sky.bpm} ${sky.key}`);

  // AbleSet's own syntax.
  const braces = p('Adventure of a Lifetime{ 4:24 / Dm / 112BPM}');
  check('curly description is read', braces.title === 'Adventure of a Lifetime' && braces.bpm === 112,
    `${braces.title} / ${braces.bpm}`);
  check('a bare title is left alone', p('Hymn for the Weekend').title === 'Hymn for the Weekend');
  check('missing separator still parses',
    p('A Rush of Blood to the Head 5:50 / Am / 100BPM').durationText === '5:50');

  const tagged = p('Yellow #encore #closer');
  check('tags are collected', tagged.tags.join(',') === 'encore,closer', tagged.tags.join(','));
  check('and stripped from the title', tagged.title === 'Yellow', tagged.title);

  check('a title word is not mistaken for a key', p('Gravity').key === null, String(p('Gravity').key));
  check('an absurd tempo is ignored', p('X / 999BPM').bpm === null);

  /* --------------------------- AbleSet's own forms -------------------------- */

  // A duration pinned in square brackets, which is how AbleSet writes it.
  const pinned = p('Follow Night [3:20]');
  check('a bracketed duration is read', pinned.durationText === '3:20');
  check('and its brackets do not stay in the title',
    pinned.title === 'Follow Night', pinned.title);

  // A description saying outright what the key is.
  const said = p('Follow Night {Key: C, 120BPM} [3:20]');
  check('a labelled key is taken at its word', said.key === 'C', String(said.key));
  check('alongside the tempo and duration',
    said.bpm === 120 && said.durationText === '3:20');
  check('leaving a clean title', said.title === 'Follow Night', said.title);

  /*
   * AbleSet's flags say how a locator behaves, not which song it is. Left in,
   * a set standardised on them would name every looping song "… +LOOP".
   */
  for (const flag of ['+LOOP', '+LOOPFULL', '+LOOP:4', '+PAUSE', '+SKIP', '+END']) {
    check(`${flag} is not part of the name`, p(`Yellow ${flag}`).title === 'Yellow',
      p(`Yellow ${flag}`).title);
  }
  // Only AbleSet's own flags, so a plus in a real title is left alone.
  check('a plus in a title survives', p('Me + You').title === 'Me + You', p('Me + You').title);

  // A key said as part of the name — "Play in Bb" — is read, and the title
  // keeps the phrase: it is part of what the song is called.
  const played = p('All Too Well - Play in Bb');
  check('"Play in Bb" names the key', played.key === 'Bb', String(played.key));
  check('and the title keeps the phrase', played.title === 'All Too Well - Play in Bb', played.title);
  check('a minor play-in reads minor', p('X - Play in F#m').key === 'F#m', String(p('X - Play in F#m').key));
}

/* --------------------------- project scaffolding --------------------------- */

{
  const f = (path, modified = 0) => ({
    path, name: path.slice(path.lastIndexOf('/') + 1), rev: 'r', size: 1, modified,
  });

  // Backups and archives are where the stale copies live — one real project had
  // 35 sets under Backup, every one of them importing a full set of songs.
  check('scaffolding: Backup ignored', isProjectScaffolding('/Coldplay/Backup/Set.als'));
  check('scaffolding: Archive Sets ignored', isProjectScaffolding('/Coldplay/Archive Sets/Set.als'));
  check('scaffolding: Samples ignored', isProjectScaffolding('/Coldplay/Samples/kick.wav'));
  check('scaffolding: the set itself kept', !isProjectScaffolding('/Coldplay/Set.als'));

  // A set owns its whole folder, so reference mixes don't also become songs.
  const owned = setOwnedFolders([f('/Coldplay/Set.als'), f('/Coldplay/Backup/Old.als')]);
  check('setOwnedFolders: one folder', owned.length === 1, owned.length);
  check('setOwnedFolders: backup does not own', owned[0] === '/coldplay', owned[0]);
  check('isUnderAnyFolder: ref mix', isUnderAnyFolder('/Coldplay/Ref Masters/Fix You.wav', owned));
  check('isUnderAnyFolder: outside', !isUnderAnyFolder('/Other/Song.mp3', owned));
  check('isUnderAnyFolder: no false prefix match', !isUnderAnyFolder('/ColdplayLive/Song.mp3', owned));

  // Dated versions sit side by side; only the newest should be imported.
  const newest = newestSetPerFolder([
    f('/Coldplay/Set 2026.05.23.als', 1000),
    f('/Coldplay/Set 2026.06.22.als', 2000),
    f('/Coldplay/Backup/Set 2026.07.01.als', 9000),
  ]);
  check('newestSetPerFolder: one per folder', newest.length === 1, newest.length);
  check('newestSetPerFolder: newest wins', newest[0].name === 'Set 2026.06.22.als', newest[0].name);

  // With no usable timestamps, the dated name decides.
  const byName = newestSetPerFolder([f('/A/Set 2026.06.22.als'), f('/A/Set 2026.05.23.als')]);
  check('newestSetPerFolder: name breaks the tie', byName[0].name === 'Set 2026.06.22.als', byName[0].name);

  // Separate projects each keep their own set.
  check('newestSetPerFolder: separate folders', newestSetPerFolder([f('/A/S.als'), f('/B/S.als')]).length === 2);
}

/* ---------------------------- importing a set ----------------------------- */

group('ableton set import');
{
  const { songsFromProject, stemLabel, roleForTrack, setName, resolveStemPath, placementOf } =
    await import('../src/lib/alsImport.ts');

  /*
   * Where a part's file sits against the song. A clip two bars after the
   * locator plays its file from there, not from bar 1 — otherwise the intro
   * plays under the gate and is never heard.
   */
  const clip = (startBar, sourceStartSec, disabled = false) =>
    ({ path: 'x.wav', startBar, endBar: 65, sourceStartSec, disabled, fadeInSec: 0, fadeOutSec: 0, warped: false });
  check('a clip on bar 1 from the file start needs no placement', placementOf([clip(1, 0)]) === undefined);
  check('a clip placed later says which bar the file begins on',
    JSON.stringify(placementOf([clip(2.974, 0)])) === '{"bar":2.974,"sourceSec":0}');
  check('a clip entered partway says how far in',
    JSON.stringify(placementOf([clip(1, 3.5)])) === '{"bar":1,"sourceSec":3.5}');
  check('a disabled clip does not decide it', placementOf([clip(9, 0, true), clip(2, 1)])?.bar === 2);


  check('a duplicate track number is dropped', stemLabel('Lead Vox 1') === 'Lead Vox');
  check('a name without one is untouched', stemLabel('Drums') === 'Drums');

  // Inside a song group everything is a part unless it says otherwise.
  for (const l of ['Bass', 'Drums', 'Guitars', 'Music', 'Keys', 'Lead Vox', 'BGVS', 'Strings 2'])
    check(`"${l}" is a stem`, roleForTrack(l) === 'stem', roleForTrack(l));
  for (const l of ['Ref Master', 'Full Mix', 'Reference', 'REF SONG', 'Ref 1', 'REF MIX'])
    check(`"${l}" is a mix`, roleForTrack(l) === 'mix', roleForTrack(l));
  // The record's own parts, filed under REF: parts to blend in, not mixes to switch to.
  for (const l of ['REF DRUMS', 'REF VOX', 'REF LV', 'REF GTR', 'Ref Piano', 'REF BGVS 2'])
    check(`"${l}" is a stem, not a switch`, roleForTrack(l) === 'stem', roleForTrack(l));

  const alsPath = '/Sets/Coldplay Covers Live Set/Coldplay.als';
  check('the set names the artist', setName(alsPath) === 'Coldplay Covers Live Set');
  check('paths resolve against the set folder',
    resolveStemPath(alsPath, 'Song Stems/x_Bass.wav') === '/Sets/Coldplay Covers Live Set/Song Stems/x_Bass.wav');
  check('and fold away the dots Live writes for a stem outside the project',
    resolveStemPath(alsPath, '../Stems/x_Bass.wav') === '/Sets/Stems/x_Bass.wav',
    resolveStemPath(alsPath, '../Stems/x_Bass.wav'));


  const project = {
    creator: 'Live 12', tempo: 120, timeSigNum: 4, timeSigDen: 4, warnings: [],
    songs: [
      {
        title: 'Fix You', raw: 'Fix You / 5:00 / Eb / 136BPM', startBar: 1724, endBar: 1896,
        bpm: 136, key: 'Eb', durationText: '5:00', tags: [],
        sections: [{ bar: 3, text: 'INTRO' }, { bar: 11, text: 'VERSE 1' }],
        chords: [], lyrics: [], tempoChanges: [{ bar: 91, bpm: 140 }],
        stems: [
          { name: 'Ref Master', path: 'Stems/fix_ref.wav' },
          { name: 'Bass 1', path: 'Stems/fix_bass.wav' },
        ],
      },
      {
        title: 'Not Synced', raw: 'Not Synced', startBar: 2000, endBar: 2100,
        // No tempo in the locator's name; the automation has it at 85 here.
        bpm: null, startBpm: 85, key: null, durationText: null, tags: [],
        sections: [], chords: [], lyrics: [], tempoChanges: [],
        stems: [{ name: 'Bass 1', path: 'Stems/missing_bass.wav' }],
      },
    ],
  };

  const file = (p) => ({ path: p, name: p.split('/').pop(), rev: 'r', size: 10 });
  const available = [
    file('/Sets/Coldplay Covers Live Set/Stems/fix_ref.wav'),
    file('/Sets/Coldplay Covers Live Set/Stems/fix_bass.wav'),
  ];

  const res = songsFromProject(project, alsPath, available, new Map());
  check('every song in the set is imported, audio or not', res.songs.length === 2, String(res.songs.length));
  check('a song with no audio is reported', res.missing.join() === 'Not Synced', res.missing.join());
  check('and keeps its place with nothing to play', res.songs[1].title === 'Not Synced' && res.songs[1].variants.length === 0);
  check('a song the locator gives no tempo plays at the tempo in force there, not the set tempo',
    res.songs[1].bpm === 85, String(res.songs[1].bpm));
  check('its files are claimed so the folder scan skips them', res.claimedPaths.size === 2);

  const song = res.songs[0];
  check('tempo comes from the set', song.bpm === 136);
  check('and is no longer flagged unset', song.tempoUnset === false);
  check('the tempo map carries over', JSON.stringify(song.tempoMap) === '[{"bar":91,"bpm":140}]');
  check('key carries over', song.originalKey === 'Eb');
  check('sections become markers', song.markers.map((m) => m.name).join() === 'INTRO,VERSE 1');
  check('markers keep their bar', song.markers[1].bar === 11);
  check('the set names the artist', song.artist === 'Coldplay Covers Live Set');
  check('roles are assigned', song.variants.map((v) => v.role).join() === 'mix,stem');
  check('track numbers are tidied', song.variants[1].name === 'Bass');

  {
    // A set copied off another machine names stems by where they were there.
    const moved = {
      creator: 'Live 12', tempo: 120, timeSigNum: 4, timeSigDen: 4, warnings: [],
      songs: [{
        title: 'Cruel Summer', raw: 'Cruel Summer', startBar: 1, endBar: 100,
        bpm: null, key: null, durationText: null, tags: [], sections: [], chords: [], lyrics: [],
        tempoChanges: [],
        stems: [
          { name: 'Drums', path: '../../../alex/Desktop/Old Project/Stems/Cruel Summer Stems/Cruel Summer_Drums.wav' },
          { name: 'Bass', path: '../../../alex/Desktop/Old Project/Stems/Cruel Summer Stems/Cruel Summer_Bass.wav' },
          { name: 'Vox', path: '../../../alex/Desktop/Old Project/Stems/Cruel Summer Stems/Cruel Summer_Vocals.wav' },
        ],
      }],
    };
    const here = [
      file('/Stems/Cruel Summer Stems/Cruel Summer_Drums.wav'),
      file('/Stems/Cruel Summer Stems/Cruel Summer_Bass.wav'),
      // Two of these, so the name alone cannot say which — and it is skipped.
      file('/Stems/Cruel Summer Stems/Cruel Summer_Vocals.wav'),
      file('/Stems/Old Take/Cruel Summer_Vocals.wav'),
    ];
    const found = songsFromProject(moved, '/TS TEST.als', here, new Map());
    check('stems a set points elsewhere are found by name in the folder',
      found.songs.length === 1 && found.songs[0].variants.length === 3, JSON.stringify(found.missing));
    check('the same-named parent folder decides between two candidates',
      found.songs[0]?.variants.find((v) => v.name === 'Vox')?.path === '/Stems/Cruel Summer Stems/Cruel Summer_Vocals.wav');
  }

  {
    // A vocal with a phrase from another take dropped in: three clips, two files.
    const arranged = {
      creator: 'Live 12', tempo: 120, timeSigNum: 4, timeSigDen: 4, warnings: [],
      songs: [{
        title: 'Cruel Summer', raw: 'Cruel Summer', startBar: 1, endBar: 66,
        bpm: null, key: null, durationText: null, tags: [], sections: [], chords: [], lyrics: [],
        tempoChanges: [],
        stems: [{
          name: 'REF VOX', reference: true, path: 'Stems/Cruel Summer_Vocals.wav', regions: null,
          clips: [
            { path: 'Stems/Cruel Summer_Vocals.wav', startBar: 2.97, endBar: 5.25, sourceStartSec: 0, disabled: false, fadeInSec: 0, fadeOutSec: 0, warped: false },
            { path: 'Stems/august.wav', startBar: 5.25, endBar: 5.5, sourceStartSec: 0, disabled: false, fadeInSec: 0, fadeOutSec: 0, warped: false },
            { path: 'Stems/Cruel Summer_Vocals.wav', startBar: 5.5, endBar: 65.4, sourceStartSec: 10.1, disabled: false, fadeInSec: 0, fadeOutSec: 0, warped: false },
          ],
        }, {
          name: 'Bass', reference: false, path: 'Stems/Bass.wav', regions: null,
          clips: [{ path: 'Stems/Bass.wav', startBar: 2.97, endBar: 65.4, sourceStartSec: 0, disabled: false, fadeInSec: 0, fadeOutSec: 0, warped: false }],
        }],
      }],
    };
    const here = [file('/Stems/Cruel Summer_Vocals.wav'), file('/Stems/august.wav'), file('/Stems/Bass.wav')];
    const got = songsFromProject(arranged, '/Set.als', here, new Map()).songs[0];
    const vox = got.variants.find((v) => v.name === 'REF VOX');
    check('a track playing several clips carries them all, with their files',
      vox?.clips?.length === 3 && vox.clips[1].path === '/Stems/august.wav' && vox.clips[2].sourceStartSec === 10.1,
      JSON.stringify(vox?.clips));
    check('and is placed by the render, not a single offset', vox?.placement === undefined);
    check('a track playing one clip stays a file placed once',
      got.variants.find((v) => v.name === 'Bass')?.clips === undefined && got.variants.find((v) => v.name === 'Bass')?.placement?.bar === 2.97);
    check('every file an arrangement plays is claimed by the set', got.variants.length === 2);
  }

  // A re-scan must not lose what the user set by hand.
  const edited = { ...song, transpose: 3, notes: 'watch the key change', project: 'Live set' };
  const again = songsFromProject(project, alsPath, available, new Map([[song.id, edited]]));
  check('transpose survives a rescan', again.songs[0].transpose === 3);
  check('notes survive a rescan', again.songs[0].notes === 'watch the key change');
  check('project survives a rescan', again.songs[0].project === 'Live set');
  check('but timing is refreshed from the set', again.songs[0].bpm === 136);
  check('and marker ids stay stable',
    again.songs[0].markers[0].id === song.markers[0].id,
    `${again.songs[0].markers[0].id} vs ${song.markers[0].id}`);
}

/* --------------------------- lyrics and chords ---------------------------- */

group('lyrics and chords chart');
{
  const { buildChart, rowAtBar, chordAtBar, hasChart, chartLanes } = await import('../src/lib/chart.ts');
  const base = { timeSigNum: 4, timeSigDen: 4, markers: [] };

  check('a song with neither has no chart', !hasChart({ ...base }));
  check('chords alone are enough', hasChart({ ...base, chords: [{ bar: 1, text: 'C' }] }));

  // With lyrics, each line is a row and its chords sit with it.
  const sung = {
    ...base,
    markers: [{ id: 'm1', name: 'VERSE', bar: 5 }, { id: 'm2', name: 'CHORUS', bar: 13 }],
    lyrics: [{ bar: 5, text: 'first line' }, { bar: 9, text: 'second line' }, { bar: 13, text: 'third line' }],
    chords: [
      { bar: 5, text: 'Eb' }, { bar: 6, text: 'Gm' },
      { bar: 9, text: 'Cm' },
      { bar: 13, text: 'Bb' }, { bar: 99, text: 'F' },
    ],
  };
  const rows = buildChart(sung);
  check('one row per lyric line', rows.length === 3, String(rows.length));
  check('chords land on the right line', rows[0].chords.map((c) => c.text).join() === 'Eb,Gm',
    rows[0].chords.map((c) => c.text).join());
  check('a later chord goes to a later line', rows[2].chords.some((c) => c.text === 'F'));
  check('a section is labelled where it starts', rows[0].section === 'VERSE', String(rows[0].section));
  check('and again when it changes', rows[2].section === 'CHORUS', String(rows[2].section));
  check('but not repeated in between', rows[1].section === undefined, String(rows[1].section));

  // Without lyrics, chords are laid out a few bars to a row.
  const played = {
    ...base,
    chords: Array.from({ length: 12 }, (_, i) => ({ bar: i + 1, text: 'C' })),
  };
  const grid = buildChart(played);
  check('chords-only rows are bar aligned', grid[0].bar === 1 && grid[1].bar === 5,
    grid.map((r) => r.bar).join());
  check('every chord is placed',
    grid.reduce((n, r) => n + r.chords.length, 0) === 12,
    String(grid.reduce((n, r) => n + r.chords.length, 0)));
  check('rows carry no lyric text', grid.every((r) => r.lines.length === 0));

  // Following the playhead.
  check('before the chart starts, no row is active', rowAtBar(rows, 1) === -1);
  check('the first row holds until the next', rowAtBar(rows, 8.9) === 0);
  check('and hands over on the bar', rowAtBar(rows, 9) === 1);
  check('the last row runs to the end', rowAtBar(rows, 500) === 2);

  check('the sounding chord is the last one reached', chordAtBar(sung, 8) === 'Gm', String(chordAtBar(sung, 8)));
  check('nothing sounds before the first chord', chordAtBar(sung, 1) === null);

  /* ------------------------------ chart lanes ------------------------------ */

  // A song with no lanes of its own is still described as lanes.
  const implied = chartLanes(sung);
  check('lyrics and chords become lanes', implied.length === 2, implied.map((l) => l.id).join(','));

  // Hiding a lane takes its events out of the chart.
  const laned = {
    ...base,
    lanes: [
      { id: 'lyrics', name: 'Lyrics', kind: 'lyrics', items: [{ bar: 5, text: 'a line' }] },
      { id: 'chords', name: 'Chords', kind: 'chords', items: [{ bar: 5, text: 'Am' }] },
      { id: 'cues', name: 'Cues', kind: 'lyrics', items: [{ bar: 5, text: 'watch the drummer' }] },
    ],
  };
  check('lanes drive the chart', chartLanes(laned).length === 3);
  check('all lanes shown by default', buildChart(laned)[0].chords.length === 1);
  check(
    'lines at the same bar share a row',
    buildChart(laned).length === 1 && buildChart(laned)[0].lines.length === 2,
  );
  check(
    'hiding the chords drops them',
    buildChart(laned, ['chords'])[0].chords.length === 0,
  );

  // Two lyric lanes both contribute rows; hiding one leaves the other.
  const cuesOnly = buildChart(laned, ['lyrics']);
  check(
    'hiding one lyric lane keeps the other',
    cuesOnly.length === 1 && cuesOnly[0].lines.join() === 'watch the drummer',
  );

  // Hiding everything is a deliberate state, not a crash.
  check('hiding every lane empties the chart', buildChart(laned, ['lyrics', 'chords', 'cues']).length === 0);

  /* -------------------------------- versions --------------------------------- */

group('versions');
{
  const { versionsOf, versionName } = await import('../src/lib/versions.ts');
  const v = (id, path, role) => ({ id, name: id, path, role, rev: 'r', sizeBytes: 1 });

  // Files in one folder are one version, whatever kind of part they are.
  const one = versionsOf(
    [
      v('ref', '/Coldplay/Fix You Stems/Ref Master.wav', 'mix'),
      v('bass', '/Coldplay/Fix You Stems/Bass.wav', 'stem'),
      v('drums', '/Coldplay/Fix You Stems/Drums.wav', 'stem'),
      v('instr', '/Coldplay/Fix You Stems/Fix You (instr).wav', 'mix'),
    ],
    'Fix You',
  );
  check('one folder is one version', one.length === 1, one.length);
  check('a version holds every kind of part', one[0].stems.length === 2 && one[0].mixes.length === 2);

  // A separate export folder is a separate version.
  const two = versionsOf(
    [
      v('a', '/C/Fix You Stems 2025.09.10/Bass.wav', 'stem'),
      v('b', '/C/Fix You Stems 2025.09.10/Drums.wav', 'stem'),
      v('c', '/C/Fix You Live 2026/Bass.wav', 'stem'),
    ],
    'Fix You',
  );
  check('another folder is another version', two.length === 2, two.length);
  check('the fullest version leads', two[0].parts.length === 2, two[0].name);

  // The song's own name comes off the front of the folder name.
  check(
    'the version is named by what distinguishes it',
    versionName('/C/Fix You 136 140BPM Stems 2025.09.10', 'Fix You') === '136 140BPM Stems 2025.09.10',
    versionName('/C/Fix You 136 140BPM Stems 2025.09.10', 'Fix You'),
  );
  check('a folder that is only the song keeps a name', versionName('/C/Fix You', 'Fix You') === 'Fix You');
}

/* ------------------------------- reading clips ----------------------------- */

group('clips');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');

  /*
   * A minimal set: one song from beat 0 to beat 32, one track holding two
   * clips — the second trimmed, deactivated, and starting part way into its
   * file. 120 BPM means 2 beats a second, so beat 16 is 8 seconds in.
   */
  const clip = (start, end, srcBeat, disabled, fadeOut = 0) => `
    <AudioClip Id="1">
      <CurrentStart Value="${start}" />
      <CurrentEnd Value="${end}" />
      <LoopStart Value="${srcBeat}" />
      <LoopEnd Value="${end - start + srcBeat}" />
      <StartRelative Value="0" />
      <Disabled Value="${disabled}" />
      <Fade Value="true" />
      <FadeInLength Value="0" />
      <FadeOutLength Value="${fadeOut}" />
      <IsWarped Value="true" />
      <WarpMarker Id="1" SecTime="0" BeatTime="0" />
      <WarpMarker Id="2" SecTime="10" BeatTime="20" />
      <SampleRef><FileRef><RelativePath Value="Samples/Bass.wav" /></FileRef>
      <DefaultSampleRate Value="48000" /></SampleRef>
    </AudioClip>`;

  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Test Song" /></Locator>
    <Locator Id="2"><Time Value="32" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Test Song" /><Annotation Value="Piano intro&#10;Watch the drummer" /></GroupTrack>
    <AudioTrack Id="11"><TrackGroupId Value="10" /><EffectiveName Value="Bass" />
      <Speaker><LomId Value="0" /><Manual Value="true" /></Speaker>
      ${clip(0, 16, 0, 'false', 0.25)}
      ${clip(16, 32, 16, 'true')}
    </AudioTrack>
  </Ableton>`;

  const song = parseAlsXml(xml).songs[0];
  check('the group track\'s info text is the song\'s notes, line breaks kept',
    song.notes === 'Piano intro\nWatch the drummer', JSON.stringify(song.notes));
  {
    // The set's words win over what was typed here; silence from the set keeps them.
    const { songsFromProject, songIdFor } = await import('../src/lib/alsImport.ts');
    const parsed = parseAlsXml(xml);
    const id = songIdFor('/Set.als', 'Test Song');
    const typed = new Map([[id, { id, title: 'Test Song', variants: [], notes: 'typed in the app', transpose: 0 }]]);
    const spoken = songsFromProject(parsed, '/Set.als', [], typed).songs[0];
    check('when the set has notes, they replace what was typed in the app',
      spoken.notes === 'Piano intro\nWatch the drummer', JSON.stringify(spoken.notes));
    const silent = { ...parsed, songs: parsed.songs.map((s) => ({ ...s, notes: '' })) };
    const kept = songsFromProject(silent, '/Set.als', [], typed).songs[0];
    check('and when it has none, what was typed stays', kept.notes === 'typed in the app', JSON.stringify(kept.notes));
  }
  const bass = song?.stems[0];
  check('the track is found', !!bass && bass.name === 'Bass', bass?.name);
  check('both clips are read, not just the first', bass?.clips.length === 2, bass?.clips.length);

  const [first, second] = bass?.clips ?? [];
  check('the first runs from the top', first?.startBar === 1 && first?.endBar === 5, `${first?.startBar}-${first?.endBar}`);
  check('it starts at the top of its file', first?.sourceStartSec === 0);
  check('its fade out is kept', first?.fadeOutSec === 0.25, first?.fadeOutSec);

  // Beat 16 of the file at 2 beats a second is 8 seconds in.
  check('the second knows where it sits in the file', second?.sourceStartSec === 8, second?.sourceStartSec);
  check('and that it is switched off', second?.disabled === true);

  // Only the live clip counts towards where the part sounds.
  check('regions follow the live clip alone', song?.stems[0].regions?.length === 1, JSON.stringify(song?.stems[0].regions));
  check('ending where it was cut', song?.stems[0].regions?.[0].endBar === 5, song?.stems[0].regions?.[0].endBar);
}

/* ------------------------------- midi patches ------------------------------ */

group('midi patches');
{
  const { patchMessages, describePatch } = await import('../src/lib/midi.ts');
  const hex = (m) => m.map((b) => b.toString(16).padStart(2, '0')).join(' ');

  // Program change is 0xC0 plus the channel, counting from zero on the wire
  // while musicians count from one on the box.
  check('channel 1 is 0xC0', hex(patchMessages({ channel: 1, program: 42 })[0]) === 'c0 2a');
  check('channel 16 is 0xCF', hex(patchMessages({ channel: 16, program: 0 })[0]) === 'cf 00');
  check('one message when there is no bank', patchMessages({ channel: 1, program: 5 }).length === 1);

  /*
   * A bank goes first and in two halves — coarse then fine — because a rig
   * expecting a bank ignores a program change that arrives ahead of it.
   */
  const banked = patchMessages({ channel: 3, program: 7, bank: 5 });
  check('a bank adds two messages', banked.length === 3, banked.length);
  check('coarse bank first', hex(banked[0]) === 'b2 00 00', hex(banked[0]));
  check('then fine', hex(banked[1]) === 'b2 20 05', hex(banked[1]));
  check('then the program', hex(banked[2]) === 'c2 07', hex(banked[2]));

  // 2000 is 0x7D0: fifteen in the coarse half, eighty in the fine.
  const big = patchMessages({ channel: 2, program: 1, bank: 2000 });
  check('a big bank splits across both halves', hex(big[0]) === 'b1 00 0f' && hex(big[1]) === 'b1 20 50');

  // Nothing may go out of range, whatever gets typed in.
  check('channel 0 becomes 1', hex(patchMessages({ channel: 0, program: 0 })[0]) === 'c0 00');
  check('channel 99 becomes 16', hex(patchMessages({ channel: 99, program: 0 })[0]) === 'cf 00');
  check('a program past 127 is clamped', hex(patchMessages({ channel: 1, program: 999 })[0]) === 'c0 7f');
  check('every byte stays a byte', patchMessages({ channel: 99, program: 999, bank: 99999 })
    .every((m) => m.every((b) => b >= 0 && b <= 255)));

  check('and it reads back plainly', describePatch({ channel: 3, program: 7, bank: 5 }) === 'bank 5, program 7 on ch 3');

  // A patch may be control changes alone — a snapshot is not a program change.
  const ccOnly = patchMessages({ channel: 1, controls: [{ cc: 69, value: 2 }] });
  check('controls can stand alone', ccOnly.length === 1 && hex(ccOnly[0]) === 'b0 45 02', hex(ccOnly[0]));

  /*
   * Controls come last. A snapshot selects within the preset that is loaded, so
   * arriving before the program change would see it wiped by the preset landing
   * on top of it.
   */
  const both = patchMessages({ channel: 1, program: 5, controls: [{ cc: 69, value: 1 }] });
  check('a program change comes before its control', hex(both[0]) === 'c0 05' && hex(both[1]) === 'b0 45 01');
}

/* -------------------------------- patch clips ------------------------------ */

group('patch clips');
{
  const { clipSpans, clipsOf, clipsToAdopt, forgetAdopted, newClip, patchPoints, withClip, withoutClip } =
    await import('../src/lib/midi.ts');

  // A clip holds until the next one, and the last runs to the end of the song.
  const clips = [
    { id: 'b', bar: 17, patch: { channel: 1, program: 1 } },
    { id: 'a', bar: 1, patch: { channel: 1, program: 0 } },
    { id: 'c', bar: 33, patch: { channel: 1, program: 2 } },
  ];
  const spans = clipSpans(clips, 64);
  check('spans come out in bar order', spans.map((s) => s.clip.bar).join() === '1,17,33');
  check('each runs to the next', spans[0].endBar === 17 && spans[1].endBar === 33);
  check('the last runs to the end', spans[2].endBar === 65, spans[2].endBar);
  check('an empty song has no spans', clipSpans([], 64).length === 0);

  // A clip on the final bar still has to be wide enough to hit.
  const atEnd = clipSpans([{ id: 'x', bar: 64, patch: { channel: 1 } }], 64);
  check('a clip at the end keeps a bar of width', atEnd[0].endBar === 65, atEnd[0].endBar);
  const past = clipSpans([{ id: 'x', bar: 80, patch: { channel: 1 } }], 64);
  check('and so does one past it', past[0].endBar === 81, past[0].endBar);

  /*
   * A length ends the clip early, and the gap after it is the rig back the way
   * it was. A length that runs past the next change doesn't get to end it: the
   * next clip has taken the rig by then, and a message landing after it would
   * undo the wrong thing.
   */
  const boost = { id: 'x', bar: 9, lengthBars: 4, patch: { channel: 1, program: 1 } };
  const withLength = clipSpans([{ id: 'a', bar: 1, patch: { channel: 1, program: 0 } }, boost], 64);
  check('a length ends the clip', withLength[1].endBar === 13 && withLength[1].ownEnd);
  check('and the one before is untouched', withLength[0].endBar === 9 && !withLength[0].ownEnd);

  const overrun = clipSpans([{ ...boost, lengthBars: 40 }, { id: 'b', bar: 17, patch: { channel: 1 } }], 64);
  check('a length past the next change is ignored', overrun[0].endBar === 17 && !overrun[0].ownEnd);

  // What actually goes down the wire, endings resolved.
  const first = { id: 'a', bar: 1, patch: { channel: 1, program: 0, source: 'rhythm' } };
  const solo = { id: 'b', bar: 9, lengthBars: 4, patch: { channel: 1, program: 5, source: 'boost' } };
  const points = patchPoints([first, solo], 64);
  check('a plain clip sends once', patchPoints([first], 64).length === 1);
  check('one with a length sends twice', points.length === 3, points.length);
  check('the second is at its end', points[2].bar === 13, points[2].bar);
  check('and puts back what was on', points[2].patch.source === 'rhythm', points[2].patch.source);

  // An explicit ending wins over what was on before.
  const explicit = { ...solo, endPatch: { channel: 1, program: 9, source: 'clean' } };
  check(
    'a chosen ending wins',
    patchPoints([first, explicit], 64)[2].patch.source === 'clean',
  );

  // The first change in a song has nothing to go back to.
  const alone = patchPoints([solo], 64);
  check('nothing to go back to sends nothing', alone.length === 1, alone.length);
  check('unless it was told what to send', patchPoints([explicit], 64).length === 2);

  /*
   * Two in a row that both put something back: the second must return to what
   * the first returned to, not to the first clip's own patch — the rig was on
   * the rhythm sound by then, not on the boost.
   */
  const second = { id: 'c', bar: 21, lengthBars: 4, patch: { channel: 1, program: 6, source: 'lead' } };
  const chained = patchPoints([first, solo, second], 64);
  check('a second ending goes back to the same place', chained[4].patch.source === 'rhythm', chained[4].patch.source);
  check('and lands at its own end', chained[4].bar === 25, chained[4].bar);

  // A clip whose length is ignored still counts as what's in force afterwards.
  const runOn = patchPoints([first, { ...solo, lengthBars: 40 }, second], 64);
  check(
    'an overrun clip is what is in force after it',
    runOn[3].patch.source === 'boost',
    runOn[3].patch.source,
  );

  // Storage is per device, so the rest needs somewhere to put it.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const song = { id: 'song1', markers: [{ id: 'm1', bar: 9 }, { id: 'm2', bar: 25 }] };
  check('a song with nothing set has no clips', clipsOf(song).length === 0);

  // The list operations the library saves through.
  const one = withClip([], newClip(25, { channel: 2, program: 4 }));
  const two = withClip(one, newClip(9, { channel: 2, program: 3 }));
  check('a clip is added', one.length === 1 && two.length === 2);
  check('and they are kept in bar order', two.map((c) => c.bar).join() === '9,25');

  // Saving by id moves a clip rather than making a second one.
  const moved = withClip(two, { ...two[0], bar: 40 });
  check('the same id moves it', moved.length === 2 && moved.map((c) => c.bar).join() === '25,40');
  check('removing takes one away', withoutClip(moved, moved[0].id).length === 1);
  check('a clip reads back in bar order', clipsOf({ patchClips: moved })[0].bar === 25);

  /*
   * Two older homes get folded into the song. Clips kept per device, and before
   * that patches hung off markers — one whose marker has since been deleted has
   * no bar left to sit on and is dropped.
   */
  store.clear();
  store.set('ls.midi.clips', JSON.stringify({ song1: [{ id: 'd1', bar: 33, patch: { channel: 1 } }] }));
  const fromDevice = clipsToAdopt({ ...song, patchClips: [{ id: 'l1', bar: 5, patch: { channel: 1 } }] });
  check('clips on the device are taken in', fromDevice.map((c) => c.bar).join() === '5,33', fromDevice.map((c) => c.bar).join());
  // Still there until the caller says they landed: a save that doesn't happen
  // must not take them with it.
  check('but not let go of yet', JSON.parse(store.get('ls.midi.clips')).song1 !== undefined);
  forgetAdopted(song.id);
  check('and cleared once they are saved', JSON.parse(store.get('ls.midi.clips')).song1 === undefined);
  check('so a second pass finds nothing', clipsToAdopt(song) === null);

  store.clear();
  store.set('ls.midi.patches', JSON.stringify({
    song1: {
      m2: { channel: 1, program: 7 },
      m1: { channel: 1, program: 5 },
      gone: { channel: 1, program: 9 },
    },
    other: { m1: { channel: 1, program: 1 } },
  }));
  const migrated = clipsToAdopt(song);
  check('old patches move onto their bars', migrated.map((c) => c.bar).join() === '9,25', migrated.map((c) => c.bar).join());
  check('keeping what they sent', migrated[0].patch.program === 5 && migrated[1].patch.program === 7);
  check('a patch whose marker has gone is dropped', migrated.length === 2);
  forgetAdopted(song.id);
  check('it only happens once', clipsToAdopt(song) === null);
  check(
    'and another song is left for its own turn',
    JSON.parse(store.get('ls.midi.patches')).other !== undefined,
  );

  delete globalThis.localStorage;
}

/* ------------------------ a scan, end to end ------------------------------- */

group('a scan, end to end');
{
  /*
   * The order the store puts these in, with nothing stubbed. Each piece is
   * covered on its own above; what this pins down is that they still add up —
   * a set going in one end and a running order coming out the other.
   */
  const { songsFromProject, setlistFromProject } = await import('../src/lib/alsImport.ts');
  const { mergeScan, syncSetlists } = await import('../src/lib/scan.ts');
  const { emptyLibrary } = await import('../src/types.ts');

  const alsPath = '/Sets/Coldplay Covers Live Set/Coldplay Cover Band 2026.06.22.als';
  const song = (title, startBar) => ({
    title, raw: title, startBar, endBar: startBar + 100,
    bpm: 136, key: 'Eb', durationText: null, tags: [],
    sections: [], chords: [], lyrics: [], lanes: [], tempoChanges: [], rigMarks: [],
    stems: [{ name: 'Bass', path: `Stems/${title}.wav`, regions: null, clips: [] }],
  });
  const project = {
    creator: 'Live 12', tempo: 136, timeSigNum: 4, timeSigDen: 4, warnings: [],
    songs: [song('Yellow', 1), song('Fix You', 200), song('Clocks', 400)],
  };
  const file = (p) => ({ path: p, name: p.split('/').pop(), rev: 'r', size: 10, modified: 1 });
  const available = [
    file('/Sets/Coldplay Covers Live Set/Stems/Yellow.wav'),
    file('/Sets/Coldplay Covers Live Set/Stems/Fix You.wav'),
    file('/Sets/Coldplay Covers Live Set/Stems/Clocks.wav'),
  ];

  const imported = songsFromProject(project, alsPath, available, new Map());
  check('the set gives songs', imported.songs.length === 3, imported.songs.length);

  // The folder scan sees nothing else, since the set owns its folder.
  const result = mergeScan(emptyLibrary(''), [], '', imported.claimedPaths);
  const songs = [...new Map(result.library.songs.map((s) => [s.id, s])).values(), ...imported.songs];
  const live = new Set(songs.map((s) => s.id));
  const alsSetlists = [setlistFromProject(alsPath, project, (id) => live.has(id))].filter(
    (sl) => sl.songIds.length > 0,
  );
  check('and one setlist', alsSetlists.length === 1);
  const setlists = syncSetlists(result.library.setlists, alsSetlists, live);

  check('a setlist comes out of the scan', setlists.length === 1, setlists.length);
  check('named after the set', setlists[0]?.name === 'Coldplay Covers Live Set', setlists[0]?.name);
  check('holding every song', setlists[0]?.songIds.length === 3, setlists[0]?.songIds.length);
  check(
    'in the order the arrangement plays',
    setlists[0]?.songIds.join() === imported.songs.map((s) => s.id).join(),
  );

  // And a second scan doesn't make a second one.
  check('scanning again keeps one', syncSetlists(setlists, alsSetlists, live).length === 1);

  /*
   * The set's audio can't be reached this time: every song still imports,
   * with nothing to play, and the running order is the set's to give.
   */
  const nothingImported = songsFromProject(project, alsPath, [], new Map());
  check('a set with no reachable audio still imports its songs, empty',
    nothingImported.songs.length === 3 && nothingImported.songs.every((s) => s.variants.length === 0),
    String(nothingImported.songs.length));
  const stillListed = setlistFromProject(alsPath, project, (id) => live.has(id));
  check('but the set still gives its order', stillListed.songIds.length === 3, stillListed.songIds.length);

  // A set the library knows nothing about gives nothing.
  check(
    'a set of strangers gives none',
    setlistFromProject(alsPath, project, () => false).songIds.length === 0,
  );
}

/* --------------------------- patches in the set ---------------------------- */

group('patches in the set');
{
  const {
    canonicalAlsPath, isRehearsalCopy, isRigLocator, parseRigLocator, rehearsalCopyPath,
    rigLocatorName, writeRigLocators,
  } = await import('../src/lib/alsPatch.ts');

  // A name carries the words you read in Ableton and the message it sends.
  const scene = {
    id: 'a', bar: 9,
    patch: { channel: 1, controls: [{ cc: 43, value: 2 }], source: 'Quad Cortex scene 3' },
  };
  const name = rigLocatorName(scene);
  check('it says what it is', name === '*rig Quad Cortex scene 3 [ch1 cc43=2]', name);
  check('and reads as ours', isRigLocator(name));
  check('a song locator does not', !isRigLocator('Long Way Down {128}'));

  const back = parseRigLocator(name);
  check('it comes back the same', back.patch.controls[0].cc === 43 && back.patch.controls[0].value === 2);
  check('on the same channel', back.patch.channel === 1);
  check('keeping the words as its name', back.patch.source === 'Quad Cortex scene 3', back.patch.source);

  // A program change, a bank, and a length with an ending of its own.
  const boost = {
    id: 'b', bar: 1, lengthBars: 8,
    patch: { channel: 3, program: 12, bank: 5, source: 'Helix preset 13' },
    endPatch: { channel: 3, controls: [{ cc: 51, value: 0 }] },
  };
  const boostName = rigLocatorName(boost);
  check(
    'everything fits in one name',
    boostName === '*rig Helix preset 13 [ch3 bk5 pc12 len8 > cc51=0]',
    boostName,
  );
  const boostBack = parseRigLocator(boostName);
  check('the length survives', boostBack.lengthBars === 8);
  check('the bank and program survive', boostBack.patch.bank === 5 && boostBack.patch.program === 12);
  check('and so does the ending', boostBack.endPatch.controls[0].value === 0);
  check('which is on the same channel', boostBack.endPatch.channel === 3);

  // Nonsense stays in the set rather than becoming a message.
  check('a name with no message is refused', parseRigLocator('*rig nothing [ch1]') === null);
  check('a bad channel is refused', parseRigLocator('*rig x [ch99 pc1]') === null);
  check('and something else entirely is not ours', parseRigLocator('Chorus') === null);

  /* The app's copy has to answer to the original's name, or every song in it
     arrives as a new one and the library loses what was pinned to the old ids. */
  const original = '/Songs/Coldplay Live Project/Coldplay Live.als';
  const copy = rehearsalCopyPath(original);
  check('the copy sits beside it', copy === '/Songs/Coldplay Live Project/Coldplay Live (rehearsaltool).als', copy);
  check('and answers to the original', canonicalAlsPath(copy) === original, canonicalAlsPath(copy));
  check('the original answers to itself', canonicalAlsPath(original) === original);
  check('a copy knows it is one', isRehearsalCopy(copy) && !isRehearsalCopy(original));

  /* Writing into the XML. The new elements are cloned from one already there,
     so they carry whatever children this version of Live writes. */
  const xml = [
    '<Ableton>',
    '<Locators><Locators>',
    '<Locator Id="4"><LomId Value="0" /><Time Value="0" /><Name Value="Yellow" />',
    '<Annotation Value="note" /><IsSongStart Value="true" /></Locator>',
    '<Locator Id="7"><LomId Value="0" /><Time Value="64" /><Name Value="Fix You" />',
    '<Annotation Value="" /><IsSongStart Value="true" /></Locator>',
    '</Locators></Locators>',
    '</Ableton>',
  ].join('\n');

  const written = writeRigLocators(xml, [{ beat: 32, name }]);
  check('the set keeps its own locators', /Name Value="Yellow"/.test(written) && /Name Value="Fix You"/.test(written));
  check('and gains ours', written.includes('<Name Value="*rig Quad Cortex scene 3 [ch1 cc43=2]" />'), 'not found');
  check('at the beat it belongs on', /<Time Value="32" \/>/.test(written));
  check('with an id nothing else has', /<Locator Id="8">/.test(written));
  check('carrying the children Live wrote', (written.match(/IsSongStart/g) ?? []).length === 3);
  check('and no annotation of its own', (written.match(/Annotation Value="note"/g) ?? []).length === 1);

  // Writing again replaces, rather than stacking up.
  const twice = writeRigLocators(written, [{ beat: 48, name }]);
  check('writing twice does not duplicate', (twice.match(/\*rig/g) ?? []).length === 1, (twice.match(/\*rig/g) ?? []).length);
  check('it lands at the new beat', /<Time Value="48" \/>/.test(twice));
  check('and the old one is gone', !/<Time Value="32" \/>/.test(twice));

  // Clearing them out entirely.
  const cleared = writeRigLocators(written, []);
  check('none left when there are none', !/\*rig/.test(cleared));
  check('the set is otherwise untouched', /Name Value="Yellow"/.test(cleared) && /Name Value="Fix You"/.test(cleared));

  // A set with no locators at all has no songs either, so nothing to write to.
  check('nothing to clone means nothing written', writeRigLocators('<Ableton></Ableton>', [{ beat: 1, name }]) === null);

  /*
   * The whole way round: write a clip into a set's XML, read that XML back
   * with the real parser, and check it arrives as the same clip on the same
   * bar. This is the join that matters — the two halves are written against
   * each other and nothing else checks that they agree.
   */
  {
    const { parseAlsXml } = await import('../src/lib/alsParser.ts');
    const { songsFromProject } = await import('../src/lib/alsImport.ts');

    // 4/4, so a bar is 4 beats. The song starts at beat 64, which is bar 17.
    const set = [
      '<Ableton>',
      '<EnumEvent Value="4" /><EnumEvent Value="2" />',
      '<Locators><Locators>',
      '<Locator Id="1"><LomId Value="0" /><Time Value="64" /><Name Value="Fix You" />',
      '<Annotation Value="" /><IsSongStart Value="true" /></Locator>',
      '<Locator Id="2"><LomId Value="0" /><Time Value="192" /><Name Value="STOP" />',
      '<Annotation Value="" /><IsSongStart Value="false" /></Locator>',
      '</Locators></Locators>',
      '</Ableton>',
    ].join('\n');

    // Bar 9 of a song starting at bar 17 is bar 25 of the set: beat 96.
    const withClip = writeRigLocators(set, [{ beat: 96, name }]);
    const project = parseAlsXml(withClip);
    const song = project.songs.find((s) => s.title === 'Fix You');
    check('the set still parses with ours in it', !!song, project.songs.map((s) => s.title).join());
    check('and it is not read as a song of its own', project.songs.length === 1, project.songs.length);
    check('the mark lands in the right song', song.rigMarks.length === 1, song.rigMarks.length);
    check('on the bar it was written for', song.rigMarks[0].bar === 9, song.rigMarks[0].bar);

    /*
     * And on into the library. A song is only imported when its audio is
     * actually there, so the parsed marks are carried onto a song that has
     * some — the same shape the scan hands over.
     */
    const withAudio = {
      ...project,
      songs: [{ ...song, stems: [{ name: 'Bass', path: 'bass.wav', regions: null, clips: [] }] }],
    };
    const available = [{ path: '/bass.wav', name: 'bass.wav', rev: 'r', size: 10 }];
    const imported = songsFromProject(withAudio, '/Set.als', available, new Map());
    const clips = imported.songs[0]?.patchClips ?? [];
    check('and arrives as a clip', clips.length === 1, clips.length);
    check('at that bar', clips[0]?.bar === 9, clips[0]?.bar);
    check('sending what it said', clips[0]?.patch.controls[0].cc === 43);

    const twiceOver = songsFromProject(withAudio, '/Set.als', available, new Map());
    check(
      'under an id a rescan gives it again',
      clips[0]?.id === twiceOver.songs[0].patchClips[0].id,
      clips[0]?.id,
    );

    /* A set with none of ours leaves whatever was programmed in the app. */
    const noMarks = { ...withAudio, songs: [{ ...withAudio.songs[0], rigMarks: [] }] };
    const keptId = imported.songs[0].id;
    const existing = new Map([[keptId, { id: keptId, patchClips: [{ id: 'own', bar: 3, patch: { channel: 1 } }] }]]);
    const kept = songsFromProject(noMarks, '/Set.als', available, existing);
    check('a set with none leaves the app`s alone', kept.songs[0].patchClips?.[0].id === 'own', JSON.stringify(kept.songs[0].patchClips));
  }

  // A name with a quote in it must not break the attribute it sits in.
  const quoted = rigLocatorName({
    id: 'c', bar: 1, patch: { channel: 1, controls: [{ cc: 9, value: 7 }], source: 'Stadium Matrix 1/4"' },
  });
  const quotedXml = writeRigLocators(xml, [{ beat: 0, name: quoted }]);
  check('a quote is escaped', quotedXml.includes('Matrix 1/4&quot;'), 'not escaped');
  check('and the element still closes', (quotedXml.match(/<\/Locator>/g) ?? []).length === 3);
}

/* ----------------------------- the rig dictionary -------------------------- */

group('rig dictionary');
{
  const { DEVICES, deviceById, optionById, choiceLabel, choiceValue, startingDevice, startingPatch } =
    await import('../src/lib/devices.ts');
  const { patchMessages, describePatch } = await import('../src/lib/midi.ts');
  const hex = (m) => m.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const send = (deviceId, optionId, value, channel = 1) => {
    const device = deviceById(deviceId);
    const option = optionById(device, optionId);
    return patchMessages(option.build(channel, value));
  };

  /*
   * The numbers here came from Line 6's and Neural DSP's own documentation. If
   * any of them drift, an instrument silently does the wrong thing on stage,
   * which is the worst place to find out — so they are pinned.
   */
  check('Helix snapshot is CC69', hex(send('helix', 'helix-snapshot', 2)[0]) === 'b0 45 02', hex(send('helix', 'helix-snapshot', 2)[0]));
  check('Helix setlist is CC32', hex(send('helix', 'helix-setlist', 3)[0]) === 'b0 20 03');
  check('Helix tuner is CC68', hex(send('helix', 'helix-tuner', 1)[0]) === 'b0 44 7f');
  check('Helix tap tempo is CC64', hex(send('helix', 'helix-tap', 0)[0]) === 'b0 40 7f');
  check('Helix preset is a program change', hex(send('helix', 'helix-preset', 9)[0]) === 'c0 09');

  check('Quad Cortex scene is CC43', hex(send('quad-cortex', 'qc-scene', 2)[0]) === 'b0 2b 02', hex(send('quad-cortex', 'qc-scene', 2)[0]));
  check('Quad Cortex tap tempo is CC44', hex(send('quad-cortex', 'qc-tap', 0)[0]) === 'b0 2c 7f');
  check('Quad Cortex tuner is CC45', hex(send('quad-cortex', 'qc-tuner', 1)[0]) === 'b0 2d 7f');
  check('Quad Cortex gig view is CC46', hex(send('quad-cortex', 'qc-gig-view', 1)[0]) === 'b0 2e 7f');

  // Channel is honoured everywhere, not just on program changes.
  check('a control follows the channel', hex(send('helix', 'helix-snapshot', 0, 10)[0]) === 'b9 45 00');

  // Everything the picker can offer has to actually build something sendable.
  let built = 0;
  for (const device of DEVICES) {
    for (const option of device.options) {
      for (const value of [0, (option.count ?? 1) - 1]) {
        const messages = patchMessages(option.build(device.defaultChannel, value));
        if (!messages.length) check(`${device.id}/${option.id} sends nothing`, false);
        if (!messages.every((m) => m.every((b) => b >= 0 && b <= 255))) {
          check(`${device.id}/${option.id} sends a bad byte`, false);
        }
        built++;
      }
    }
  }
  check('every option in the dictionary sends valid bytes', built > 0, `${built} checked`);

  // Names read the way the box names them, and the modellers count from one.
  const helix = deviceById('helix');
  check('snapshots are numbered from one', choiceLabel(optionById(helix, 'helix-snapshot'), 0) === '1');
  check('and described that way', describePatch(optionById(helix, 'helix-snapshot').build(1, 2)).startsWith('Helix snapshot 3'));

  // A bare program change has no box to agree with, so it shows the wire value.
  const generic = deviceById('generic');
  check('a plain program change counts from zero', choiceLabel(optionById(generic, 'generic-program'), 0) === '0');

  /*
   * Footswitches run 49–58 across ten stomps, skipping FS6 and FS12 — those are
   * the mode and tap switches on the hardware and have no CC. An off-by-one
   * anywhere in here presses the wrong pedal, so every one is pinned.
   */
  const fsOn = optionById(deviceById('helix'), 'helix-fs-on');
  const expected = [
    ['FS1', 49], ['FS2', 50], ['FS3', 51], ['FS4', 52], ['FS5', 53],
    ['FS7', 54], ['FS8', 55], ['FS9', 56], ['FS10', 57], ['FS11', 58],
  ];
  check('ten stomps are offered', fsOn.count === 10, fsOn.count);
  let allRight = true;
  expected.forEach(([label, cc], i) => {
    if (choiceLabel(fsOn, i) !== label) allRight = false;
    const message = patchMessages(fsOn.build(1, i))[0];
    if (message[1] !== cc || message[2] !== 127) allRight = false;
  });
  check('each is on its documented CC', allRight);
  check('FS6 is not offered', !expected.some(([label]) => label === 'FS6'));
  check('and the numbering steps over it', choiceLabel(fsOn, 4) === 'FS5' && choiceLabel(fsOn, 5) === 'FS7');

  const fsOff = optionById(deviceById('helix'), 'helix-fs-off');
  check('switching one off sends zero', patchMessages(fsOff.build(1, 2))[0][2] === 0);
  check('on the same CC', patchMessages(fsOff.build(1, 2))[0][1] === 51);

  check('the toe switch is CC59', patchMessages(optionById(deviceById('helix'), 'helix-toe').build(1, 1))[0][1] === 59);

  // Mode on the Quad Cortex is CC47, its slots numbered from zero.
  const mode = optionById(deviceById('quad-cortex'), 'qc-mode');
  check('Quad Cortex mode is CC47', patchMessages(mode.build(1, 1))[0][1] === 47);
  check('and its slots count from zero', patchMessages(mode.build(1, 0))[0][2] === 0);

  // The Quad Cortex genuinely has no footswitch emulation; say so, don't invent it.
  check(
    'no footswitch option is offered for the Quad Cortex',
    !deviceById('quad-cortex').options.some((o) => /footswitch/i.test(o.label)),
  );
  check('and the rig says why', /footswitch/i.test(deviceById('quad-cortex').note ?? ''));

  /*
   * Stadium is a different machine, not a newer Helix. Everything it shares a
   * name with sits on a different CC, so the two are pinned against each other
   * — this is exactly the confusion that would put a tuner on stage into
   * whatever CC68 happens to be assigned to.
   */
  const stadium = deviceById('helix-stadium');
  const pick = (deviceId, optionId, index, channel = 1) => {
    const d = deviceById(deviceId);
    const o = optionById(d, optionId);
    return patchMessages(o.build(channel, choiceValue(o, index)))[0];
  };

  check('Stadium keeps snapshots on CC69', pick('helix-stadium', 'stadium-snapshot', 0)[1] === 69);
  check('and adds next and previous', optionById(stadium, 'stadium-snapshot').count === 10);
  check('its toe switch is CC36, not 59', pick('helix-stadium', 'stadium-toe', 0)[1] === 36);
  check('the original stays on 59', pick('helix', 'helix-toe', 1)[1] === 59);
  check('its tuner is a value of CC9', pick('helix-stadium', 'stadium-panel', 0)[1] === 9);
  check('and that value is 34', pick('helix-stadium', 'stadium-panel', 0)[2] === 34);
  check('the original tuner is CC68', pick('helix', 'helix-tuner', 1)[1] === 68);
  check('footswitch mode is CC37', pick('helix-stadium', 'stadium-fs-mode', 0)[1] === 37);
  check('play/pause is CC51', pick('helix-stadium', 'stadium-transport', 0)[1] === 51);
  check('return to zero is CC47', pick('helix-stadium', 'stadium-transport', 1)[1] === 47);
  check('tap tempo is CC64 on both', pick('helix-stadium', 'stadium-tap', 0)[1] === 64 && pick('helix', 'helix-tap', 0)[1] === 64);

  // The panel's documented values skip 28–32, so a choice is not its index.
  const panel = optionById(stadium, 'stadium-panel');
  check('every panel choice has a value', panel.values.length === panel.count, `${panel.values.length}/${panel.count}`);
  check('none of them is undocumented', ![28, 29, 30, 31, 32].some((v) => panel.values.includes(v)));
  check('and the choice is not the value', choiceValue(panel, 0) !== 0 && choiceValue(panel, 0) === 34);
  check('they read back by name', describePatch(panel.build(1, 34)) === 'Stadium tuner · ch 1', describePatch(panel.build(1, 34)));

  // Stadium has no per-footswitch CC either — only whole-board mode switching.
  check(
    'no per-footswitch option for Stadium',
    !stadium.options.some((o) => /^footswitch (on|off)$/i.test(o.label)),
  );
  check('and it says so', /footswitch/i.test(stadium.note ?? ''));

  /*
   * The rig a patch change starts on. A stored id that no longer exists falls
   * back rather than failing, or the dialog would open with nothing selected.
   */
  check('the named rig is used', startingDevice('quad-cortex').id === 'quad-cortex');
  check('nothing named falls back', startingDevice('').id === DEVICES[0].id);
  check('and so does something gone', startingDevice('roland-gp8').id === DEVICES[0].id);

  /*
   * A new clip starts on the rig's first option, which is its most useful one —
   * a snapshot or a scene, not a bare program change.
   */
  const qc = startingPatch('quad-cortex');
  check('a new clip is the rig`s first move', qc.source === 'Quad Cortex scene 1', qc.source);
  check('on the rig`s own channel', qc.channel === deviceById('quad-cortex').defaultChannel);
  check('or on the one you set', startingPatch('quad-cortex', 7).channel === 7);
  check('zero means the rig`s own', startingPatch('helix', 0).channel === deviceById('helix').defaultChannel);
}

/* ---------------------------------- timecode ------------------------------- */

group('timecode');
{
  const { ltcFrameBits, ltcTimeAt, formatTimecode, renderLtc, LTC_SAMPLE_RATE } =
    await import('../src/lib/ltc.ts');

  // Frames roll into seconds, seconds into minutes, and the clock wraps at 24h.
  check('frames count within a second', formatTimecode(ltcTimeAt(7, 25)) === '00:00:00:07');
  check('and roll over into seconds', formatTimecode(ltcTimeAt(25, 25)) === '00:00:01:00');
  check('minutes accumulate', formatTimecode(ltcTimeAt(25 * 61, 25)) === '00:01:01:00');
  check('hours too', formatTimecode(ltcTimeAt(25 * 3600, 25)) === '01:00:00:00');
  check('at 30fps the frame count differs', formatTimecode(ltcTimeAt(29, 30)) === '00:00:00:29');

  /*
   * The bit layout is the part that is easy to get wrong: the time fields are
   * interleaved with user bits rather than laid end to end. Read the fields
   * back out at their SMPTE positions.
   */
  const bits = ltcFrameBits({ hours: 12, minutes: 34, seconds: 56, frames: 7 });
  check('a frame is 80 bits', bits.length === 80, bits.length);
  const field = (at, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v |= bits[at + i] << i;
    return v;
  };
  check('frames sit at 0 and 8', field(8, 2) * 10 + field(0, 4) === 7);
  check('seconds at 16 and 24', field(24, 3) * 10 + field(16, 4) === 56);
  check('minutes at 32 and 40', field(40, 3) * 10 + field(32, 4) === 34);
  check('hours at 48 and 56', field(56, 2) * 10 + field(48, 4) === 12);
  check(
    'and the sync word closes it',
    bits.slice(64).join('') === '0011111111111101',
    bits.slice(64).join(''),
  );

  // Biphase mark: every bit flips the level, and a 1 flips again halfway.
  const audio = renderLtc(1, 25, LTC_SAMPLE_RATE, 0);
  check('a second is a second of samples', audio.length === LTC_SAMPLE_RATE, audio.length);
  check('and it is not silence', audio.some((v) => v !== 0));

  let flips = 0;
  for (let i = 1; i < audio.length; i++) if (Math.sign(audio[i]) !== Math.sign(audio[i - 1])) flips++;
  /*
   * 25 frames of 80 bits is 2000 bit boundaries a second, each a transition,
   * plus one more for every 1 bit. So the count sits between 2000 and 4000 and
   * nowhere near either end for real timecode.
   */
  check('transitions land in the right range', flips > 2000 && flips < 4000, flips);

  // Every rate divides 48 kHz into whole samples per bit, which is why it's used.
  for (const fps of [24, 25, 30]) {
    check(
      `${fps}fps is a whole number of samples per bit`,
      Number.isInteger(LTC_SAMPLE_RATE / fps / 80),
      LTC_SAMPLE_RATE / fps / 80,
    );
  }
}

/* ---------------------- a folder is not a download ------------------------- */

group('cache keys');
{
  const { fileKey, pathFromFileKey, pathOfCached } = await import('../src/lib/idb.ts');

  /*
   * Keys are `path@rev`, and a path can perfectly well contain an @ — a folder
   * named after an email address, say. Splitting on the first one would hand
   * back a truncated path, and a truncated path is never local, so the
   * duplicates it names would never be dropped.
   */
  const cases = [
    ['/songs/fix you [bass].mp3', 'r123'],
    ['/songs/alex@home/fix you [bass].mp3', 'r456'],
  ];
  let allBack = true;
  for (const [path, rev] of cases) {
    if (pathFromFileKey(fileKey(path, rev)) !== path) allBack = false;
  }
  check('an @ in the path is no problem', allBack);
  check('a key with no revision is left alone', pathFromFileKey('/plain/path.wav') === '/plain/path.wav');

  /*
   * Parsing only holds while revisions contain no @, which is true of both
   * sources — so new entries record their path instead of relying on it, and
   * the parse is the fallback for whatever was cached before.
   */
  check(
    'a recorded path is used as given',
    pathOfCached({ key: '/a@b/c.wav@x@y', path: '/a@b/c.wav' }) === '/a@b/c.wav',
  );
  check(
    'and an old entry still resolves',
    pathOfCached({ key: fileKey('/songs/x.wav', 'r1') }) === '/songs/x.wav',
  );
}


group('local files');
{
  /*
   * Reading a file off disk is not fetching it, and the app had conflated the
   * two: a set in the user's own folder was priced in megabytes and copied into
   * browser storage on top. The rule is one line — cache only what arrived over
   * the network — so it is worth stating plainly.
   */
  const shouldCache = (from) => from === 'remote';
  check('a downloaded file is worth keeping', shouldCache('remote'));
  check('a file already on disk is not', !shouldCache('local'));

  // And what the picker should say about each.
  const label = (where) =>
    where === 'disk' ? 'on disk' : where === 'cache' ? 'on device' : 'size';
  check('a file in the folder says so', label('disk') === 'on disk');
  check('a cached one is distinguishable', label('cache') === 'on device');
  check('only a real fetch gets a price', label('remote') === 'size');

  // Nothing to fetch when every part is in the folder.
  const items = [{ where: 'disk' }, { where: 'disk' }, { where: 'disk' }];
  check('an all-local song owes nothing', items.every((i) => i.where === 'disk'));
  const mixed = [{ where: 'disk' }, { where: 'remote' }];
  check('a mixed one still has something to fetch', mixed.some((i) => i.where === 'remote'));
}

/* ------------------------------- running order ----------------------------- */

group('running order');
{
  const { runningOrder, formatClock } = await import('../src/lib/runningOrder.ts');
  const s = (title, durationSec) => ({ id: title, title, durationSec });

  const full = runningOrder([s('Fix You', 304), s('Yellow', 272), s('Clocks', 307)]);
  check('the set starts at nothing', full.entries[0].startsAtSec === 0);
  check('each song follows the last', full.entries[1].startsAtSec === 304, full.entries[1].startsAtSec);
  check('and they accumulate', full.entries[2].startsAtSec === 576, full.entries[2].startsAtSec);
  check('the total is the sum', full.knownSec === 883, full.knownSec);
  check('with nothing missing', full.unknown === 0);

  /*
   * A song nobody has played has no length, and every start time after it would
   * be a guess. Better to show nothing than a number that is quietly wrong.
   */
  const gappy = runningOrder([s('Fix You', 304), s('Clocks', null), s('Yellow', 272)]);
  check('an untimed song is counted', gappy.unknown === 1);
  check('songs before it still have times', gappy.entries[0].startsAtSec === 0);
  check('the untimed one still shows where it starts', gappy.entries[1].startsAtSec === 304);
  check('but nothing after it pretends to know', gappy.entries[2].startsAtSec === null);
  check('the total counts only what is known', gappy.knownSec === 576, gappy.knownSec);

  // A duration of zero is not a duration.
  check('zero is treated as unknown', runningOrder([s('X', 0)]).unknown === 1);
  check('an empty set is empty', runningOrder([]).entries.length === 0);

  check('minutes and seconds', formatClock(304) === '5:04', formatClock(304));
  check('padded seconds', formatClock(65) === '1:05', formatClock(65));
  check('an hour-long set gets an hour', formatClock(3731) === '1:02:11', formatClock(3731));
}

/* -------------------------------- spoken cues ------------------------------ */

group('spoken cues');
{
  const { cueDue, usableVoices } = await import('../src/lib/spokenCues.ts');
  const markers = [
    { id: 'a', name: 'INTRO', bar: 3 },
    { id: 'b', name: 'VERSE 1', bar: 11 },
    { id: 'c', name: 'CHORUS', bar: 43 },
  ];
  const at = (bar, lead = 1) => cueDue(markers, bar, lead)?.name ?? null;

  // Called before it arrives, not as it does — a cue on the downbeat is no use.
  check('nothing to call yet', at(1) === null);
  check('called a bar out', at(2) === 'INTRO', at(2));
  check('still called part way through that bar', at(2.5) === 'INTRO');
  check('silent once it has arrived', at(3) === null);
  check('and through the section', at(3.5) === null);
  check('the next one comes round in its turn', at(10) === 'VERSE 1', at(10));

  // A longer lead reaches further back, and no further.
  check('two bars out reaches further', at(9.5, 2) === 'VERSE 1');
  check('but not beyond the window', at(8.5, 2) === null);

  // Offline voices are preferred: a rehearsal room may have no network.
  const voices = [
    { name: 'Cloudy', lang: 'en-US', localService: false },
    { name: 'Arthur', lang: 'en-GB', localService: true },
    { name: 'Zoe', lang: 'en-US', localService: true },
    { name: 'Amélie', lang: 'fr-FR', localService: true },
  ];
  const usable = usableVoices(voices);
  check('only English voices', usable.every((v) => v.lang.startsWith('en')));
  check('offline ones preferred', usable.length === 2, usable.map((v) => v.name).join(','));
  check('and sorted by name', usable[0].name === 'Arthur');

  // With nothing offline, an online voice beats no voice at all.
  const onlineOnly = usableVoices([{ name: 'Cloudy', lang: 'en-US', localService: false }]);
  check('falls back rather than going silent', onlineOnly.length === 1);
}

/* ------------------------------ preparing a set ---------------------------- */

group('preparing a set');
{
  const { songFolderName, partFileName, lyricsFileFor } = await import('../src/lib/prepare.ts');
  const { parseNameMeta, parseFileName } = await import('../src/lib/scan.ts');
  const { isPrint, isPreparedSet } = await import('../src/lib/prints.ts');

  const project = { creator: 'x', tempo: 111, timeSigNum: 4, timeSigDen: 4, songs: [], warnings: [] };
  const song = {
    title: 'Fix You', raw: '', startBar: 1, endBar: 173, bpm: 136, key: 'Eb',
    durationText: null, tags: [], sections: [], chords: [], lanes: [], stems: [],
    tempoChanges: [{ bar: 91, bpm: 140 }],
    lyrics: [{ bar: 5, text: 'early line' }, { bar: 101, text: 'after the change' }],
  };

  /*
   * The whole architecture rests on this: what Ableton mode writes has to be
   * read back by the same rules a hand-made folder is, with no special case.
   */
  const folder = songFolderName(song, '2026-09-06');
  check('the folder is the title and the day it was rendered', folder === 'Fix You (2026-09-06)', folder);

  const meta = parseNameMeta(folder);
  check('and File mode reads the title back without the date', meta.title === 'Fix You', JSON.stringify(meta));
  const older = parseNameMeta('Fix You {136, Eb, 4-4}');
  check('an older folder still reads its facts', older.title === 'Fix You' && older.bpm === 136 && older.key === 'Eb' && older.timeSig?.den === 4);
  const { folderBaseOf, sameSong, renderDateOf } = await import('../src/lib/preparedSet.ts');
  check('a song is known by its title whichever way its folder is named',
    folderBaseOf('Fix You (2026-09-06)') === 'Fix You' && folderBaseOf('Fix You {136, Eb, 4-4}') === 'Fix You'
      && sameSong('Fix You {136, Eb, 4-4}', 'fix you (2026-09-07)') && sameSong('Fix You (2026-09-06)', 'Fix You'));
  check('a title that ends in brackets of its own keeps them', folderBaseOf('Live (2019)') === 'Live (2019)' && renderDateOf('Live (2019)') === null);
  check('and the day is read off a dated one', renderDateOf('Fix You (2026-09-06)') === '2026-09-06');

  const file = partFileName('Fix You', 'Bass 1');
  check("Ableton's track number is dropped", file === 'Fix You [bass].mp3', file);
  const part = parseFileName(file.replace(/[.]mp3$/, ''));
  check('and it reads back as a part', part.role === 'stem' && part.label === 'bass', `${part.role}/${part.label}`);

  // Lyrics follow the tempo map, or every line after a change drifts.
  const lrc = await lyricsFileFor(song, project).text();
  check('lyrics come out as LRC', /^\[00:07\.06\]early line$/m.test(lrc), lrc.split('\n')[0]);
  check('and follow the tempo map', /^\[02:55\.97\]after the change$/m.test(lrc), lrc.split('\n')[1]);
  check('a song with no words gets no file', lyricsFileFor({ ...song, lyrics: [] }, project) === null);

  // A prepared set is a library; a print is a part of a song. Both are ours.
  const set = '/S/Rehearsal Tool/Sets/Coldplay 2026-08-13/Fix You {136}/Fix You [bass].mp3';
  const print = '/S/Rehearsal Tool/136 Stems/Fix You (no vocal v1 2026-08-13 rehearsaltool).wav';
  check('a prepared set is scanned as a library', isPreparedSet(set) && !isPrint(set));
  check('a print is not', isPrint(print) && !isPreparedSet(print));

  // The wrapper is gone from what is written; both shapes are still read.
  const newSet = '/S/Sets/Coldplay 2026-08-13/Fix You {136}/Fix You [bass].mp3';
  const newPrint = '/S/Prints/136 Stems/Fix You (no vocal v1 2026-08-13 rehearsaltool).wav';
  check('a set at the root is a set', isPreparedSet(newSet) && !isPrint(newSet));
  check('and a print under Prints/ is a print', isPrint(newPrint) && !isPreparedSet(newPrint));
  check('but a stray file beside them is neither',
    !isPrint('/S/Photos/gig.wav') && !isPreparedSet('/S/Photos/gig.wav'));
  check('nor is a Resources sample a set or a print',
    !isPrint('/S/Resources/kick-1a2b3c4d.wav') && !isPreparedSet('/S/Resources/kick-1a2b3c4d.wav'));
}

/* ---------------------- what a folder name can't carry --------------------- */

group('prepared set manifest');
{
  const { applyManifest, isManifestName, setFolderOf } = await import('../src/lib/preparedSet.ts');
  const { songFolderName } = await import('../src/lib/prepare.ts');

  const project = { creator: 'x', tempo: 111, timeSigNum: 4, timeSigDen: 4, songs: [], warnings: [] };
  const alsSong = {
    title: 'Fix You', bpm: 136, key: 'Eb', raw: '', startBar: 1, endBar: 173,
    durationText: null, tags: [], stems: [], lanes: [], lyrics: [],
    tempoChanges: [{ bar: 91, bpm: 140 }],
    sections: [{ bar: 3, text: 'INTRO' }, { bar: 11, text: 'VERSE 1' }],
    chords: [{ bar: 3, text: 'Eb' }],
  };

  const folder = songFolderName(alsSong, '2026-08-13');
  const setFolder = '/S/Rehearsal Tool/Sets/Coldplay 2026-08-13';
  const manifestPath = `${setFolder}/set.json`;
  const manifest = {
    preparedBy: 'rehearsaltool', preparedAt: '2026-08-13', fromSet: '/x.als', paddingSec: 0.0376,
    songs: [{
      folder, title: 'Fix You', firstBarOffsetSec: 0.0376, originalKey: 'Eb',
      tempoMap: alsSong.tempoChanges,
      markers: alsSong.sections.map((s) => ({ bar: s.bar, name: s.text })),
      chords: alsSong.chords,
    }],
  };

  const song = () => ({
    id: 's1', title: 'Fix You', folderPath: `${setFolder}/${folder}`, project: 'x',
    bpm: 136, timeSigNum: 4, timeSigDen: 4, firstBarOffsetSec: 0, transpose: 0,
    variants: [], markers: [], updatedAt: 0, tempoUnset: true,
  });

  check('the manifest is recognised', isManifestName('set.json') && !isManifestName('song.mp3'));
  check('its set folder is known', setFolderOf(manifestPath) === setFolder, setFolderOf(manifestPath));

  const songs = [song()];
  const result = applyManifest(songs, manifestPath, manifest);
  check('it finds its song by folder', result.applied === 1, result.applied);

  // The encoder's lead-in, which is the whole reason this file exists.
  check('the lead-in is applied', songs[0].firstBarOffsetSec === 0.0376, songs[0].firstBarOffsetSec);

  // And the things a folder name has no room for.
  check('the tempo map survives', songs[0].tempoMap?.[0].bpm === 140, JSON.stringify(songs[0].tempoMap));
  check('sections become markers', songs[0].markers.length === 2, songs[0].markers.length);
  check('chords survive', songs[0].chords?.length === 1);
  check('and the tempo is no longer a guess', songs[0].tempoUnset === false);

  // Anything it doesn't mention is left exactly as the scan found it.
  const stranger = [{ ...song(), folderPath: '/S/Somewhere Else/Mine' }];
  check('a song it never mentions is untouched', applyManifest(stranger, manifestPath, manifest).applied === 0);
  check('and keeps its own offset', stranger[0].firstBarOffsetSec === 0);

  // Rubbish in that file must not take the library down with it.
  check('a manifest from elsewhere is ignored', applyManifest([song()], manifestPath, { songs: [] }).applied === 0);
  check('and so is nothing at all', applyManifest([song()], manifestPath, null).applied === 0);
}

/* --------------------------- rendering an arrangement ---------------------- */

group('arrangement');
{
  const { needsRender } = await import('../src/lib/arrangement.ts');
  const clip = (startSec, endSec, sourceStartSec = 0, fadeInSec = 0, fadeOutSec = 0) => ({
    startSec, endSec, sourceStartSec, fadeInSec, fadeOutSec,
  });

  // The common case: one clip, from the top of its file, the whole song. The
  // file already *is* the part, so rendering it would copy it for nothing.
  check('a plain full-length clip needs no render', !needsRender([clip(0, 180)], 180));

  // Everything else does.
  check('two clips do', needsRender([clip(0, 90), clip(90, 180)], 180));
  check('a clip starting late does', needsRender([clip(4, 180)], 180));
  check('a clip ending early does', needsRender([clip(0, 90)], 180));
  check('a clip offset into its file does', needsRender([clip(0, 180, 12)], 180));
  check('a faded clip does', needsRender([clip(0, 180, 0, 0.25)], 180));
  check('a track with nothing on it does', needsRender([], 180));
}

/* ---------------------------- prints find their way ------------------------ */

group('prints');
{
  const { printFolder, findPrints, isPrint, baseTitleOf } = await import('../src/lib/prints.ts');
  const { bounceFileName } = await import('../src/lib/bounce.ts');
  const { versionsOf } = await import('../src/lib/versions.ts');

  const stems = '/C/Set/Song Stems/Fix You 136BPM Stems';
  const v = (id, path, role, versionId) => ({ id, name: id, path, role, rev: 'r', sizeBytes: 1, versionId });
  const source = versionsOf([v('bass', stems + '/Bass.wav', 'stem'), v('drums', stems + '/Drums.wav', 'stem')], 'Fix You');

  // Written into the app's folder, under the version it was made from.
  const folder = printFolder('/C', source[0].name);
  check('prints go under Prints/, named for their version', folder === '/C/Prints/136BPM Stems', folder);

  const name = bounceFileName('Fix You', 'no vocal', 1, new Date(2026, 7, 13));
  const path = folder + '/' + name;
  check('a print is not scanned as a song', isPrint(path));
  check('the song name survives the tags', baseTitleOf(name) === 'Fix You', baseTitleOf(name));

  const found = findPrints([{ path, name, rev: 'r', size: 1, modified: 0 }]);
  check('the print names its song', found[0]?.title === 'Fix You', found[0]?.title);
  check('and the version it came from', found[0]?.versionName === '136BPM Stems', found[0]?.versionName);
  const old = findPrints([{ path: '/C/Rehearsal Tool/136BPM Stems/' + name, name, rev: 'r', size: 1, modified: 0 }]);
  check('a print under the old wrapper still names its version', old[0]?.versionName === '136BPM Stems', old[0]?.versionName);

  // Attached, it joins that version rather than making one of its own.
  const joined = versionsOf(
    [v('bass', stems + '/Bass.wav', 'stem'), v('drums', stems + '/Drums.wav', 'stem'), v('p', path, 'mix', source[0].id)],
    'Fix You',
  );
  check('the print joins its version', joined.length === 1, joined.length);
  check('as a mix alongside the stems', joined[0].stems.length === 2 && joined[0].mixes.length === 1);
  check('and the version keeps its own name', joined[0].name === '136BPM Stems', joined[0].name);
}

/* ------------------------------ printing a mix ----------------------------- */

group('printing a mix');
{
  const { bounceFileName, nextVersion, bounceFolder } = await import('../src/lib/bounce.ts');

  const when = new Date(2026, 7, 13);
  check(
    'the print names itself',
    bounceFileName('Fix You', 'no vocal', 1, when) === 'Fix You (no vocal v1 2026-08-13 rehearsaltool).wav',
    bounceFileName('Fix You', 'no vocal', 1, when),
  );

  // Everything has to stay inside the brackets, or the scan reads the extra
  // words as part of the song's name and splits it off as its own song.
  const name = bounceFileName('Fix You', 'no vocal', 2, when);
  check('nothing escapes the brackets', /^Fix You \(.*\)\.wav$/.test(name), name);

  // Characters that would break a path, or a second bracket, are dropped.
  check(
    'the label is made safe',
    bounceFileName('Fix You', 'a/b (c)', 1, when).includes('(ab c v1'),
    bounceFileName('Fix You', 'a/b (c)', 1, when),
  );

  // Versions count up from prints already in the library.
  const existing = ['Ref Master', 'no vocal v1 2026-08-01 rehearsaltool', 'no vocal v2 2026-08-02 rehearsaltool'];
  check('the next version follows the last', nextVersion(existing, 'no vocal') === 3, nextVersion(existing, 'no vocal'));
  check('a new label starts at one', nextVersion(existing, 'drums only') === 1);
  check('nothing to go on starts at one', nextVersion([], 'no vocal') === 1);

  // Prints land beside the stems, not beside the set file.
  const variants = [
    { path: '/Coldplay/Set.als', role: 'mix' },
    { path: '/Coldplay/Song Stems/Fix You/Bass.wav', role: 'stem' },
  ];
  check(
    'a print lands with the stems',
    bounceFolder(variants, '/Coldplay') === '/Coldplay/Song Stems/Fix You',
    bounceFolder(variants, '/Coldplay'),
  );
  check(
    'with no stems it falls back to the song folder',
    bounceFolder([], '/Coldplay') === '/Coldplay',
  );
}

/* ------------------- what loads, and what the mixer shows ------------------ */

  const { loadedVariants, versionButtons, mixerChannels } = await import('../src/lib/stemMix.ts');
  const song = {
    id: 'x',
    variants: [
      { id: 'ref', name: 'Ref Master', role: 'mix', order: 0 },
      { id: 'gtr', name: 'Guitars', role: 'stem', order: 1 },
      { id: 'drm', name: 'Drums', role: 'stem', order: 2 },
    ],
  };

  // Everything loads; the mixer decides what sounds.
  const st = loadedVariants(song);
  check('the parts and the reference all load', st.length === 3, st.length);
  const channels = mixerChannels(song);
  check('the reference is a mixer channel', channels.length === 3, channels.map((c) => c.id).join(','));
  check('the reference sits below the parts', channels[channels.length - 1].id === 'ref');

  // With stems present the mixes are channels, not exclusive version buttons.
  check('no version buttons when there are stems', versionButtons(song).length === 0);

  const versions = {
    id: 'y',
    variants: [
      { id: 'a', name: 'with vocal', role: 'mix', order: 0 },
      { id: 'b', name: 'no vocal', role: 'mix', order: 1 },
    ],
  };
  check('with no stems every version stays', loadedVariants(versions).length === 2);
  check('and they are offered as buttons', versionButtons(versions).length === 2);

  const stemsOnly = {
    id: 'z',
    variants: [{ id: 'g', name: 'Guitars', role: 'stem', order: 0 }],
  };
  check('with no reference the stems stay', loadedVariants(stemsOnly).length === 1);
}

/* --------------------------- a set as a setlist ---------------------------- */

group('a set as a setlist');
{
  const { syncSetlists } = await import('../src/lib/scan.ts');
  const { setlistFromProject, setlistIdFor, songIdFor, isFromSet } =
    await import('../src/lib/alsImport.ts');

  const setPath = '/Songs/Coldplay Live Project/Coldplay Live.als';
  const project = { songs: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] };
  const fresh = setlistFromProject(setPath, project, () => true);
  // The ids the set's songs are filed under, in the order it plays them.
  const [a, b, c] = ['A', 'B', 'C'].map((t) => songIdFor(setPath, t));

  check('the set names its setlist', fresh.name === 'Coldplay Live', fresh.name);
  check('in arrangement order', fresh.songIds.join() === [a, b, c].join(), fresh.songIds.join());
  check('and only songs the library has', setlistFromProject(setPath, project, (id) => id === b).songIds.join() === b);
  check('a set setlist is recognisable', isFromSet(fresh.id) && fresh.id === setlistIdFor(setPath));
  // The id must not collide with a song's, which is the same path plus a title.
  check("a set's id is not a song's", !fresh.id.includes('::'));

  const live = new Set([a, b, c, 'x']);

  // First scan: the setlist simply appears.
  const first = syncSetlists([], [fresh], live);
  check('a new set arrives as a setlist', first.length === 1 && first[0].songIds.join() === [a, b, c].join());

  // Rescan with the arrangement reordered: the set wins.
  const reordered = { ...fresh, songIds: [c, a, b], updatedAt: 2 };
  const edited = [{ ...fresh, songIds: [b, a], notes: 'capo 3', updatedAt: 1 }];
  const after = syncSetlists(edited, [reordered], live);
  check('the set overrules an edit', after[0].songIds.join() === [c, a, b].join(), after[0].songIds.join());
  check('notes on it are kept', after[0].notes === 'capo 3');
  check('and it counts as changed', after[0].updatedAt === 2);

  // Rescanning an unchanged set must not touch it, or two devices would each
  // keep overwriting the other with an identical setlist.
  const same = syncSetlists([{ ...fresh, updatedAt: 1 }], [{ ...fresh, updatedAt: 999 }], live);
  check('an unchanged set is left alone', same[0].updatedAt === 1, same[0].updatedAt);

  // A renamed set folder renames its setlist.
  const renamed = syncSetlists([{ ...fresh, updatedAt: 1 }], [{ ...fresh, name: 'Coldplay 2026', updatedAt: 5 }], live);
  check('a renamed set renames its setlist', renamed[0].name === 'Coldplay 2026');

  // A set that isn't there any more takes its setlist with it...
  const gone = syncSetlists([{ ...fresh, updatedAt: 1 }], [], new Set(['x']));
  check('a set that has gone takes its setlist', gone.length === 0);

  // ...but one you made by hand is only ever pruned.
  const mine = [{ id: 'mine', name: 'Friday', songIds: [a, 'gone'], updatedAt: 1 }];
  const pruned = syncSetlists(mine, [], live);
  check('a hand-made setlist survives', pruned.length === 1);
  check('missing songs are dropped from it', pruned[0].songIds.join() === a);
  const empty = syncSetlists([{ id: 'mine', name: 'Friday', songIds: ['gone'], updatedAt: 1 }], [], live);
  check('and it stays even when it empties', empty.length === 1);

  // Songs owned by a set must survive a scan that reads the set, since the
  // scan itself does not know about them until they are merged in.
  const withSetSong = syncSetlists(
    [{ id: 'mine', name: 'Friday', songIds: ['als:/x.als::fix you'], updatedAt: 1 }],
    [],
    new Set(['als:/x.als::fix you']),
  );
  check("a set's song is not pruned from a hand-made setlist", withSetSong[0].songIds.length === 1);
}

/* ------------------------------ sets of songs ------------------------------ */

group('sets of songs');
{
  const { allSets, currentSet, otherSetsInProject, setLabel, groupSongs } =
    await import('../src/lib/songSets.ts');

  const song = (id, title, project, artist) => ({ id, title, project, artist });
  const songs = [
    song('k', 'Kerosene', 'Summer Tour', 'BRDGS'),
    song('l', 'Long Way Down', 'Summer Tour', 'BRDGS'),
    song('h', 'Hold The Line', 'Summer Tour', 'Toto'),
    song('f', 'Fix You', 'Unfiled', 'Coldplay'),
  ];
  const library = {
    songs,
    setlists: [
      { id: 'night', name: 'Friday Night', songIds: ['h', 'k', 'gone'] },
      { id: 'other', name: 'Encores', songIds: ['l'] },
    ],
  };

  // Folder sets come from the folders; setlists from the library.
  const sets = allSets(library);
  check('every set is found', sets.length === 5, sets.map((s) => s.name).join(', '));
  check('a setlist keeps its order', sets[0].songs.map((s) => s.id).join() === 'h,k');
  check('a song a rescan removed is skipped', !sets[0].songs.some((s) => !s));
  check(
    'a folder set is alphabetical',
    sets[2].songs.map((s) => s.title).join() === 'Kerosene,Long Way Down',
    sets[2].songs.map((s) => s.title).join(),
  );

  // The setlist you arrived from wins over the folder the song lives in.
  check('the setlist you came from is the set', currentSet(library, 'k', 'night').id === 'setlist:night');
  check('without one, the folder is', currentSet(library, 'k', null).id.startsWith('folder:'));
  check(
    'a setlist that lost this song is ignored',
    currentSet(library, 'f', 'night').name === 'Coldplay',
    currentSet(library, 'f', 'night').name,
  );
  check('a song in no set at all', currentSet(library, 'nobody', null) === null);

  // The way out reaches the rest of the project, and stops there.
  const night = currentSet(library, 'k', 'night');
  const others = otherSetsInProject(sets, night);
  check('the set itself is not offered', !others.some((s) => s.id === night.id));
  check('setlists come first', others[0].kind === 'setlist', others.map((s) => s.name).join(', '));
  check(
    'the project is the boundary',
    !others.some((s) => s.name === 'Coldplay'),
    others.map((s) => s.name).join(', '),
  );
  check('an empty setlist is not offered', !others.some((s) => s.songs.length === 0));

  /*
   * An Ableton set makes two sets of the same songs — the order it plays them
   * in, and the folder they sit in — and the second is not somewhere to go.
   */
  const twice = {
    songs: [song('a', 'A', 'Unfiled', 'Set Folder'), song('b', 'B', 'Unfiled', 'Set Folder')],
    setlists: [{ id: 'als:/x.als', name: 'Set Folder', songIds: ['b', 'a'] }],
  };
  const inSetlist = currentSet(twice, 'a', 'als:/x.als');
  check(
    'the same songs under another name are not offered',
    otherSetsInProject(allSets(twice), inSetlist).length === 0,
    otherSetsInProject(allSets(twice), inSetlist).map((s) => s.name).join(', '),
  );

  // A setlist spanning two projects belongs to both.
  const mixed = { ...library, setlists: [{ id: 'mix', name: 'Mixed', songIds: ['k', 'f'] }] };
  const fromColdplay = currentSet(mixed, 'f', null);
  check(
    'a mixed setlist is reachable from either project',
    otherSetsInProject(allSets(mixed), fromColdplay).some((s) => s.name === 'Mixed'),
  );

  check('a set says where it is', setLabel(sets[2]) === 'Summer Tour · BRDGS', setLabel(sets[2]));
  check('unless it spans projects', setLabel(allSets(mixed)[0]) === 'Mixed', setLabel(allSets(mixed)[0]));

  // Two folders can't collide by having the halves of their names line up.
  const collide = groupSongs([song('1', 'A', 'X', 'Y Z'), song('2', 'B', 'X Y', 'Z')]);
  check('folder names cannot run together', collide.length === 2, collide.length);
}

/* ------------------------------ slates & cues ------------------------------ */

group('slates and cues');
{
  const { slateTitles, cueSections, speakable, slateFileName, defaultVoice } = await import(
    '../src/lib/slates.ts'
  );
  const song = (title, sections = []) => ({ title, sections: sections.map((text) => ({ bar: 1, text })) });

  // A count-in locator repeats the title; that is one song, not two.
  const project = {
    songs: [
      song('Momentum', ['Intro']),
      song('Momentum', ['Verse', 'Chorus']),
      song('Dog in Me', ['Verse', 'chorus', 'Bridge']),
    ],
  };
  check('consecutive same-name spans are one slate', slateTitles(project).join('|') === 'Momentum|Dog in Me',
    slateTitles(project).join('|'));
  check('sections are deduped across songs, case blind',
    cueSections(project).join('|') === 'Intro|Verse|Chorus|Bridge', cueSections(project).join('|'));

  check('underscores are spoken as spaces', speakable('For Eve_IDNAG') === 'For Eve IDNAG');
  check('file names shed what filesystems refuse', slateFileName('A/B: C?') === 'AB C.wav', slateFileName('A/B: C?'));
  check('an empty name still names a file', slateFileName('???') === 'slate.wav');

  const voices = [
    { name: 'Milena', lang: 'ru_RU' },
    { name: 'Samantha', lang: 'en_US' },
    { name: 'Ava (Premium)', lang: 'en_US' },
    { name: 'Daniel (Enhanced)', lang: 'en_GB' },
  ];
  check('premium wins the default', defaultVoice(voices) === 'Ava (Premium)');
  check('enhanced is next', defaultVoice(voices.filter((v) => !/premium/i.test(v.name))) === 'Daniel (Enhanced)');
  check('then samantha', defaultVoice([voices[0], voices[1]]) === 'Samantha');
}

/* ------------------------------ chord track --------------------------------- */

group('writing a chord track');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const { chordClipsFor, addChordTrack } = await import('../src/lib/chordTrack.ts');

  const clip = (beat, text) => `<MidiClip Id="${Math.round(beat) + 1}" Time="${beat}">
      <CurrentStart Value="${beat}" /><CurrentEnd Value="${beat + 4}" />
      <Loop><LoopStart Value="0" /><LoopEnd Value="4" /><StartRelative Value="0" />
        <LoopOn Value="false" /><OutMarker Value="4" /><HiddenLoopStart Value="0" />
        <HiddenLoopEnd Value="4" /></Loop>
      <Name Value="${text}" /><Disabled Value="false" />
      <Notes><KeyTracks><KeyTrack Id="6"><Notes /><MidiKey Value="41" /></KeyTracks></Notes>
      <ControllerTargets.4 Id="${700 + beat}" /><Pointee Id="${800 + beat}" />
    </MidiClip>`;

  const xml = `<Ableton Creator="Live 12">
  <LiveSet>
    <NextPointeeId Value="5000" />
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="One / 2:00 / C / 120BPM" /></Locator>
    <Locator Id="2"><Time Value="32" /><Name Value="Two / 2:00 / G / 120BPM" /></Locator>
    <Locator Id="3"><Time Value="64" /><Name Value="Keyless" /></Locator>
    <Locator Id="4"><Time Value="96" /><Name Value="AUTOSTOP" /></Locator>
    <Tracks>
      <MidiTrack Id="10"><TrackGroupId Value="-1" />
        <Name><EffectiveName Value="Chords +LYRICS" /><UserName Value="Chords +LYRICS" /></Name>
        <AutomationEnvelopes><Envelopes /></AutomationEnvelopes>
        <DeviceChain><MainSequencer><ClipTimeable><ArrangerAutomation><Events>
          ${clip(0, 'C')}${clip(8, 'F')}${clip(32, 'G')}${clip(40, 'C')}${clip(64, 'D')}
        </Events></ArrangerAutomation></ClipTimeable></MainSequencer></DeviceChain>
      </MidiTrack>
      <ReturnTrack Id="59"><LomId Value="0" /></ReturnTrack>
    </Tracks>
  </LiveSet>
</Ableton>`;

  const project = parseAlsXml(xml);
  const { clips, trackName, converted, withoutKey } = chordClipsFor(project);

  check('a set of names is converted to numbers', trackName === 'ADD THIS Nash Chords +LYRICS', trackName);
  check('every song with a key is converted', converted.join() === 'One,Two', converted.join());
  check('a song with no key is named, not guessed at', withoutKey.join() === 'Keyless', withoutKey.join());
  check('only the songs that could be converted contribute clips', clips.length === 4, clips.length);

  // Bars are the set's own ruler, so each song's chords stay inside it.
  check('the first song keeps its bars', clips[0].bar === 1 && clips[1].bar === 3,
    clips.map((c) => c.bar).join());
  check('the second song lands after it', clips[2].bar === 9 && clips[3].bar === 11,
    clips.map((c) => c.bar).join());
  // C in C is 1; G in G is 1; C in G is 4.
  // In brackets, as AbleSet reads a chord on a lyrics track.
  check('each song is counted in its own key, in brackets',
    clips.map((c) => c.text).join(' ') === '[1] [4] [1] [4]', clips.map((c) => c.text).join(' '));
  check('each clip runs to the next chord, a bar at most, so none overlap',
    clips.every((c, i) => c.bars === Math.max(0.25, Math.min(1, (clips[i + 1]?.bar ?? c.bar + 1) - c.bar))), JSON.stringify(clips.map((c) => [c.bar, c.bars])));
  check('and the track says what to do with it', trackName === 'ADD THIS Nash Chords +LYRICS', trackName);

  /*
   * The key a locator never named can be typed in instead. The set's own word
   * still wins where it has one — a supplied key fills gaps, never overrules.
   */
  const asked = chordClipsFor(project, { Keyless: 'A' });
  check('a supplied key brings its song across',
    asked.converted.join() === 'One,Two,Keyless', asked.converted.join());
  check('and nothing is left wanting one', asked.withoutKey.length === 0);
  // Keyless has a lone D at its bar 1; in A that is the 4.
  check('the supplied key is the one counted in',
    asked.clips[asked.clips.length - 1].text === '[4]',
    asked.clips[asked.clips.length - 1].text);
  check('a blank one is skipped, not guessed',
    chordClipsFor(project, { Keyless: '  ' }).withoutKey.join() === 'Keyless');
  check('nonsense is refused rather than assumed',
    chordClipsFor(project, { Keyless: 'banana' }).converted.join() === 'One,Two',
    chordClipsFor(project, { Keyless: 'banana' }).converted.join());
  check("the set's own keys are not overruled by a supplied one",
    chordClipsFor(project, { One: 'F' }).clips[0].text === '[1]',
    chordClipsFor(project, { One: 'F' }).clips[0].text);

  const out = addChordTrack(xml, clips, trackName, project);
  check('the track is written', out.clipsWritten === 4);
  check('named the way AbleSet names one, with what to do with it in front', out.xml.includes('<EffectiveName Value="ADD THIS Nash Chords +LYRICS"'));
  check('the set keeps the track it had', out.xml.includes('<EffectiveName Value="Chords +LYRICS"'));
  const firstTrackName = (xml) => {
    const at = xml.indexOf('<Tracks>');
    const tag = at + xml.slice(at).search(/<(Audio|Midi|Group|Return)Track /);
    return xml.slice(tag).match(/<EffectiveName Value="([^"]*)"/)?.[1];
  };
  check('the new track is the first in the list, and says what to do with it', firstTrackName(out.xml) === 'ADD THIS Nash Chords +LYRICS', firstTrackName(out.xml));
  check('a chord clip carries no notes', /<KeyTracks \/>/.test(out.xml));

  // Live refuses a whole set over one duplicate, dotted tag names included.
  const ids = [...out.xml.matchAll(/<(?:[\w.]*Target[\w.]*|Pointee) Id="(\d+)"/g)].map((m) => Number(m[1]));
  check('no pointee id repeats', new Set(ids).size === ids.length);
  const next = Number((out.xml.match(/<NextPointeeId Value="(\d+)"/) ?? [])[1]);
  check('NextPointeeId clears every id in use', ids.every((id) => id < next), `${Math.max(...ids)} vs ${next}`);

  // And the result reads back as a set with both languages in it.
  const reread = parseAlsXml(out.xml);
  const one = reread.songs.find((s) => s.title === 'One');
  check('the written track reads back as a chord lane',
    (one?.lanes ?? []).some((l) => /nash/i.test(l.name) && l.items.length === 2),
    (one?.lanes ?? []).map((l) => `${l.name}:${l.items.length}`).join());
}

/* -------------------------------- chordpro ---------------------------------- */

group('chordpro charts');
{
  const { chordProFor } = await import('../src/lib/chordPro.ts');
  const project = { tempo: 120, timeSigNum: 4, timeSigDen: 4 };
  const at = (bar, text) => ({ bar, text });

  const song = {
    title: 'Test Song',
    key: 'G',
    bpm: 96,
    sections: [at(1, 'Verse'), at(9, 'Chorus')],
    lyrics: [at(1, 'first line here'), at(3, 'second line here'), at(9, 'the chorus line')],
    chords: [],
    lanes: [
      { id: 'chords', name: 'Chords', kind: 'chords',
        items: [at(1, 'G'), at(3, 'C'), at(5, 'D'), at(9, 'Em')] },
      { id: 'nash', name: 'Nash Chords', kind: 'chords',
        items: [at(1, '1'), at(3, '4'), at(5, '5'), at(9, '6m')] },
    ],
  };

  const cho = chordProFor(song, project);
  const lines = cho.split('\n');

  check('the title is a directive', lines[0] === '{title: Test Song}', lines[0]);
  check('the key is written', cho.includes('{key: G}'));
  check('the tempo is the song\'s own, not the set\'s', cho.includes('{tempo: 96}'));
  check('the time signature is written', cho.includes('{time: 4/4}'));
  check('sections become comments', cho.includes('{comment: Verse}') && cho.includes('{comment: Chorus}'));
  check('a chord sits at the head of its line', cho.includes('[G]first line here'));
  check('a later line takes its own chord', cho.includes('[C]second line here'));
  // Bar 5's D has no words under it, so it stands with the chorus chord.
  check('chords with no words still show', /\[D\]/.test(cho));
  check('names are used, not numbers', !cho.includes('[1]') && !cho.includes('[6m]'));
  check('every chord appears exactly once',
    ['[G]', '[C]', '[D]', '[Em]'].every((c) => cho.split(c).length === 2), cho);

  // A set that only wrote numbers still charts, in numbers.
  const numbersOnly = { ...song, lanes: [song.lanes[1]] };
  check('a numbers-only chart uses the numbers it has',
    chordProFor(numbersOnly, project).includes('[1]'));

  // Nothing to say, nothing written.
  check('a song with no words and no chords makes no chart',
    chordProFor({ title: 'Empty', sections: [], lyrics: [], chords: [], lanes: [] }, project) === null);

  // Chords alone are a chart worth having: an instrumental.
  const instrumental = { ...song, lyrics: [] };
  const inst = chordProFor(instrumental, project);
  check('an instrumental charts its changes', inst.includes('[G]') && inst.includes('[Em]'));
}

/* --------------------------- the SONG track's regions ----------------------- */

group('key from the SONG track');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const clip = (beat, text) => `<MidiClip Id="${Math.round(beat) + 1}"><CurrentStart Value="${beat}" /><Name Value="${text}" /></MidiClip>`;

  /*
   * One locator carries its own facts, one is bare; the SONG track names both.
   * A template region sits between them, as sets tend to keep.
   */
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Told / 3:00 / Eb / 136BPM" /></Locator>
    <Locator Id="2"><Time Value="32" /><Name Value="Bare" /></Locator>
    <Locator Id="3"><Time Value="64" /><Name Value="AUTOSTOP" /></Locator>
    <MidiTrack Id="30"><TrackGroupId Value="-1" /><EffectiveName Value="SONG" />
      ${clip(0, 'Told / 3:00 / C / 100BPM')}
      ${clip(16, 'TEMPLATE / 9:99 / F# / 200BPM')}
      ${clip(32, 'Bare / 4:10 / Am / 84BPM')}
    </MidiTrack>
  </Ableton>`;

  const songs = parseAlsXml(xml).songs;
  const told = songs.find((s) => s.title === 'Told');
  const bare = songs.find((s) => s.title === 'Bare');

  check('a bare locator takes the region\'s key', bare?.key === 'Am', String(bare?.key));
  check('and its tempo', bare?.bpm === 84, String(bare?.bpm));
  check('and its duration', bare?.durationText === '4:10', String(bare?.durationText));
  // The locator is the set's own word on the matter and is not overruled.
  check('a locator that says its key keeps it', told?.key === 'Eb', String(told?.key));
  check('and keeps its tempo', told?.bpm === 136, String(told?.bpm));
  // The template sits inside Told's stretch but names another song entirely.
  check('a stray region does not hand out its key',
    songs.every((s) => s.key !== 'F#'), songs.map((s) => `${s.title}=${s.key}`).join());
}

/* ------------------------------- nashville ---------------------------------- */

group('nashville numbers');
{
  const { parseKey, toNashville, fromNashville, looksNashville, deriveChordLanes } =
    await import('../src/lib/nashville.ts');

  const inKey = (k) => parseKey(k);
  const num = (chord, key) => toNashville(chord, inKey(key));
  const name = (n, key) => fromNashville(n, inKey(key));

  // The plain diatonic run, both ways.
  check('1 4 5 in C', ['C', 'F', 'G'].map((c) => num(c, 'C')).join(' ') === '1 4 5');
  check('and back again', ['1', '4', '5'].map((n) => name(n, 'C')).join(' ') === 'C F G');
  check('the relative minor is 6m', num('Am', 'C') === '6m');
  check('read back as a chord', name('6m', 'C') === 'Am');

  // A key with sharps, and one with flats, each spelled its own way.
  check('sharps in D', ['D', 'F#m', 'A'].map((c) => num(c, 'D')).join(' ') === '1 3m 5');
  check('D spells its 3 with a sharp', name('3m', 'D') === 'F#m');
  check('flats in Eb', ['Eb', 'Ab', 'Bb'].map((c) => num(c, 'Eb')).join(' ') === '1 4 5');
  check('Eb spells its 6 flat, not as D#', name('6', 'Eb') === 'C');
  check('a flat key keeps flats', name('b7', 'Eb') === 'Db', name('b7', 'Eb'));

  // Roman numerals are numbers too, their case the chord's quality.
  check('numerals read as degrees', ['I', 'IV', 'V'].map((n) => name(n, 'E')).join(' ') === 'E A B', ['I', 'IV', 'V'].map((n) => name(n, 'E')).join(' '));
  check('a lowercase numeral is minor', name('ii', 'E') === 'F#m' && name('vi', 'C') === 'Am');
  check('unless its suffix says otherwise', name('vii°', 'E') === 'D#°' && name('ii7', 'E') === 'F#m7' && name('iiø7', 'C') === 'Dø7', [name('vii°', 'E'), name('ii7', 'E'), name('iiø7', 'C')].join(' '));
  check('an accidental before a numeral', name('bVII', 'E') === 'D' && name('bIII', 'A') === 'C');
  check('a numeral with a slash bass', name('IV/5', 'E') === 'A/B' && name('I/3', 'C') === 'C/E');
  check('numerals look like Nashville', looksNashville([{ text: 'I' }, { text: 'V' }, { text: 'ii' }, { text: 'IV' }]));
  check('and a lane of them gets names in its key',
    deriveChordLanes([{ id: 'nash', name: 'CHORDS Nash', kind: 'chords', items: ['I', 'V', 'ii', 'IV'].map((text, i) => ({ bar: i + 1, text })) }], 'E').find((l) => l.id === 'chords-in-key')?.items.map((i) => i.text).join(' ') === 'E B F#m A');

  // Notes outside the scale get an accidental rather than a wrong degree.
  check('a flat seventh', num('Bb', 'C') === 'b7');
  check('a flat third', num('Eb', 'C') === 'b3');
  check('the leading tone is 7', num('B', 'C') === '7');

  // Suffixes are the same word in both languages, so they ride along.
  check('a seventh rides along', num('G7', 'C') === '57', num('G7', 'C'));
  check('so does maj7', num('Cmaj7', 'C') === '1maj7');
  check('and sus4', name('4sus4', 'C') === 'Fsus4');
  check('minor sevenths survive the round trip',
    name(num('Dm7', 'C'), 'C') === 'Dm7', num('Dm7', 'C'));

  // Slash chords convert on both sides of the slash.
  check('a slash chord numbers both parts', num('C/E', 'C') === '1/3');
  check('and names both parts back', name('1/3', 'C') === 'C/E');
  check('an inversion in a flat key', name('1/5', 'Bb') === 'Bb/F', name('1/5', 'Bb'));

  // A minor key counts from its own tonic, which is what a chart in Am means.
  check('the tonic of a minor key is 1m', num('Am', 'Am') === '1m');
  check('its third is b3', num('C', 'Am') === 'b3');
  check('and its fifth is 5m when minor', num('Em', 'Am') === '5m');

  // Round trips over every degree, in a few keys.
  let trips = 0;
  for (const key of ['C', 'G', 'Eb', 'F#', 'Bb']) {
    for (const degree of ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7']) {
      if (num(name(degree, key), key) === degree) trips++;
    }
  }
  check('every degree survives a round trip in five keys', trips === 60, `${trips} of 60`);

  check('nonsense is left alone', num('N.C.', 'C') === null && name('9', 'C') === null);
  check('a chart of numbers is recognised',
    looksNashville([{ text: '1' }, { text: '5m' }, { text: '4' }]));
  check('a chart of names is not',
    !looksNashville([{ text: 'C' }, { text: 'Am' }, { text: 'F' }]));

  /* --------------------- deriving the lane a set lacks --------------------- */

  const lane = (id, name, texts) => ({
    id, name, kind: 'chords',
    items: texts.map((text, i) => ({ bar: i + 1, text })),
  });

  const fromNames = deriveChordLanes([lane('chords', 'Chords', ['C', 'Am', 'F', 'G'])], 'C');
  check('a set with names gains numbers', fromNames.length === 2, fromNames.length);
  check('named the way the set would name it',
    fromNames[1].name === 'Nash Chords' && fromNames[1].kind === 'chords');
  check('with the numbers right',
    fromNames[1].items.map((i) => i.text).join(' ') === '1 6m 4 5');

  const fromNumbers = deriveChordLanes([lane('nash', 'Nash Chords', ['1', '6m', '4', '5'])], 'G');
  check('a set with numbers gains names', fromNumbers.length === 2);
  check('in the song key', fromNumbers[1].name === 'Chords' &&
    fromNumbers[1].items.map((i) => i.text).join(' ') === 'G Em C D',
    fromNumbers[1].items.map((i) => i.text).join(' '));

  const both = deriveChordLanes(
    [lane('chords', 'Chords', ['C']), lane('nash', 'Nash Chords', ['1'])], 'C');
  check('a set that wrote both is left alone', both.length === 2);
  check('no key means no guessing',
    deriveChordLanes([lane('chords', 'Chords', ['C'])], null).length === 1);
  check('a song with no chords is untouched', deriveChordLanes([], 'C').length === 0);
}

/* -------------------------------- chart text -------------------------------- */

group('typed chart text');
{
  const { parseTimedLines, formatTimedLines } = await import('../src/lib/chartText.ts');

  const typed = parseTimedLines('[1] Look at the stars\n[5] Look how they shine');
  check('bracketed bars are read', typed.map((t) => t.bar).join() === '1,5');
  check('and the words survive', typed[1].text === 'Look how they shine');

  // A line without a bar follows the previous by a phrase.
  const flowing = parseTimedLines('[1] First\nSecond\nThird');
  check('unbracketed lines flow by fours', flowing.map((t) => t.bar).join() === '1,5,9',
    flowing.map((t) => t.bar).join());
  check('flow resumes after a reset', parseTimedLines('First\n[9] Ninth\nNext')
    .map((t) => t.bar).join() === '1,9,13');

  check('blank lines are nothing', parseTimedLines('\n[1] A\n\n\n[3] B\n').length === 2);
  check('a bracket with no words is nothing', parseTimedLines('[5]').length === 0);
  check('out-of-order lines sort by bar', parseTimedLines('[9] Later\n[1] Sooner')[0].text === 'Sooner');

  const round = [{ bar: 1, text: 'B' }, { bar: 3.5, text: 'F#m7/A' }];
  check('format and parse round-trip', JSON.stringify(parseTimedLines(formatTimedLines(round))) === JSON.stringify(round));
}

/* ---------------------------- manifest from songs ---------------------------- */

group('manifest from songs');
{
  const { manifestFromSongs, applyManifest, validateManifest } = await import('../src/lib/preparedSet.ts');
  const song = {
    id: 's1', title: 'Yellow', folderPath: 'Covers/Yellow {87}', markers: [],
    firstBarOffsetSec: 0.05, originalKey: 'B',
    tempoMap: [{ bar: 1, bpm: 87 }],
    chords: [{ bar: 1, text: 'B' }],
    lyrics: [{ bar: 5, text: 'Look at the stars' }],
    patchClips: [{ id: 'p1', bar: 5, patch: { channel: 1, program: 12 } }],
  };

  const m = manifestFromSongs([song], 'Covers', null);
  check('what it writes is valid by its own rules', validateManifest(m).ok,
    validateManifest(m).errors.join('; '));
  check('the folder is relative to where the file sits', m.songs[0].folder === 'Yellow {87}');
  check('lone lyrics travel as a lane', m.songs[0].lanes?.[0].kind === 'lyrics');

  // The round trip: what the editor writes, the scan reads back the same.
  const target = [{ id: 's1', folderPath: 'Covers/Yellow {87}', markers: [] }];
  applyManifest(target, 'Covers/set.json', JSON.parse(JSON.stringify(m)));
  check('chords round-trip', target[0].chords?.[0].text === 'B');
  check('key rounds-trips', target[0].originalKey === 'B');
  check('patches round-trip', target[0].patchClips?.[0].id === 'p1');
  check('the lyric lane rounds-trips', target[0].lanes?.[0].items[0].text === 'Look at the stars');

  // One song's edit must not erase another's entry.
  const prev = { preparedBy: 'rehearsaltool', songs: [
    { folder: 'Clocks {131}', title: 'Clocks', firstBarOffsetSec: 0 },
    { folder: 'Yellow {87}', title: 'Old Yellow', firstBarOffsetSec: 0 },
  ] };
  const merged = manifestFromSongs([song], 'Covers', prev);
  check('other songs keep their entries', merged.songs.some((e) => e.folder === 'Clocks {131}'));
  check('the edited song replaces its own', merged.songs.filter((e) => e.folder === 'Yellow {87}').length === 1
    && merged.songs.find((e) => e.folder === 'Yellow {87}')?.title === 'Yellow');
}

/* ---------------------------- manifest validation --------------------------- */

group('manifest validation');
{
  const { validateManifest, applyManifest } = await import('../src/lib/preparedSet.ts');

  // The documented example, verbatim from the README.
  const example = {
    preparedBy: 'rehearsaltool',
    songs: [{
      folder: 'Yellow {87, B, 4-4}',
      title: 'Yellow',
      firstBarOffsetSec: 0,
      originalKey: 'B',
      tempoMap: [{ bar: 1, bpm: 87 }],
      markers: [{ bar: 1, name: 'Intro' }, { bar: 5, name: 'Verse' }],
      chords: [{ bar: 1, text: 'B' }, { bar: 3, text: 'F#' }],
      lanes: [{ id: 'lead', name: 'Lead', kind: 'lyrics', items: [{ bar: 5, text: 'Look at the stars' }] }],
      patchClips: [{ id: 'yellow-verse', bar: 5, patch: { channel: 1, program: 12, source: 'Helix' } }],
    }],
  };
  check('the documented example validates', validateManifest(example).ok,
    validateManifest(example).errors.join('; '));
  check('unknown fields are tolerated',
    validateManifest({ ...example, futureField: 1 }).ok);

  // Mistakes name themselves instead of vanishing.
  const wrongTempo = validateManifest({ ...example, songs: [{ folder: 'X', tempoMap: [{ bar: 'one', bpm: 87 }] }] });
  check('a wrong-typed bar is named', !wrongTempo.ok && wrongTempo.errors[0].includes('tempoMap'),
    wrongTempo.errors.join('; '));
  const noBy = validateManifest({ songs: [] });
  check('a missing preparedBy explains itself', noBy.errors[0].includes('preparedBy'), noBy.errors[0]);
  check('not-an-object is said plainly', validateManifest('nope').errors[0] === 'not a JSON object');

  // And an invalid file applies nothing but reports, rather than half-applying.
  const target = [{ id: 's1', folderPath: 'Root/Yellow {87, B, 4-4}', markers: [] }];
  const out = applyManifest(target, 'Root/set.json', { preparedBy: 'rehearsaltool', songs: [{ folder: 42 }] });
  check('an invalid manifest applies nothing and reports',
    out.applied === 0 && (out.errors?.length ?? 0) > 0, JSON.stringify(out));

  // The folder's name no longer says the tempo or meter; the entry does.
  const dated = [{ id: 't', folderPath: 'Root/Yellow (2026-09-06)', title: 'Yellow (2026-09-06)', markers: [],
    bpm: 120, tempoUnset: true, timeSigNum: 4, timeSigDen: 4, variants: [] }];
  applyManifest(dated, 'Root/set.json', { preparedBy: 'rehearsaltool',
    songs: [{ folder: 'Yellow (2026-09-06)', title: 'Yellow', tempo: 87, timeSignature: '6/8', renderedAt: '2026-09-06T08:00:00.000Z', bars: 40, durationSec: 165.5 }] });
  check('a manifest sets the tempo, meter and title the folder name no longer carries',
    dated[0].bpm === 87 && dated[0].timeSigNum === 6 && dated[0].timeSigDen === 8 && dated[0].title === 'Yellow' && dated[0].tempoUnset === false,
    JSON.stringify(dated[0]));
  const badSig = validateManifest({ preparedBy: 'rehearsaltool', songs: [{ folder: 'x', timeSignature: '4-4' }] });
  check('a meter written the folder way is named as wrong', !badSig.ok && badSig.errors[0].includes('timeSignature'));
}

/* --------------------------- patches through prepare ------------------------ */

group('patches through prepare');
{
  const { applyManifest } = await import('../src/lib/preparedSet.ts');
  const clip = (id, bar, program) => ({ id, bar, patch: { channel: 1, program } });
  const song = (patchClips) => [{
    id: 's1', folderPath: 'Rehearsal Tool/Sets/A Set/Yellow {120}', markers: [], patchClips,
  }];
  const apply = (target, patchClips) =>
    applyManifest(target, 'Rehearsal Tool/Sets/A Set/set.json', {
      preparedBy: 'rehearsaltool',
      songs: [{ folder: 'Yellow {120}', title: 'Yellow', firstBarOffsetSec: 0.05, patchClips }],
    });

  // The same bargain the direct importer strikes, in each direction.
  const replaced = song([clip('old', 1, 5)]);
  apply(replaced, [clip('als:x:0', 3, 9)]);
  check('a manifest with patches replaces the song\'s own',
    replaced[0].patchClips?.length === 1 && replaced[0].patchClips[0].id === 'als:x:0');

  const kept = song([clip('mine', 1, 5)]);
  apply(kept, undefined);
  check('a manifest without any keeps what was programmed in the app',
    kept[0].patchClips?.[0].id === 'mine');

  const empty = song([clip('mine', 1, 5)]);
  apply(empty, []);
  check('an empty list also keeps them, not wipes them',
    empty[0].patchClips?.[0].id === 'mine');

  // Ids come from the set, so a re-publish replaces each clip with itself.
  const twice = song(undefined);
  apply(twice, [clip('als:x:0', 3, 9)]);
  const first = twice[0].patchClips;
  apply(twice, [clip('als:x:0', 3, 9)]);
  check('a re-publish yields the same ids', twice[0].patchClips[0].id === first[0].id);
}

/* ------------------------------- lyric lanes -------------------------------- */

group('lyric lanes through prepare');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const { laneList } = await import('../src/lib/alsImport.ts');
  const { applyManifest } = await import('../src/lib/preparedSet.ts');

  const clip = (beat, text) => `<MidiClip Id="${beat}"><CurrentStart Value="${beat}" /><Name Value="${text}" /></MidiClip>`;
  const lyricTrack = (id, name, clips) => `
    <MidiTrack Id="${id}"><TrackGroupId Value="-1" /><EffectiveName Value="${name}" />
      ${clips.join('')}
    </MidiTrack>`;

  /*
   * AbleSet's convention: a track flagged +LYRICS carries text, and a set may
   * hold several — the words, the chords, a cue for whoever sings the harmony.
   */
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
    <Locator Id="2"><Time Value="32" /><Name Value="AUTOSTOP" /></Locator>
    ${lyricTrack(30, 'Lead +LYRICS', [clip(0, 'first line'), clip(8, 'second line')])}
    ${lyricTrack(31, 'CHORDS + LYRICS', [clip(0, 'C'), clip(4, 'F')])}
    ${lyricTrack(32, 'BV Cues +LYRICS', [clip(16, 'harmony in')])}
  </Ableton>`;

  const song = parseAlsXml(xml).songs[0];
  const lanes = laneList(song) ?? [];
  check('every +LYRICS track becomes a lane', lanes.length === 3, lanes.map((l) => l.name).join());
  // The flag with a space — "CHORDS + LYRICS" — counts the same as without:
  // AbleSet writes +LYRICS, people write the space, and a space should not
  // cost a set its chord chart.
  check('the flag is stripped from the names, spaced or not',
    lanes.map((l) => l.name).join() === 'Lead,CHORDS,BV Cues', lanes.map((l) => l.name).join());
  check('a chord track is known as chords',
    lanes.find((l) => l.name === 'CHORDS')?.kind === 'chords');
  check('a lyric track is known as lyrics',
    lanes.find((l) => l.name === 'BV Cues')?.kind === 'lyrics');
  check('lanes keep their own lines rather than merging',
    lanes.find((l) => l.name === 'Lead')?.items.length === 2);

  // And they survive the trip through a prepared folder's manifest.
  const target = [{ id: 's1', folderPath: 'Rehearsal Tool/Sets/A Set/Yellow {120}', markers: [] }];
  const { applied } = applyManifest(target, 'Rehearsal Tool/Sets/A Set/set.json', {
    preparedBy: 'rehearsaltool',
    songs: [{ folder: 'Yellow {120}', title: 'Yellow', firstBarOffsetSec: 0.05, lanes }],
  });
  check('the manifest is applied', applied === 1);
  check('the prepared song carries every lane', target[0].lanes?.length === 3, target[0].lanes?.length);
  check('with their names intact',
    target[0].lanes?.map((l) => l.name).join() === 'Lead,CHORDS,BV Cues');
}

/* --------------------------- preparing part of a set ------------------------ */

group('preparing part of a set');
{
  const { mergeSongs } = await import('../src/lib/prepare.ts');
  const song = (folder, tempo) => ({ folder, title: folder, firstBarOffsetSec: 0.05, tempoMap: tempo });
  const order = ['Yellow {80}', 'Clocks {131}', 'Fix You {136}'];

  // Preparing one song must not flatten the ones prepared before it: without
  // the merge their tempo maps, sections and chords go out of the manifest.
  const before = [song('Yellow {80}', [{ bar: 1, bpm: 80 }]), song('Clocks {131}', [{ bar: 1, bpm: 131 }])];
  const after = mergeSongs(before, [song('Fix You {136}', [{ bar: 1, bpm: 136 }])], order);
  check('every song is still described', after.length === 3, after.length);
  check('an earlier song keeps its tempo map',
    after.find((s) => s.folder === 'Yellow {80}')?.tempoMap?.[0].bpm === 80);
  check('the manifest reads in set order',
    after.map((s) => s.folder).join(' | ') === order.join(' | '), after.map((s) => s.folder).join(' | '));

  // Preparing a song again replaces its entry rather than doubling it.
  const again = mergeSongs(after, [song('Clocks {131}', [{ bar: 1, bpm: 132 }])], order);
  check('a re-run replaces, not duplicates', again.length === 3, again.length);
  check('and it is the new one that stays',
    again.find((s) => s.folder === 'Clocks {131}')?.tempoMap?.[0].bpm === 132);

  // A song dropped from the set keeps its entry: its files are still there.
  const orphan = mergeSongs([song('Gone {90}')], [song('Yellow {80}')], order);
  check('a song no longer in the set is kept, at the end',
    orphan.map((s) => s.folder).join() === 'Yellow {80},Gone {90}', orphan.map((s) => s.folder).join());

  check('a first run with nothing before it is just what it wrote',
    mergeSongs([], [song('Yellow {80}')], order).length === 1);
}

/* ----------------------------- reference tracks ---------------------------- */

group('reference tracks');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const { partFileName } = await import('../src/lib/prepare.ts');

  /*
   * The shape a real set uses: a REF folder inside the song's group, holding
   * the finished record and pieces of it, beside the band's own parts.
   */
  const track = (id, group, name) => `
    <AudioTrack Id="${id}"><TrackGroupId Value="${group}" /><EffectiveName Value="${name}" />
      <Speaker><LomId Value="0" /><Manual Value="true" /></Speaker>
      <AudioClip Id="1"><CurrentStart Value="0" /><CurrentEnd Value="32" />
        <LoopStart Value="0" /><LoopEnd Value="32" /><StartRelative Value="0" />
        <Disabled Value="false" /><Fade Value="false" />
        <SampleRef><FileRef><RelativePath Value="Samples/${name}.wav" /></FileRef>
        <DefaultSampleRate Value="44100" /></SampleRef>
      </AudioClip>
    </AudioTrack>`;

  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
    <Locator Id="2"><Time Value="32" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /></GroupTrack>
    ${track(11, 10, 'Bass')}
    ${track(12, 10, 'Master')}
    <GroupTrack Id="20"><TrackGroupId Value="10" /><EffectiveName Value="REF" /></GroupTrack>
    ${track(21, 20, 'Ref Master')}
    ${track(22, 20, 'REF VOX')}
    ${track(23, 20, 'Lead Vox 1')}
    ${track(24, 10, 'REF GTR')}
  </Ableton>`;

  const song = parseAlsXml(xml).songs[0];
  const of = (name) => song.stems.find((s) => s.name === name);

  check('every track is kept, reference or not', song.stems.length === 6, song.stems.length);
  check('a REF folder makes its tracks references', of('Lead Vox 1')?.reference === true);
  check('so does the track saying so itself', of('REF GTR')?.reference === true);
  check('the ref master is one too', of('Ref Master')?.reference === true);
  check("the band's own part is not", of('Bass')?.reference === false);
  // "master" alone is the band's master mix, not the record to play against.
  check("nor is the band's master", of('Master')?.reference === false);

  // The label is the only carrier into the prepared folder, so it must say it.
  check('an unmarked reference part is labelled ref',
    partFileName('Yellow', 'Lead Vox 1', true) === 'Yellow [ref lead vox].mp3',
    partFileName('Yellow', 'Lead Vox 1', true));
  check('one that already says ref is left alone',
    partFileName('Yellow', 'REF VOX', true) === 'Yellow [ref vox].mp3',
    partFileName('Yellow', 'REF VOX', true));
  check('the ref master keeps its name, which is what SWITCH looks for',
    partFileName('Yellow', 'Ref Master', true) === 'Yellow [ref master].mp3');
  check('an ordinary part is untouched',
    partFileName('Yellow', 'Bass 1', false) === 'Yellow [bass].mp3');

  // The manifest tells the record itself apart from the record's parts: the
  // website gives the parts faders and switches to the song on its own.
  const { partInfoFor } = await import('../src/lib/prepare.ts');
  const { validateManifest } = await import('../src/lib/preparedSet.ts');
  const refSong = partInfoFor('Yellow', 'REF SONG', true);
  check('the ref song is the record, a mix, and a reference',
    refSong.record === true && refSong.role === 'mix' && refSong.reference === true && refSong.label === 'ref song',
    JSON.stringify(refSong));
  check('so is a ref master', partInfoFor('Yellow', 'Ref Master', true).record === true);
  const refVox = partInfoFor('Yellow', 'REF VOX', true);
  check("the record's vocal is a reference stem, not the record",
    refVox.reference === true && refVox.record === undefined && refVox.role === undefined, JSON.stringify(refVox));
  const full = partInfoFor('Yellow', 'Full Mix', false);
  check("the band's own full mix is a mix but not the record",
    full.role === 'mix' && full.record === undefined && full.reference === undefined, JSON.stringify(full));
  check('an ordinary part says nothing extra', JSON.stringify(partInfoFor('Yellow', 'Bass 1', false)) === '{"label":"bass","name":"bass"}');
  const manifest = (parts) => ({ preparedBy: 'rehearsaltool', preparedAt: 'x', paddingSec: 0, songs: [{ folder: 'Yellow {120}', title: 'Yellow', firstBarOffsetSec: 0, parts }] });
  check('the manifest reader takes the tags', validateManifest(manifest([refSong, refVox, full])).ok, validateManifest(manifest([refSong, refVox, full])).errors.join('; '));
  check('and refuses a role it does not know', !validateManifest(manifest([{ label: 'x', name: 'x', role: 'song' }])).ok);

  // And the library reads those labels the way the player needs.
  const { defaultRole, isReferenceName } = await import('../src/lib/scan.ts');
  check('the ref master is a whole mix with the switch',
    defaultRole('ref master') === 'mix' && isReferenceName('ref master'));
  check('a reference part is a stem you can blend in',
    defaultRole('ref vox') === 'stem' && defaultRole('ref lead vox') === 'stem');
}

/* ------------------------------- slates track ------------------------------ */

group('slates track');
{
  const { addSlatesTrack } = await import('../src/lib/slateTrack.ts');

  // As much of Live's shape as the surgery touches, balanced tags and all.
  const xml = `<Ableton Creator="Ableton Live 12.4">
	<LiveSet>
		<NextPointeeId Value="5000" />
		<Tracks>
			<AudioTrack Id="10" SelectedToolPanel="7">
				<LomId Value="9" />
				<Name>
					<EffectiveName Value="Stems" />
					<UserName Value="Stems" />
				</Name>
				<TrackGroupId Value="-1" />
				<AutomationEnvelopes>
					<Envelopes />
				</AutomationEnvelopes>
				<DeviceChain>
					<Mixer>
						<Speaker><LomId Value="0" /><Manual Value="false" /></Speaker>
						<Volume><LomId Value="0" /><Manual Value="0.5" /><AutomationTarget Id="21"><LockEnvelope Value="0" /></AutomationTarget></Volume>
						<ControllerTargets.4 Id="77" />
						<Pointee Id="88" />
					</Mixer>
					<MainSequencer>
						<Sample>
							<ArrangerAutomation>
								<Events>
									<AudioClip Id="4" Time="8">
										<CurrentStart Value="8" />
										<CurrentEnd Value="24" />
										<Loop>
											<LoopStart Value="0" />
											<LoopEnd Value="16" />
											<StartRelative Value="0" />
											<LoopOn Value="true" />
											<OutMarker Value="16" />
											<HiddenLoopStart Value="0" />
											<HiddenLoopEnd Value="16" />
										</Loop>
										<Name Value="Old Clip" />
										<Disabled Value="false" />
										<IsWarped Value="true" />
										<SampleRef>
											<FileRef><RelativePath Value="Samples/Old.wav" /><Path Value="/x/Old.wav" /></FileRef>
											<DefaultDuration Value="700000" />
											<DefaultSampleRate Value="48000" />
										</SampleRef>
										<IsSongTempoLeader Value="true" />
									</AudioClip>
								</Events>
							</ArrangerAutomation>
						</Sample>
					</MainSequencer>
				</DeviceChain>
			</AudioTrack>
			<ReturnTrack Id="59" SelectedToolPanel="7">
				<LomId Value="0" />
			</ReturnTrack>
		</Tracks>
	</LiveSet>
</Ableton>`;

  const { xml: out, clipsWritten, trackName, reusedTrack } = addSlatesTrack(
    xml,
    [
      { title: 'Opener', fileName: 'Opener.wav', durationSec: 1.5, sizeBytes: 132344, startBeat: 8, bpm: 120 },
      { title: 'At Zero', fileName: 'At Zero.wav', durationSec: 2, sizeBytes: 176444, startBeat: 0, bpm: 100 },
    ],
    1700000000,
  );

  check('both slates are written', clipsWritten === 2);
  check('a new track is made when none is named Slate', trackName === 'ADD THIS Slates' && !reusedTrack);
  check('the slates track is the first in the list', (() => {
    const at = out.indexOf('<Tracks>');
    const tag = at + out.slice(at).search(/<(Audio|Midi|Group|Return)Track /);
    return out.slice(tag).match(/<EffectiveName Value="([^"]*)"/)?.[1] === 'ADD THIS Slates';
  })());
  check('the model track survives untouched', /<EffectiveName Value="Stems"/.test(out));

  // The slate starts on its locator: 1.5s at 120bpm is 3 beats, so 8 to 11.
  check('a slate starts on its locator', /<CurrentStart Value="8" \/>[\s\S]{0,80}<CurrentEnd Value="11"/.test(out));
  check('a song at beat zero slates from zero', /<CurrentStart Value="0" \/>/.test(out));
  check('slate clips are unwarped', (out.match(/<IsWarped Value="false"/g) ?? []).length === 2);
  check('slate paths are project relative', out.includes('<RelativePath Value="Slates/Opener.wav"'));
  check('the muted model plays as a slate track', /<EffectiveName Value="ADD THIS Slates"[\s\S]{0,600}?<Manual Value="true"/.test(out));

  // The pointee namespace: everything fresh, nothing repeated, counter bumped.
  const ids = [...out.matchAll(/<(?:[\w.]*Target[\w.]*|Pointee) Id="(\d+)"/g)].map((m) => Number(m[1]));
  check('no pointee id repeats', new Set(ids).size === ids.length);
  const next = Number((out.match(/<NextPointeeId Value="(\d+)"/) ?? [])[1]);
  check('NextPointeeId clears every id in use', ids.every((id) => id < next), `${Math.max(...ids)} vs ${next}`);
  check('the old counter moved', next > 5000);

  // And the parser this app ships reads the result as a set with a Slates track.
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  check('our own parser still reads the set', parseAlsXml(out).creator === 'Ableton Live 12.4');

  // A set that already has a Slate track keeps it: clips land there, replacing
  // its old arrangement, and its name, fader and routing stay its own.
  const withSlate = xml.replace(/Value="Stems"/g, 'Value="Slate"');
  const reused = addSlatesTrack(
    withSlate,
    [{ title: 'Opener', fileName: 'Opener.wav', durationSec: 1.5, sizeBytes: 132344, startBeat: 8, bpm: 120 }],
    1700000000,
  );
  check('an existing Slate track is reused', reused.reusedTrack && reused.trackName === 'Slate');
  check('no second track appears', (reused.xml.match(/<AudioTrack Id=/g) ?? []).length === 1);
  check('its old clips are replaced', !reused.xml.includes('<Name Value="Old Clip"'));
  check('the new clip is on it', reused.xml.includes('<Name Value="Opener"'));
  check('its own fader is untouched', /<Volume><LomId Value="0" \/><Manual Value="0.5"/.test(reused.xml));
}

/* ----------------------------------- zip ----------------------------------- */

group('zip');
{
  const { buildZip, crc32 } = await import('../src/lib/zip.ts');
  const bytes = (s) => new TextEncoder().encode(s);

  // The IEEE reference value for "123456789".
  check('crc32 matches the standard', crc32(bytes('123456789')) === 0xcbf43926,
    crc32(bytes('123456789')).toString(16));

  const zip = buildZip([
    { name: 'Fix You.wav', data: bytes('abc') },
    { name: 'know you’re watching.wav', data: bytes('defg') },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset);
  check('starts with a local header', view.getUint32(0, true) === 0x04034b50);
  check('ends with the directory record', view.getUint32(zip.length - 22, true) === 0x06054b50);
  check('the directory counts both files', view.getUint16(zip.length - 22 + 10, true) === 2);
  // The curly quote must survive as UTF-8, flagged as such.
  check('names are flagged UTF-8', view.getUint16(6, true) === 0x0800);
  check('the second name survives encoding', new TextDecoder().decode(zip).includes('know you’re watching.wav'));
}

/* --------------------------- checking a set over --------------------------- */

group('checking a set before it matters');
{
  const { parseAlsXml, parseLocatorName } = await import('../src/lib/alsParser.ts');
  const { checkSet, songDurationSec, formatSec, parseTimeText, setlistText } =
    await import('../src/lib/setReview.ts');

  // AbleSet's flags are kept, not merely stripped: the checker needs to know
  // a song was marked to pause or end.
  const flagged = parseLocatorName('Fix You +PAUSE +LOOP:8');
  check('flags survive parsing', flagged.flags.join() === 'PAUSE,LOOP:8', flagged.flags.join());
  check('and still leave the title clean', flagged.title === 'Fix You', flagged.title);

  check('0:32 formats', formatSec(32) === '0:32', formatSec(32));
  check('an hour formats with its hour', formatSec(3725) === '1:02:05', formatSec(3725));
  check('a pinned time reads back', parseTimeText('3:20') === 200);
  check('a non-time reads as nothing', parseTimeText('about 3 min') === null);

  const track = (id, group, name, { warped = false, end = 64 } = {}) => `
    <AudioTrack Id="${id}"><TrackGroupId Value="${group}" /><EffectiveName Value="${name}" />
      <Speaker><LomId Value="0" /><Manual Value="true" /></Speaker>
      <AudioClip Id="1"><CurrentStart Value="0" /><CurrentEnd Value="${end}" />
        <LoopStart Value="0" /><StartRelative Value="0" />
        <Disabled Value="false" /><Fade Value="false" />
        ${warped
          ? '<IsWarped Value="true" /><WarpMarker Id="1" SecTime="0" BeatTime="0" /><WarpMarker Id="2" SecTime="32" BeatTime="64" />'
          : ''}
        <SampleRef><FileRef><RelativePath Value="Samples/${name}.wav" /></FileRef>
        <DefaultSampleRate Value="44100" /></SampleRef>
      </AudioClip>
    </AudioTrack>`;

  /*
   * A set with one of everything wrong: a reference left active, an unwarped
   * stem, a pinned duration the arrangement contradicts, a locator claiming a
   * tempo the automation moved past, and a last song nothing stops.
   */
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <AutomationEnvelope Id="1"><EnvelopeTarget><PointeeId Value="9" /></EnvelopeTarget>
      <Automation><Events><FloatEvent Id="1" Time="64" Value="140" /></Events></Automation>
    </AutomationEnvelope>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow / Eb / 120BPM [1:00]" /></Locator>
    <Locator Id="2"><Time Value="64" /><Name Value="AUTOSTOP" /></Locator>
    <Locator Id="3"><Time Value="64" /><Name Value="Clocks / 90BPM" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /></GroupTrack>
    ${track(11, 10, 'Bass', { warped: true })}
    ${track(12, 10, 'Pads')}
    ${track(13, 10, 'Ref Master', { warped: true })}
    <MidiTrack Id="30"><TrackGroupId Value="-1" /><EffectiveName Value="+SECTIONS" />
      <MidiClip Id="1"><CurrentStart Value="0" /><Name Value="INTRO" /></MidiClip>
    </MidiTrack>
    ${track(40, -1, 'Slates', { end: 4 })}
  </Ableton>`;

  const project = parseAlsXml(xml);
  const [yellow, clocks] = project.songs;

  check('a stop ends the first song', yellow.endsAtStop === true);
  check('nothing ends the last', clocks.endsAtStop === false);
  check('the tempo in force at a song comes from the automation',
    clocks.startBpm === 140, String(clocks.startBpm));
  check('the first song plays at the set tempo', yellow.startBpm === 120, String(yellow.startBpm));
  check('the slate track is seen from outside any group',
    yellow.slateBars.join() === '1', yellow.slateBars.join());
  check('a song without a slate says so', clocks.slateBars.length === 0);
  check('clips know whether they are warped',
    yellow.stems.find((s) => s.name === 'Bass')?.clips[0].warped === true);

  check('16 bars at 120 run 32 seconds', near(songDurationSec(yellow, 4), 32), songDurationSec(yellow, 4));

  const findings = checkSet(project);
  {
    const { TOPIC_LABEL } = await import('../src/lib/setReview.ts');
    check('every finding is filed under a subject with a name',
      findings.length > 0 && findings.every((f) => typeof TOPIC_LABEL[f.topic] === 'string'),
      JSON.stringify([...new Set(findings.map((f) => f.topic))]));
  }
  const about = (song, part) =>
    findings.find((f) => f.song === song && f.message.includes(part));

  check('an active reference recording is a problem',
    about('Yellow', 'Ref Master')?.severity === 'problem');
  check('a long unwarped stem is a warning',
    about('Yellow', 'unwarped')?.severity === 'warning',
    JSON.stringify(findings.filter((f) => f.song === 'Yellow')));
  check('but a warped one is not', !about('Yellow', 'Bass'));
  check('a pinned duration the arrangement contradicts is caught',
    about('Yellow', '1:00')?.message.includes('0:32'), about('Yellow', '1:00')?.message);
  check('a locator claiming a stale tempo is caught',
    about('Clocks', '90 BPM')?.message.includes('140'), about('Clocks', '90 BPM')?.message);
  check('a last song nothing stops is a problem',
    about('Clocks', 'Nothing ever stops it')?.severity === 'problem');
  check('a song without a key is warned for the chord tools',
    about('Clocks', 'No key')?.severity === 'warning');
  check('a missing slate is worth knowing, not alarming',
    about('Clocks', 'No slate')?.severity === 'info');
  check('the song with everything in place draws no key warning', !about('Yellow', 'No key'));
  check('a song the parser found no audio for comes through as a problem',
    findings.some((f) => f.severity === 'problem' && f.message.includes('Clocks')),
    JSON.stringify(findings.filter((f) => f.severity === 'problem')));

  const list = setlistText(project);
  check('the setlist numbers its songs', list.includes('1. Yellow'), list);
  check('with the computed duration, key and tempo', list.includes('0:32, Eb, 120 BPM'), list);
  check('and totals the run', list.includes('2 songs,'), list);
  const some = setlistText(project, new Set(['Clocks']));
  check('a narrowed setlist keeps only the ticked songs',
    !some.includes('Yellow') && some.includes('1. Clocks'), some);
}

/* ---------------------------- the studio's hands ---------------------------- */

group('the file API');
{
  /*
   * The studio's window has no way to the disk, so its server reads and
   * writes for it. What matters is the fence around that: only the studio's
   * own page may ask, only folders the user picked may be touched, and a
   * folder picked once stays picked — no reopening, ever.
   */
  const { createServer } = await import('node:http');
  const { mkdtemp, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileApi } = await import('./studio-files.mjs');

  const scratch = await mkdtemp(join(tmpdir(), 'studio-files-'));
  const songs = join(scratch, 'Songs');
  const elsewhere = join(scratch, 'Elsewhere');
  await mkdir(join(songs, 'Band', 'Yellow'), { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(songs, 'Band', 'Yellow', 'Yellow.als'), 'not really gzip');
  await writeFile(join(songs, 'Band', 'Yellow', 'Yellow [drums].wav'), Buffer.alloc(1000, 7));
  await writeFile(join(songs, '.DS_Store'), 'junk');
  await writeFile(join(elsewhere, 'Secret.als'), 'private');
  await writeFile(join(elsewhere, 'Neighbour.txt'), 'also private');

  // The dialog, answered by the test: whatever `answer` holds, or Cancel.
  let answer = null;
  let asked = null;
  const pick = async (opts) => {
    asked = opts;
    return answer;
  };
  const stateFile = join(scratch, 'state', 'studio-folders.json');
  const serve = (api) =>
    new Promise((ready) => {
      const server = createServer(async (req, res) => {
        if (!(await api(req, res))) {
          res.writeHead(404);
          res.end();
        }
      });
      server.listen(0, '127.0.0.1', () => ready(server));
    });
  let server = await serve(fileApi({ stateFile, pick }));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const studio = { 'x-rehearsal-studio': 'test', 'content-type': 'application/json' };
  const call = (op, body, headers = studio) =>
    fetch(`${base()}/__fs/${op}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const ask = async (op, body) => (await call(op, body)).json();

  check('a plain page is not handled', (await fetch(`${base()}/index.html`)).status === 404);
  check('a call without the studio header is refused',
    (await call('stored', { slot: 'songs' }, { 'content-type': 'application/json' })).status === 403);
  check('a call from a foreign origin is refused',
    (await call('stored', { slot: 'songs' }, { ...studio, origin: 'https://evil.example' })).status === 403);
  check('even one claiming localhost on another port',
    (await call('stored', { slot: 'songs' }, { ...studio, origin: 'http://localhost:9999' })).status === 403);
  check("the server's own page is welcome",
    (await call('stored', { slot: 'songs' }, { ...studio, origin: base() })).status === 200);
  check('as is the dev server, which passes calls along',
    (await call('stored', { slot: 'songs' }, { ...studio, origin: 'http://localhost:5174' })).status === 200);
  check("a preflight gets no allowance",
    !(await fetch(`${base()}/__fs/stored`, { method: 'OPTIONS' })).headers.has('access-control-allow-origin'));
  check('nothing is remembered at first', (await ask('stored', { slot: 'songs' })).dir === null);

  answer = null;
  check('cancelling the dialog is an answer', (await ask('pick', { kind: 'folder', slot: 'songs' })).cancelled === true);
  answer = songs;
  const picked = await ask('pick', { kind: 'folder', slot: 'songs', prompt: 'Where?' });
  check('a picked folder comes back by path and name', picked.dir === songs && picked.name === 'Songs');
  check('the dialog was asked with the prompt', asked.kind === 'folder' && asked.prompt === 'Where?');
  check('and is now remembered', (await ask('stored', { slot: 'songs' })).dir === songs);
  check('on disk, not just in memory', JSON.parse(await readFile(stateFile, 'utf8')).slots.songs === songs);

  const listed = (await ask('list', { dir: songs })).files;
  check('listing walks the tree with relative paths',
    listed.some((f) => f.path === 'Band/Yellow/Yellow.als'), JSON.stringify(listed));
  check('and skips dotfiles', !listed.some((f) => f.name === '.DS_Store'));
  const drums = listed.find((f) => f.name === 'Yellow [drums].wav');
  check('with sizes and dates', drums?.size === 1000 && Number.isInteger(drums?.modified));

  const st = await ask('stat', { dir: songs, path: '/Band/Yellow/Yellow.als' });
  check('stat answers name, size and date', st.name === 'Yellow.als' && st.size === 15);
  check('a leading slash is tolerated', (await ask('exists', { dir: songs, path: '/Band/Yellow/Yellow.als' })).exists);

  // A set or a folder dropped on the app: granted as a pick, no dialog asked.
  asked = null;
  const yellow = join(songs, 'Band', 'Yellow');
  const opened = await ask('open', { path: join(yellow, 'Yellow.als'), slot: 'songs' });
  check('a set handed to the app grants its folder and names the set',
    opened.dir === yellow && opened.name === 'Yellow' && opened.file === 'Yellow.als', JSON.stringify(opened));
  check('with no dialog asked', asked === null);
  check('and that folder is now the songs folder', (await ask('stored', { slot: 'songs' })).dir === yellow);
  check('so its files can be read', (await ask('exists', { dir: yellow, path: 'Yellow.als' })).exists);
  const folderOpened = await ask('open', { path: songs, slot: 'songs' });
  check('a folder handed to the app is granted as picked', folderOpened.dir === songs && folderOpened.file === undefined);
  check('a file that is not a set is refused',
    (await call('open', { path: join(yellow, 'Yellow [drums].wav') })).status === 400);
  check('as is a path that is not there', (await call('open', { path: join(songs, 'nowhere') })).status === 404);
  check('and a slot that is not one', (await call('open', { path: songs, slot: 'attic' })).status === 400);

  // Undoing a prepare: what a run writes over is kept aside, and put back.
  {
    const fsp = await import('node:fs/promises');
    const has = async (p) => !!(await fsp.stat(p).catch(() => null));
    const set = join(songs, 'Sets', 'Fri');
    await fsp.mkdir(join(set, 'Yellow'), { recursive: true });
    await fsp.writeFile(join(set, 'Yellow', 'a.mp3'), 'old drums');
    await fsp.writeFile(join(set, 'set.json'), '{"old":true}');
    check('undo is refused outside a prepared set', (await call('undo-begin', { dir: songs, set: 'Band' })).status === 400);
    check('nothing to undo before a run begins', (await call('undo-restore', { dir: songs, set: 'Sets/Fri', songs: [] })).status === 409);
    check('a set not there yet is made, since the run is about to write it',
      (await ask('undo-begin', { dir: songs, set: 'Sets/Fresh' })).ok === true && (await has(join(songs, 'Sets', 'Fresh', '.undo'))));
    check('a run begins by keeping the manifest', (await ask('undo-begin', { dir: songs, set: 'Sets/Fri' })).ok === true
      && (await fsp.readFile(join(set, '.undo', 'set.json'), 'utf8')) === '{"old":true}');
    check('a song folder is moved aside before it is written', (await ask('undo-keep', { dir: songs, set: 'Sets/Fri', song: 'Yellow' })).kept === true
      && !(await has(join(set, 'Yellow'))) && (await has(join(set, '.undo', 'Yellow', 'a.mp3'))));
    check('a song that had no folder is said so', (await ask('undo-keep', { dir: songs, set: 'Sets/Fri', song: 'New' })).kept === false);
    check('a song name that climbs is refused', (await call('undo-keep', { dir: songs, set: 'Sets/Fri', song: '../x' })).status === 400);
    // The run writes: Yellow again, New for the first time, and the manifest.
    await fsp.mkdir(join(set, 'Yellow'), { recursive: true });
    await fsp.writeFile(join(set, 'Yellow', 'b.mp3'), 'new drums');
    await fsp.mkdir(join(set, 'New'), { recursive: true });
    await fsp.writeFile(join(set, 'New', 'c.mp3'), 'new song');
    await fsp.writeFile(join(set, 'set.json'), '{"old":false}');
    check('the kept folder is hidden from listings', !(await ask('list', { dir: songs })).files.some((f) => f.path.includes('.undo')));
    const put = await ask('undo-restore', { dir: songs, set: 'Sets/Fri', songs: [{ folder: 'Yellow', kept: true }, { folder: 'New', kept: false }] });
    check('undo puts the kept song back and removes the added one', put.restored === 1 && put.removed === 1, JSON.stringify(put));
    check('with its old files and not the new', (await has(join(set, 'Yellow', 'a.mp3'))) && !(await has(join(set, 'Yellow', 'b.mp3'))) && !(await has(join(set, 'New'))));
    check('and the manifest as it was', (await fsp.readFile(join(set, 'set.json'), 'utf8')) === '{"old":true}');
    check('leaving nothing aside', !(await has(join(set, '.undo'))));
  }

  // A dialog opened inside a remembered folder, named by slot rather than path.
  answer = songs;
  await ask('pick', { kind: 'folder', startIn: { slot: 'songs', sub: 'Band' } });
  check('the dialog can start inside a remembered folder', asked.startIn === join(songs, 'Band'), asked.startIn);
  await ask('pick', { kind: 'folder', startIn: { slot: 'songs', sub: 'Nowhere' } });
  check('and falls back when that place is not there', asked.startIn === songs, asked.startIn);
  check('showing a path that is not there in the Finder is refused',
    (await call('reveal', { dir: songs, path: 'Band/Missing' })).status === 404);
  check('a missing file does not exist', (await ask('exists', { dir: songs, path: 'Band/Nope.als' })).exists === false);
  check('and cannot be stat-ed', (await call('stat', { dir: songs, path: 'Band/Nope.als' })).status === 404);

  const read = await call('read', { dir: songs, path: 'Band/Yellow/Yellow [drums].wav' });
  check('read hands back the bytes with a type',
    read.headers.get('content-type') === 'audio/wav' && (await read.arrayBuffer()).byteLength === 1000);
  check('and says how long the whole file is', read.headers.get('x-file-size') === '1000');
  // A stretch of a file: a frozen track's file is the set's length, and a song wants only its own part.
  const part = await call('read', { dir: songs, path: 'Band/Yellow/Yellow [drums].wav', start: 100, end: 164 });
  check('a byte range comes back alone', (await part.arrayBuffer()).byteLength === 64 && part.headers.get('x-file-size') === '1000');
  const past = await call('read', { dir: songs, path: 'Band/Yellow/Yellow [drums].wav', start: 900, end: 5000 });
  check('and is clipped to the file rather than refused', (await past.arrayBuffer()).byteLength === 100);
  const nothing = await call('read', { dir: songs, path: 'Band/Yellow/Yellow [drums].wav', start: 2000, end: 3000 });
  check('a range past the end is empty, not an error', nothing.status === 200 && (await nothing.arrayBuffer()).byteLength === 0);

  check('a library that is not there says so', (await ask('read-json', { dir: songs, path: '.rehearsal-tool.json' })).missing === true);
  const wrote = await ask('write-json', { dir: songs, path: '.rehearsal-tool.json', data: { songs: [1, 2] } });
  check('writing JSON reports a revision', /^\d+-\d+$/.test(wrote.rev), wrote.rev);
  const back = await ask('read-json', { dir: songs, path: '.rehearsal-tool.json' });
  check('and reading it back agrees', back.data.songs.length === 2 && back.rev === wrote.rev);

  const query = new URLSearchParams({ dir: songs, path: 'Prints/Prepared/Yellow/Yellow (full mix).mp3' });
  const put = await fetch(`${base()}/__fs/write?${query}`, {
    method: 'POST',
    headers: { 'x-rehearsal-studio': 'test', 'content-type': 'audio/mpeg' },
    body: Buffer.alloc(3000, 1),
  });
  check('bytes are written where asked, folders and all',
    put.status === 200 && (await readFile(join(songs, 'Prints/Prepared/Yellow/Yellow (full mix).mp3'))).length === 3000);
  check('with no half-written file left beside it',
    !(await ask('list', { dir: songs })).files.some((f) => f.name.endsWith('.part')));

  check('a path that climbs out is refused',
    (await call('read', { dir: songs, path: '../Elsewhere/Secret.als' })).status === 400);
  check('a folder never picked is refused',
    (await call('list', { dir: elsewhere })).status === 403);
  check('so is writing there',
    (await fetch(`${base()}/__fs/write?${new URLSearchParams({ dir: elsewhere, path: 'x' })}`, {
      method: 'POST', headers: { 'x-rehearsal-studio': 'test' }, body: 'x',
    })).status === 403);
  check('a subfolder of a picked one is fine',
    (await ask('list', { dir: join(songs, 'Band') })).files.length === 2);

  // An Ableton set is never written over, whoever asks; the studio's own copies are.
  const putAls = (path) => fetch(`${base()}/__fs/write?${new URLSearchParams({ dir: songs, path })}`, {
    method: 'POST', headers: { 'x-rehearsal-studio': 'test' }, body: 'x',
  });
  check('an existing set is never overwritten', (await putAls('Band/Yellow/Yellow.als')).status === 403);
  check('and is still exactly what it was', (await readFile(join(songs, 'Band/Yellow/Yellow.als'), 'utf8')).length === 15);
  check('a copy of it may be written', (await putAls('Band/Yellow/Yellow (slates).als')).status === 200);
  check('so may a song-info copy, twice', (await putAls('Band/Yellow/Yellow (info).als')).status === 200 && (await putAls('Band/Yellow/Yellow (info).als')).status === 200);
  check('and written again', (await putAls('Band/Yellow/Yellow (slates).als')).status === 200);
  check('a set that is not there yet may be written', (await putAls('Band/Yellow/Brand New.als')).status === 200);
  check('but not a second time', (await putAls('Band/Yellow/Brand New.als')).status === 403);


  answer = join(elsewhere, 'Neighbour.txt');
  check('a lone file of the wrong kind is refused',
    (await call('pick', { kind: 'file', extensions: ['als'] })).status === 400);
  answer = join(elsewhere, 'Secret.als');
  const lone = await ask('pick', { kind: 'file', extensions: ['als'] });
  check('a lone .als is picked with its size and date',
    lone.dir === elsewhere && lone.name === 'Secret.als' && lone.size === 7);
  check('and can be read by name', (await (await call('read', { dir: elsewhere, path: 'Secret.als' })).text()) === 'private');
  check('but its neighbours cannot', (await call('read', { dir: elsewhere, path: 'Neighbour.txt' })).status === 403);
  check('nor can its folder be listed', (await call('list', { dir: elsewhere })).status === 403);

  // A set's samples outside the folder: readable once their folder is
  // allowed, by absolute path, and never written.
  const resources = join(scratch, 'Resources');
  await mkdir(join(resources, 'Click'), { recursive: true });
  await writeFile(join(resources, 'Click', 'MetronomeUp.wav'), 'tick');
  check('an absolute path is refused until its folder is allowed',
    (await call('read', { dir: songs, path: `abs:${join(resources, 'Click', 'MetronomeUp.wav')}` })).status === 403);
  answer = resources;
  const granted = await ask('pick', { kind: 'folder', slot: 'resources', startIn: resources });
  check('a resources folder is a slot of its own, opened where the page suggests',
    granted.dir === resources && asked.startIn === resources, JSON.stringify([granted, asked]));
  check('and then a sample in it reads by absolute path',
    (await (await call('read', { dir: songs, path: `abs:${join(resources, 'Click', 'MetronomeUp.wav')}` })).text()) === 'tick');
  check('but is never written', (await fetch(`${base()}/__fs/write?${new URLSearchParams({ dir: songs, path: `abs:${join(resources, 'x.wav')}` })}`, {
    method: 'POST', headers: { 'x-rehearsal-studio': 'test' }, body: 'x',
  })).status === 400);
  check('and a path outside every folder stays refused',
    (await call('exists', { dir: songs, path: 'abs:/etc/hosts' })).status === 403);
  check('but a file that is nowhere is simply missing, allowed folder or not',
    (await ask('exists', { dir: songs, path: 'abs:/nowhere/at/all.wav' })).exists === false);

  // A new server, the way tomorrow's launch makes one: the folder is still there.
  server.close();
  server = await serve(fileApi({ stateFile, pick }));
  check('a remembered folder survives a restart, nothing to reopen',
    (await ask('stored', { slot: 'songs' })).dir === songs);
  check('and is usable at once', (await ask('exists', { dir: songs, path: 'Band/Yellow/Yellow.als' })).exists);
  check('a folder picked without a slot was not remembered', (await ask('stored', { slot: 'publish' })).dir === null);
  await ask('forget', { slot: 'songs' });
  check('forgetting forgets', (await ask('stored', { slot: 'songs' })).dir === null);
  check('and an unknown slot is refused', (await call('stored', { slot: 'attic' })).status === 400);
  server.close();
}

/* ------------------------ a group named a little differently ------------------------ */

group('a group named a little differently');
{
  /*
   * The locator and the group track are typed separately and drift: an
   * ampersand against "and", a "Play in F" note the group never carried, a
   * group that only began the name. And Live escapes the ampersand in the
   * file, which read back literally matched nothing at all.
   */
  const { parseAlsXml, songKey, decodeXml } = await import('../src/lib/alsParser.ts');
  check('an escaped ampersand reads back as one', decodeXml('Forever &amp; Always') === 'Forever & Always');
  check('"&" and "and" are the same song', songKey('Forever &amp; Always') === songKey('Forever and Always'));
  check('a "Play in" note is not part of the name', songKey('22 Song - Play in F') === '22 song', songKey('22 Song - Play in F'));
  check('nor is a key in braces', songKey('Cruel Summer {A}') === 'cruel summer');

  const audio = (id, group, name, at) => `
    <AudioTrack Id="${id}"><TrackGroupId Value="${group}" /><EffectiveName Value="${name}" />
      <AudioClip Id="1" Time="${at}"><CurrentStart Value="${at}" /><CurrentEnd Value="${at + 32}" />
        <LoopStart Value="0" /><StartRelative Value="0" /><Disabled Value="false" /><Fade Value="false" />
        <SampleRef><FileRef><RelativePath Value="Stems/${name}.wav" /></FileRef><DefaultSampleRate Value="44100" /></SampleRef>
      </AudioClip>
    </AudioTrack>`;
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Forever and Always" /></Locator>
    <Locator Id="2"><Time Value="64" /><Name Value="AUTOSTOP" /></Locator>
    <Locator Id="3"><Time Value="128" /><Name Value="22 Song - Play in F" /></Locator>
    <Locator Id="4"><Time Value="192" /><Name Value="AUTOSTOP" /></Locator>
    <Locator Id="5"><Time Value="256" /><Name Value="Wildest Dreams" /></Locator>
    <Locator Id="6"><Time Value="320" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Forever &amp; Always" /></GroupTrack>
    ${audio(11, 10, 'FA Bass', 0)}
    <GroupTrack Id="20"><TrackGroupId Value="-1" /><EffectiveName Value="22" /></GroupTrack>
    ${audio(21, 20, '22 Bass', 128)}
    <GroupTrack Id="30"><TrackGroupId Value="-1" /><EffectiveName Value="SONG 3" /></GroupTrack>
    ${audio(31, 30, 'WD Bass', 256)}
  </Ableton>`;
  const p = parseAlsXml(xml);
  const stemsOf = (title) => p.songs.find((s) => s.title === title)?.stems.map((s) => s.name).join() ?? 'no song';
  check('an escaped ampersand still finds its group', stemsOf('Forever and Always') === 'FA Bass', stemsOf('Forever and Always'));
  check('a group that only began the name is matched when it is the only one', stemsOf('22 Song - Play in F') === '22 Bass', stemsOf('22 Song - Play in F'));
  check('a group named nothing like the song is matched by where its clips sit', stemsOf('Wildest Dreams') === 'WD Bass', stemsOf('Wildest Dreams'));
  check('and no song is left without audio tracks', p.warnings.length === 0, JSON.stringify(p.warnings));
}

/* --------------------------------- rig tracks --------------------------------- */

group('rig tracks');
{
  /*
   * A set drives the rig from tracks of its own — MIDI to a pedalboard, a
   * video, a timecode file — outside any song's group. Each song gets the
   * clips that play during it, so the player can show what Live will send.
   */
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const midiClip = (id, start, end, name) =>
    `<MidiClip Id="${id}"><CurrentStart Value="${start}" /><CurrentEnd Value="${end}" /><Name Value="${name}" /></MidiClip>`;
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
    <Locator Id="2"><Time Value="64" /><Name Value="AUTOSTOP" /></Locator>
    <Locator Id="3"><Time Value="128" /><Name Value="Clocks" /></Locator>
    <Locator Id="4"><Time Value="192" /><Name Value="AUTOSTOP" /></Locator>
    <MidiTrack Id="50"><TrackGroupId Value="-1" /><EffectiveName Value="MIDI - Quad Cortex" />
      ${midiClip(1, 0, 16, 'Clean')}${midiClip(2, 32, 64, 'Crunch')}${midiClip(3, 128, 192, 'Lead')}${midiClip(4, 160, 164, '')}
    </MidiTrack>
    <MidiTrack Id="51"><TrackGroupId Value="-1" /><EffectiveName Value="+SECTIONS" />
      ${midiClip(1, 0, 8, 'INTRO')}
    </MidiTrack>
    <AudioTrack Id="52"><TrackGroupId Value="-1" /><EffectiveName Value="VIDEO" />
      <AudioClip Id="1"><CurrentStart Value="128" /><CurrentEnd Value="192" /><LoopStart Value="0" /><StartRelative Value="0" />
        <Disabled Value="false" /><Fade Value="false" />
        <SampleRef><FileRef><RelativePath Value="Video/clocks.mp4" /></FileRef><DefaultSampleRate Value="44100" /></SampleRef>
      </AudioClip>
    </AudioTrack>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /></GroupTrack>
    <AudioTrack Id="11"><TrackGroupId Value="10" /><EffectiveName Value="Bass" />
      <AudioClip Id="1"><CurrentStart Value="0" /><CurrentEnd Value="64" /><LoopStart Value="0" /><StartRelative Value="0" />
        <Disabled Value="false" /><Fade Value="false" />
        <SampleRef><FileRef><RelativePath Value="Stems/Bass.wav" /></FileRef><DefaultSampleRate Value="44100" /></SampleRef>
      </AudioClip>
    </AudioTrack>
  </Ableton>`;
  const p = parseAlsXml(xml);
  const [yellow, clocks] = p.songs;
  {
    // A file dropped on a warped track at 85: Live writes only a hairline
    // warp pair, which still states the tempo. Its beat offset is beats.
    const hair = `<Ableton Creator="Live 12">
      <Tempo><Manual Value="85" /><AutomationTarget Id="9" /></Tempo>
      <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
      <Locator Id="1"><Time Value="0" /><Name Value="Cruel Summer" /></Locator>
      <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Cruel Summer" /></GroupTrack>
      <AudioTrack Id="11"><TrackGroupId Value="10" /><EffectiveName Value="REF VOX" />
        <AudioClip Id="1" Time="18"><CurrentStart Value="18" /><CurrentEnd Value="256" />
          <Loop><LoopStart Value="10.102452235264735" /><LoopEnd Value="249" /><StartRelative Value="0" /></Loop>
          <Disabled Value="false" /><Fade Value="false" />
          <IsWarped Value="true" /><PitchCoarse Value="-2" /><PitchFine Value="0" />
          <WarpMarker Id="1" SecTime="0" BeatTime="0" /><WarpMarker Id="2" SecTime="0.0220588235294117661" BeatTime="0.03125" />
          <SampleRef><FileRef><RelativePath Value="Stems/Cruel Summer_Vocals.wav" /></FileRef><DefaultSampleRate Value="48000" /></SampleRef>
        </AudioClip>
      </AudioTrack>
    </Ableton>`;
    const clip = parseAlsXml(hair).songs[0].stems[0].clips[0];
    check('a hairline warp pair still gives the clip its tempo, so its offset is in beats',
      Math.abs(clip.sourceStartSec - 10.102452235264735 / (85 / 60)) < 1e-6, String(clip.sourceStartSec));
    check('a clip transposed in Live says by how much', clip.semitones === -2, String(clip.semitones));
    check('a file at the song\'s own tempo plays at its own speed', clip.speed === 1, String(clip.speed));
  }
  const rig = (song) => song.rigTracks.map((t) => `${t.kind}:${t.name}=${t.clips.map((c) => `${c.startBar}-${c.endBar} ${c.name}`).join(',')}`).join(' | ');
  check('a MIDI track outside the songs is the rig\'s, cut to each song',
    rig(yellow) === 'midi:MIDI - Quad Cortex=1-5 Clean,9-17 Crunch', rig(yellow));
  check('a video track is known for what it is, and an unnamed MIDI clip still counts',
    rig(clocks) === 'midi:MIDI - Quad Cortex=1-17 Lead,9-10 clip | video:VIDEO=1-17 clocks.mp4', rig(clocks));
  check('the sections track is not a rig track', !yellow.rigTracks.some((t) => /SECTIONS/.test(t.name)));
  check('nor is a stem inside a song', !yellow.rigTracks.some((t) => t.name === 'Bass'));
}

/* --------------------------- a plan for one song --------------------------- */

group('a plan for one song');
{
  const { partsFor } = await import('../src/lib/prepare.ts');
  const stem = (name, reference = false) => ({ name, reference, path: `${name}.wav`, regions: null, clips: [] });
  const song = { title: 'Yellow', stems: [stem('REF SONG', true), stem('Drums'), stem('Bass'), stem('Keys'), stem('Vox')] };

  const all = partsFor(song);
  check('without a plan every track is a part of its own', all.length === 5 && all.every((p) => !p.combined));

  const parts = partsFor(song, { print: ['Vox'], combine: [{ name: 'band', stems: ['Drums', 'Bass', 'Keys'] }] });
  check('a plan prints what it names', parts[0].name === 'Vox' && parts[0].stems.length === 1);
  check('and folds the rest into one part', parts[1].name === 'band' && parts[1].stems.length === 3 && parts[1].combined);
  check('leaving out what it skipped', parts.length === 2 && !parts.some((p) => p.name === 'REF SONG'));
  check('a name is matched however it was typed', partsFor(song, { print: ['drums '], combine: [] })[0]?.name === 'Drums');
  check('a group with nothing in it writes nothing', partsFor(song, { print: [], combine: [{ name: 'band', stems: ['Nope'] }] }).length === 0);
}

/* ---------------------------- the mix, as the set has it ---------------------------- */

group('the mix, as the set has it');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const { mixOf, songsFromProject } = await import('../src/lib/alsImport.ts');
  const mixer = (gain, pan) =>
    `<Mixer><Volume><LomId Value="0" /><Manual Value="${gain}" /></Volume><Pan><LomId Value="0" /><Manual Value="${pan}" /></Pan></Mixer>`;
  const audio = (id, group, name, gain, pan, clipGain = 1) => `
    <AudioTrack Id="${id}"><TrackGroupId Value="${group}" /><EffectiveName Value="${name}" />
      ${mixer(gain, pan)}
      <AudioClip Id="1" Time="0"><CurrentStart Value="0" /><CurrentEnd Value="64" />
        <LoopStart Value="0" /><StartRelative Value="0" /><Disabled Value="false" /><Fade Value="false" />
        <SampleVolume Value="${clipGain}" />
        <SampleRef><FileRef><RelativePath Value="Stems/${name}.wav" /></FileRef><DefaultSampleRate Value="44100" /></SampleRef>
      </AudioClip>
    </AudioTrack>`;
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <MainTrack><Mixer><TimeSignature><LomId Value="0" /><Manual Value="201" /><AutomationTarget Id="10"><LockEnvelope Value="0" /></AutomationTarget></TimeSignature></Mixer></MainTrack>
    <AutomationEnvelope Id="1"><EnvelopeTarget><PointeeId Value="10" /></EnvelopeTarget>
      <Automation><Events>
        <EnumEvent Id="1" Time="-63072000" Value="201" />
        <EnumEvent Id="2" Time="96" Value="199" />
        <EnumEvent Id="3" Time="104" Value="201" />
        <EnumEvent Id="4" Time="256" Value="200" />
      </Events></Automation>
    </AutomationEnvelope>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
    <Locator Id="2"><Time Value="128" /><Name Value="AUTOSTOP" /></Locator>
    <Locator Id="3"><Time Value="256" /><Name Value="Waltz" /></Locator>
    <Locator Id="4"><Time Value="304" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" />${mixer(0.5, 0)}</GroupTrack>
    <GroupTrack Id="11"><TrackGroupId Value="10" /><EffectiveName Value="REF" />${mixer(0.8, 0.5)}</GroupTrack>
    ${audio(12, 11, 'Ref Master', 1, 0.25)}
    ${audio(13, 10, 'Bass', 1.5, -1, 0.5)}
    <GroupTrack Id="20"><TrackGroupId Value="-1" /><EffectiveName Value="Waltz" />${mixer(1, 0)}</GroupTrack>
    ${audio(21, 20, 'Drums', 1, 0)}
  </Ableton>`;
  const p = parseAlsXml(xml);
  const [yellow, waltz] = p.songs;
  const ref = yellow.stems.find((s) => s.name === 'Ref Master');
  const bass = yellow.stems.find((s) => s.name === 'Bass');
  check('a track\'s fader is multiplied by every group above it', Math.abs(ref.gain - 0.4) < 1e-9, String(ref.gain));
  check('and its pan has theirs added', Math.abs(ref.pan - 0.75) < 1e-9, String(ref.pan));
  check('a pan cannot go past hard left', bass.pan === -1);
  check('a clip\'s own gain is read', bass.clips[0].gain === 0.5);
  check('the song group\'s fader counts', Math.abs(bass.gain - 0.75) < 1e-9, String(bass.gain));
  check('a stretch in 2/4 inside the song is one caveat, in bars',
    yellow.caveats.length === 1 && /^Bars from 25 to 27 are in 2\/4/.test(yellow.caveats[0]),
    JSON.stringify(yellow.caveats));
  check('a song that starts in 3/4 is counted in 3/4', waltz.timeSigNum === 3 && waltz.timeSigDen === 4 && waltz.caveats.length === 0,
    `${waltz.timeSigNum}/${waltz.timeSigDen} ${JSON.stringify(waltz.caveats)}`);
  check('and its length in bars follows', Math.abs((waltz.endBar - waltz.startBar) - 12) < 1e-6, String(waltz.endBar - waltz.startBar));

  const asVariant = mixOf(bass, bass.clips);
  check('the part carries fader times clip gain, and the pan', Math.abs(asVariant.gain - 0.375) < 1e-9 && asVariant.pan === -1, JSON.stringify(asVariant));
  check('unity and centre are left unsaid', JSON.stringify(mixOf({ gain: 1, pan: 0 }, [])) === '{}');

  const files = ['Ref Master', 'Bass', 'Drums'].map((n) => ({ path: `/Stems/${n}.wav`, name: `${n}.wav`, rev: 'r', size: 1 }));
  const imported = songsFromProject(p, '/Set.als', files, new Map()).songs;
  check('the song keeps its own signature and caveats',
    imported[1].timeSigNum === 3 && imported[0].caveats?.length === 1 && imported[1].caveats === undefined);
}

/* ------------------------ devices and buses, as the set has them ------------------------ */

group('devices and buses');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const { routeOf, songsFromProject } = await import('../src/lib/alsImport.ts');
  const { checkSet } = await import('../src/lib/setReview.ts');
  const knob = (name, value) => `<${name}><LomId Value="0" /><Manual Value="${value}" /></${name}>`;
  const band = (i, on, mode, freq, gain) =>
    `<Bands.${i}><ParameterA>${knob('IsOn', on)}${knob('Mode', mode)}${knob('Freq', freq)}${knob('Gain', gain)}${knob('Q', 0.7071)}</ParameterA></Bands.${i}>`;
  const eq = `<Eq8 Id="1">${knob('On', true)}${band(0, true, 1, 30, 0)}${band(1, true, 3, 200, -3)}${band(2, false, 3, 1000, 6)}${knob('GlobalGain', 0)}</Eq8>`;
  const glue = `<GlueCompressor Id="2">${knob('On', true)}${knob('Threshold', -18)}${knob('Ratio', 1)}${knob('Attack', 3)}${knob('Release', 2)}${knob('Makeup', 2)}${knob('DryWet', 1)}<SideChain>${knob('On', false)}</SideChain></GlueCompressor>`;
  const plugin = `<AuPluginDevice Id="3">${knob('On', true)}<PluginDesc><AuPluginInfo><Name Value="FabFilter Pro-Q 3" /></AuPluginInfo></PluginDesc></AuPluginDevice>`;
  const send = (levels) => `<Sends>${levels.map((l, i) => `<TrackSendHolder Id="${i}"><Send><LomId Value="0" /><Manual Value="${l}" /></Send><Active Value="true" /></TrackSendHolder>`).join('')}</Sends>`;
  const out = (target) => `<AudioOutputRouting><Target Value="${target}" /></AudioOutputRouting>`;
  const mixer = `<Mixer><Volume><LomId Value="0" /><Manual Value="1" /></Volume><Pan><LomId Value="0" /><Manual Value="0" /></Pan></Mixer>`;
  const audio = (id, group, name, target, sends, devices = '') => `
    <AudioTrack Id="${id}"><TrackGroupId Value="${group}" /><EffectiveName Value="${name}" />
      <DeviceChain>${mixer}<Devices>${devices}</Devices>${out(target)}${send(sends)}</DeviceChain>
      <AudioClip Id="1" Time="0"><CurrentStart Value="0" /><CurrentEnd Value="64" />
        <LoopStart Value="0" /><StartRelative Value="0" /><Disabled Value="false" /><Fade Value="false" />
        <SampleRef><FileRef><RelativePath Value="Stems/${name}.wav" /></FileRef><DefaultSampleRate Value="44100" /></SampleRef>
      </AudioClip>
    </AudioTrack>`;
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
    <Locator Id="2"><Time Value="64" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /><DeviceChain>${mixer}<Devices></Devices>${out('AudioOut/Main')}${send([0, 0])}</DeviceChain></GroupTrack>
    ${audio(11, 10, 'Bass', 'AudioOut/None', [0, 1])}
    ${audio(12, 10, 'Vox', 'AudioOut/GroupTrack', [0, 0], plugin)}
    <ReturnTrack Id="50"><EffectiveName Value="A-EDIT" /><DeviceChain>${mixer}<Devices></Devices>${out('AudioOut/External/S0')}${send([0, 0])}</DeviceChain></ReturnTrack>
    <ReturnTrack Id="51"><EffectiveName Value="F-BASS" /><DeviceChain>${mixer}<Devices>${eq}${glue}</Devices>${out('AudioOut/External/S0')}${send([0.5, 0])}</DeviceChain></ReturnTrack>
  </Ableton>`;
  const p = parseAlsXml(xml);
  check('the return buses are read in order', p.buses.map((b) => b.name).join() === 'A-EDIT,F-BASS', p.buses.map((b) => b.name).join());
  const fBass = p.buses[1];
  check('with their devices and knobs',
    fBass.devices.map((d) => d.kind).join() === 'Eq8,GlueCompressor' && fBass.devices[1].params.Threshold === -18 && fBass.devices[1].params.Ratio === 1,
    JSON.stringify(fBass.devices.map((d) => [d.kind, d.params])));
  check('the device\'s own On is read, not its sidechain\'s', fBass.devices[1].on === true);
  check('EQ Eight\'s bands come through', fBass.devices[0].bands.length === 3 && fBass.devices[0].bands[1].gain === -3 && fBass.devices[0].bands[2].on === false,
    JSON.stringify(fBass.devices[0].bands));
  check('a bus that reaches an output says so, and its own sends', fBass.direct && fBass.sends[0].bus === 0 && fBass.sends[0].level === 0.5);
  const [song] = p.songs;
  const bass = song.stems.find((s) => s.name === 'Bass');
  const vox = song.stems.find((s) => s.name === 'Vox');
  check('a track sent to a bus with no output of its own is not direct', bass.direct === false && bass.sends[0].bus === 1 && bass.sends[0].level === 1, JSON.stringify([bass.direct, bass.sends]));
  check('a track that feeds its group reaches the output through it', vox.direct === true);
  check('a plugin is read as a device that cannot be imitated', vox.devices[0].kind === 'AuPluginDevice' && vox.devices[0].supported === false && vox.devices[0].name === 'FabFilter Pro-Q 3', JSON.stringify(vox.devices));
  check('the findings warn about it', checkSet(p).some((f) => f.song === 'Yellow' && /FabFilter/.test(f.message)));
  check('a plain track says nothing about devices', JSON.stringify(routeOf({ devices: [] })) === '{}');
  const files = ['Bass', 'Vox'].map((n) => ({ path: `/Stems/${n}.wav`, name: `${n}.wav`, rev: 'r', size: 1 }));
  const imported = songsFromProject(p, '/Set.als', files, new Map()).songs[0];
  check('a part carries its own track\'s devices and nothing of the bus it is sent to',
    imported.variants.find((v) => v.name === 'Vox')?.devices?.[0].kind === 'AuPluginDevice' &&
      imported.variants.find((v) => v.name === 'Bass')?.devices === undefined &&
      !('buses' in imported));
}

/* ----------------------------- the set's click and cues ----------------------------- */

group("the set's click and cues");
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const { songsFromProject } = await import('../src/lib/alsImport.ts');
  const { isUnpitched } = await import('../src/lib/scan.ts');
  const mixer = (gain) => `<Mixer><Volume><LomId Value="0" /><Manual Value="${gain}" /></Volume><Pan><LomId Value="0" /><Manual Value="0" /></Pan></Mixer>`;
  const clip = (id, start, end, file) => `<AudioClip Id="${id}" Time="${start}"><CurrentStart Value="${start}" /><CurrentEnd Value="${end}" />
        <LoopStart Value="0" /><StartRelative Value="0" /><Disabled Value="false" /><Fade Value="false" />
        <SampleRef><FileRef><RelativePath Value="${file}" /></FileRef><DefaultSampleRate Value="44100" /></SampleRef></AudioClip>`;
  const audio = (id, group, name, gain, clips) => `
    <AudioTrack Id="${id}"><TrackGroupId Value="${group}" /><EffectiveName Value="${name}" /><DeviceChain>${mixer(gain)}</DeviceChain>${clips}</AudioTrack>`;
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
    <Locator Id="2"><Time Value="64" /><Name Value="AUTOSTOP" /></Locator>
    <Locator Id="3"><Time Value="128" /><Name Value="Clocks" /></Locator>
    <Locator Id="4"><Time Value="192" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="90"><TrackGroupId Value="-1" /><EffectiveName Value="CLICK" /><DeviceChain>${mixer(1)}</DeviceChain></GroupTrack>
    ${audio(91, 90, 'CLICK', 0.5, clip(1, 0, 64, 'Click/yellow click.wav') + clip(2, 128, 192, 'Click/clocks click.wav'))}
    <GroupTrack Id="92"><TrackGroupId Value="-1" /><EffectiveName Value="CUE" /><DeviceChain>${mixer(1)}</DeviceChain></GroupTrack>
    ${audio(93, 92, 'Slates', 1, clip(1, 0, 2, 'Slates/Yellow.wav') + clip(2, 128, 130, 'Slates/Clocks.wav'))}
    ${audio(94, 92, 'Pitch Ref', 1, clip(1, 2, 4, 'Cues/yellow pitch.wav'))}
    <MidiTrack Id="95"><TrackGroupId Value="92" /><EffectiveName Value="CUES MIDI" /></MidiTrack>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /><DeviceChain>${mixer(1)}</DeviceChain></GroupTrack>
    ${audio(11, 10, 'Bass', 1, clip(1, 0, 64, 'Stems/Bass.wav'))}
    <GroupTrack Id="20"><TrackGroupId Value="-1" /><EffectiveName Value="Clocks" /><DeviceChain>${mixer(1)}</DeviceChain></GroupTrack>
    ${audio(21, 20, 'Drums', 1, clip(1, 128, 192, 'Stems/Drums.wav'))}
  </Ableton>`;
  const p = parseAlsXml(xml);
  const [yellow, clocks] = p.songs;
  const names = (s) => s.stems.map((x) => x.name).join(',');
  check("the set's click and cues join each song as parts", names(yellow) === 'Bass,Click,Cues', names(yellow));
  const cues = yellow.stems.find((s) => s.name === 'Cues');
  check('every cue track is summed into one part, cut to the song',
    cues.clips.length === 2 && cues.clips.map((c) => c.path.split('/').pop()).join() === 'Yellow.wav,yellow pitch.wav', JSON.stringify(cues.clips.map((c) => c.path)));
  check("the next song gets its own", clocks.stems.find((s) => s.name === 'Cues')?.clips.length === 1 && clocks.stems.find((s) => s.name === 'Click')?.clips[0].path === 'Click/clocks click.wav');
  check("the click track's fader rides into its clips", yellow.stems.find((s) => s.name === 'Click')?.clips[0].gain === 0.5);
  check('neither is ever transposed', isUnpitched('Cues') && isUnpitched('Click'));
  const files = ['Stems/Bass.wav', 'Click/yellow click.wav', 'Slates/Yellow.wav', 'Cues/yellow pitch.wav'].map((f) => ({ path: `/${f}`, name: f.split('/').pop(), rev: 'r', size: 1 }));
  const song = songsFromProject(p, '/Set.als', files, new Map()).songs[0];
  {
    // A click played by a drum rack: MIDI notes, each become its pad's sample,
    // the clip's four-beat loop unrolled across its length. Live keeps a pad's
    // note as 128 minus it, and these samples live outside the project.
    const pad = (id, recv, name, db) => `<DrumBranch Id="${id}"><BranchInfo><ReceivingNote Value="${recv}" /></BranchInfo>
      <DeviceChain><Devices><OriginalSimpler Id="1"><Volume><LomId Value="0" /><Manual Value="${db}" /></Volume>
        <SampleStart Value="0" /><SampleEnd Value="5000" />
        <SampleRef><FileRef><RelativePath Value="../../Resources/Click/${name}.wav" /><Path Value="/Users/x/Resources/Click/${name}.wav" /></FileRef><DefaultSampleRate Value="44100" /></SampleRef>
      </OriginalSimpler></Devices></DeviceChain></DrumBranch>`;
    const note = (time, vel = 100) => `<MidiNoteEvent Time="${time}" Duration="0.25" Velocity="${vel}" IsEnabled="true" />`;
    const rackXml = `<Ableton Creator="Live 12">
      <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
      <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
      <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
      <Locator Id="2"><Time Value="16" /><Name Value="AUTOSTOP" /></Locator>
      <GroupTrack Id="90"><TrackGroupId Value="-1" /><EffectiveName Value="CLICK" /><DeviceChain>${mixer(1)}</DeviceChain></GroupTrack>
      <MidiTrack Id="91"><TrackGroupId Value="90" /><EffectiveName Value="CLICK MIDI" />
        <DeviceChain>${mixer(1)}<Devices><DrumGroupDevice Id="5">${pad(1, 84, 'MetronomeUp', 4)}${pad(2, 82, 'MetronomeDown', -4)}</DrumGroupDevice></Devices></DeviceChain>
        <MidiClip Id="1" Time="0"><CurrentStart Value="0" /><CurrentEnd Value="16" /><LoopStart Value="0" /><LoopEnd Value="4" /><LoopOn Value="true" /><StartRelative Value="0" /><Disabled Value="false" />
          <KeyTrack Id="1"><Notes>${note(0)}</Notes><MidiKey Value="44" /></KeyTrack>
          <KeyTrack Id="2"><Notes>${note(1)}${note(2)}${note(3, 60)}</Notes><MidiKey Value="46" /></KeyTrack>
        </MidiClip>
      </MidiTrack>
      <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /><DeviceChain>${mixer(1)}</DeviceChain></GroupTrack>
      ${audio(11, 10, 'Bass', 1, clip(1, 0, 16, 'Stems/Bass.wav'))}
    </Ableton>`;
    const rp = parseAlsXml(rackXml);
    const click = rp.songs[0].stems.find((s) => s.name === 'Click');
    check('a drum rack click becomes one clip per note, the loop unrolled', click?.clips.length === 16, String(click?.clips.length));
    check('each note plays its pad\'s sample where the note falls',
      click?.clips[0].path.endsWith('MetronomeUp.wav') && click?.clips[1].path.endsWith('MetronomeDown.wav') && click?.clips[4].startBar === 2 && click?.clips[4].path.endsWith('MetronomeUp.wav'),
      JSON.stringify(click?.clips.slice(0, 5).map((c) => [c.startBar, c.path.split('/').pop()])));
    check('at the pad\'s level, scaled a little by velocity',
      Math.abs(click.clips[0].gain - 10 ** (4 / 20) * (0.65 + (0.35 * 100) / 127)) < 1e-6 && click.clips[3].gain < click.clips[1].gain,
      JSON.stringify(click.clips.slice(0, 4).map((c) => c.gain)));
    check('and remembers the sample\'s absolute path', click.clips[0].absPath === '/Users/x/Resources/Click/MetronomeUp.wav');
    const imported = songsFromProject(rp, '/Set.als', [{ path: '/Stems/Bass.wav', name: 'Bass.wav', rev: 'r', size: 1 }], new Map()).songs[0];
    const part = imported.variants.find((v) => v.name === 'Click');
    {
      const { versionsOf } = await import('../src/lib/versions.ts');
      const got = songsFromProject(rp, '/Set.als', [{ path: '/Stems/Bass.wav', name: 'Bass.wav', rev: 'r', size: 1 }], new Map()).songs[0];
      check('everything a set gives a song is one version, whatever folders it came from',
        versionsOf(got.variants, got.title).length === 1, String(versionsOf(got.variants, got.title).length));
    }
    check('a sample outside the folder is named absolutely, read-only, when the folder has no copy',
      part?.clips?.length === 16 && part.clips[0].path === 'abs:/Users/x/Resources/Click/MetronomeUp.wav' && part.path.startsWith('abs:'),
      JSON.stringify([part?.path, part?.clips?.[0]?.path]));
  }
  check('and they import as parts of the song, the cues as one arrangement',
    song.variants.map((v) => v.name).join() === 'Bass,Click,Cues' && song.variants[2].clips?.length === 2 && song.variants[2].role === 'stem',
    JSON.stringify(song.variants.map((v) => [v.name, v.role, v.clips?.length])));
}

/* ------------------------------ opening a run ----------------------------- */

group('opening several songs together');
{
  const { orderForRun } = await import('../src/lib/run.ts');
  const song = (id) => ({ id, title: id });
  const library = {
    ...emptyLibrary(),
    songs: ['a', 'b', 'c', 'd', 'e'].map(song),
    setlists: [
      // What an Ableton set gives: its id is the set's own path.
      { id: 'als:/Sets/Friday.als', name: 'Friday', songIds: ['c', 'a', 'd'] },
      { id: 'other', name: 'Another night', songIds: ['a', 'c', 'd'] },
      { id: 'hand', name: 'By hand', songIds: ['b', 'a'] },
    ],
  };
  const set = '/Sets/Friday.als';

  const run = orderForRun(library, set, ['d', 'a', 'c']);
  check('picked songs open in the set\'s running order, not the order ticked',
    run.songIds.join() === 'c,a,d', run.songIds.join());
  check('the set\'s own order wins over another list holding the same songs',
    run.setlistId === 'als:/Sets/Friday.als', String(run.setlistId));

  const partial = orderForRun(library, set, ['d', 'e', 'c']);
  check('a song no setlist knows follows on the end, never dropped',
    partial.songIds.join() === 'c,d,e', partial.songIds.join());

  const noSet = orderForRun(library, null, ['a', 'b']);
  check('with no set open, whichever list accounts for most of them decides',
    noSet.songIds.join() === 'b,a' && noSet.setlistId === 'hand', JSON.stringify(noSet));

  const loose = orderForRun({ ...library, setlists: [] }, null, ['e', 'd']);
  check('and with no setlist at all they keep the order they were picked in',
    loose.songIds.join() === 'e,d' && loose.setlistId === null, JSON.stringify(loose));

  check('one song is no run', orderForRun(library, set, ['a']).songIds.join() === 'a');
  check('the same song ticked twice is one song',
    orderForRun(library, set, ['a', 'a']).songIds.join() === 'a', orderForRun(library, set, ['a', 'a']).songIds.join());
}

/* --------------------- updating a prepared set in place -------------------- */

group('updating a prepared set without re-rendering');
{
  const { setFor, updatableSong, songInfoFor } = await import('../src/lib/updatePrepared.ts');

  const project = { tempo: 120, timeSigNum: 4, timeSigDen: 4, songs: [] };
  const song = (title, extra = {}) => ({
    title, startBar: 1, endBar: 33, key: 'G', bpm: 120,
    tempoChanges: [], sections: [], chords: [], lyrics: [], stems: [], ...extra,
  });

  // The folder name carries tempo, key and meter, so it is what tells a
  // still-valid song from one whose audio has gone stale.
  const fixYou = song('Fix You');
  const folder = 'Fix You {120, G, 4-4}';
  const manifest = {
    preparedBy: 'rehearsaltool', preparedAt: '2026-01-01T00:00:00.000Z', paddingSec: 0.0261,
    songs: [{ folder, title: 'Fix You', firstBarOffsetSec: 0.0261 }],
  };

  const ok = updatableSong(fixYou, project, manifest, []);
  check('a song whose folder still matches can be updated in place', ok.ok === true);
  check('and its entry comes back, so the lead-in can be carried over',
    ok.ok && ok.entry?.firstBarOffsetSec === 0.0261);

  const faster = song('Fix You', { bpm: 132 });
  const moved = updatableSong(faster, project, manifest, []);
  check('a song whose tempo changed is refused, not half-updated', moved.ok === false);
  check('and the refusal says the audio is stale too',
    !moved.ok && /out of date/.test(moved.reason), !moved.ok ? moved.reason : '');

  const stranger = updatableSong(song('Yellow'), project, manifest, []);
  check('a song never prepared is refused by name',
    !stranger.ok && /never been prepared/.test(stranger.reason));

  check('a song with audio on disk but no manifest entry is still updatable',
    updatableSong(song('Yellow'), project, manifest, ['Yellow {120, G, 4-4}']).ok === true);

  // The lead-in describes files on disk, so it is carried, never re-derived.
  const info = songInfoFor(fixYou, project, '/Sets/Friday.als', { folder, firstBarOffsetSec: 0.0261, renderedAt: '2026-01-01T00:00:00.000Z' });
  check('the manifest entry keeps the lead-in it was given', info.firstBarOffsetSec === 0.0261);
  check('and says the tempo, meter and length the folder name no longer carries',
    info.tempo === 120 && info.timeSignature === '4/4' && info.bars === 33 && info.renderedAt === '2026-01-01T00:00:00.000Z', JSON.stringify(info));
  check('a refresh writes into the folder the files are in, dated as it was',
    updatableSong(fixYou, project, manifest, []).folder === folder);
  const { mergeSongs: merge } = await import('../src/lib/prepare.ts');
  const merged = merge(
    [{ folder: '22 {104, F, 4-4}', title: '22', firstBarOffsetSec: 0 }, { folder: 'Mine (2026-09-01)', title: 'Mine', firstBarOffsetSec: 0 }],
    [{ folder: '22 (2026-09-06)', title: '22', firstBarOffsetSec: 0 }],
    ['Mine', '22'],
  );
  check('a song rendered on a new day replaces its older folder in the manifest',
    merged.length === 2 && merged[0].folder === 'Mine (2026-09-01)' && merged[1].folder === '22 (2026-09-06)',
    JSON.stringify(merged.map((m) => m.folder)));
  check('and is named by the same folder rule the audio was written under',
    info.folder === folder, info.folder);

  // Which prepared folder a set belongs to: the manifest says, not the name.
  const at = (folder, fromSet, preparedAt) => ({
    folder, manifest: { preparedBy: 'rehearsaltool', preparedAt, paddingSec: 0, songs: [], fromSet },
  });
  const sets = [
    at('Rehearsal Tool/Sets/Friday 2026-01-01', 'Friday.als', '2026-01-01T00:00:00.000Z'),
    at('Rehearsal Tool/Sets/Friday 2026-02-01', 'Friday.als', '2026-02-01T00:00:00.000Z'),
    at('Rehearsal Tool/Sets/Saturday 2026-02-02', 'Saturday.als', '2026-02-02T00:00:00.000Z'),
  ];
  check('the set is found by what it was prepared from, not by today\'s date',
    setFor(sets, 'Friday.als')?.folder.endsWith('2026-02-01') === true,
    setFor(sets, 'Friday.als')?.folder);
  check('an .als nothing was prepared from finds nothing',
    setFor(sets, 'Sunday.als') === null);
  check('a manifest with no fromSet is matched by the folder name instead',
    setFor([at('Rehearsal Tool/Sets/Sunday 2026-03-01', undefined, '2026-03-01T00:00:00.000Z')], '/x/Sunday.als')
      ?.folder.endsWith('Sunday 2026-03-01') === true);

  // By content: a renamed set is the same songs, a folder sharing its name is not.
  const keyed = (folder, songs, preparedAt) => ({
    folder,
    manifest: {
      preparedBy: 'rehearsaltool', preparedAt, paddingSec: 0, fromSet: 'Old.als',
      songs: songs.map(([f, k]) => ({ folder: f, audioKey: k })),
    },
  });
  const byContent = [
    keyed('Sets/Renamed', [['Song A', '1.a'], ['Song B', '1.x']], '2026-02-01T00:00:00.000Z'),
    keyed('Sets/Other', [['Song A', '1.a'], ['Song B', '1.b']], '2026-01-01T00:00:00.000Z'),
  ];
  check('a set is found by the songs it holds before the folder named for it',
    setFor(byContent, '/x/Renamed.als', { 'song a': '1.a', 'song b': '1.b' })?.folder === 'Sets/Other');
  check('and by its name when nothing matches by content',
    setFor(byContent, '/x/Renamed.als', { 'song a': '9.9' })?.folder === 'Sets/Renamed');
  check('what it was prepared from still comes first',
    setFor([...byContent, { ...keyed('Sets/Origin', [], '2025-01-01T00:00:00.000Z'),
      manifest: { ...keyed('Sets/Origin', [], '2025-01-01T00:00:00.000Z').manifest, fromSet: '/x/Renamed.als' } }],
      '/x/Renamed.als', { 'song a': '1.a', 'song b': '1.b' })?.folder === 'Sets/Origin');
}

group('the running order the band is given');
{
  const { setlistsFromManifests, preparedSetlistId } = await import('../src/lib/publish.ts');
  const songs = [
    { id: 'sets/fri/22 (2026-09-06)/22', title: '22', folderPath: 'Sets/Fri/22 (2026-09-06)' },
    { id: 'sets/fri/mine (2026-09-06)/mine', title: 'Mine', folderPath: 'Sets/Fri/Mine (2026-09-06)' },
    { id: 'sets/fri/august {90, 4-4}/august', title: 'august', folderPath: 'Sets/Fri/august {90, 4-4}' },
  ];
  const manifest = {
    preparedBy: 'rehearsaltool', preparedAt: '2026-09-06T14:02:23.072Z', paddingSec: 0,
    songs: [{ folder: 'Mine (2026-09-06)' }, { folder: 'august {90, 4-4}' }, { folder: 'Gone (2026-09-01)' }, { folder: '22 (2026-09-06)' }],
  };
  const hand = { id: 'hand', name: 'Acoustic night', songIds: [songs[0].id], updatedAt: 1 };
  const out = setlistsFromManifests(songs, [{ path: 'Sets/Fri/set.json', manifest }], [hand, { id: preparedSetlistId('Sets/Fri'), name: 'old', songIds: [], updatedAt: 0 }]);
  check('a prepared set becomes a setlist in the manifest’s order, not the alphabet’s',
    out.length === 2 && out[1].songIds.join('|') === [songs[1].id, songs[2].id, songs[0].id].join('|'), JSON.stringify(out));
  check('named for its folder and dated from the prepare',
    out[1].name === 'Fri' && out[1].id === 'set:sets/fri' && out[1].updatedAt === Date.parse('2026-09-06T14:02:23.072Z'));
  check('a song the manifest names but the folder lacks is left out', !out[1].songIds.some((id) => /gone/.test(id)));
  check('a setlist made by hand stays; the set’s earlier one is replaced', out[0] === hand);
  check('a manifest not the studio’s makes no setlist',
    setlistsFromManifests(songs, [{ path: 'Sets/X/set.json', manifest: { preparedBy: 'someone', songs: [] } }], []).length === 0);
}

/* ----------------------------- reference stems ---------------------------- */

group('reference stems');
{
  const { isReferenceStem, partName } = await import('../src/lib/stemMix.ts');
  const { partInfoFor } = await import('../src/lib/prepare.ts');
  const { roleForTrack } = await import('../src/lib/alsImport.ts');

  const v = (name, extra = {}) => ({ id: name, name, path: name, rev: 'r', sizeBytes: 1, role: 'stem', ...extra });

  check('a stem named REF is the record\'s', isReferenceStem(v('REF DRUMS')) === true);
  check('and is called by its instrument alone', partName(v('REF DRUMS')) === 'DRUMS', partName(v('REF DRUMS')));
  check('a plain part is not, and keeps its name',
    isReferenceStem(v('BASS')) === false && partName(v('BASS')) === 'BASS');

  // The set knows by the folder what the track name never says.
  const hidden = v('Lead Vox', { reference: true });
  check('a part the set filed under REF is one whatever it calls itself', isReferenceStem(hidden) === true);
  check('and keeps its whole name, there being no word to take off',
    partName(hidden) === 'Lead Vox', partName(hidden));

  // Renaming must not be able to launder it.
  check('a reference stem renamed to hide the word is still one',
    isReferenceStem(v('drums', { reference: true })) === true);

  // The reference master is a mix, and SWITCH's own thing — never this.
  check('the reference master is not a reference stem',
    isReferenceStem(v('REF SONG', { role: 'mix' })) === false);
  check('and the set agrees it is a whole mix',
    roleForTrack('REF SONG') === 'mix' && roleForTrack('REF DRUMS') === 'stem');

  // What the website is handed.
  const refPart = partInfoFor('Fix You', 'REF DRUMS', true);
  check('the manifest gives the label the file actually carries',
    refPart.label === 'ref drums', refPart.label);
  check('with the name to put on the fader, and the fact said separately',
    refPart.name === 'drums' && refPart.reference === true, JSON.stringify(refPart));

  const plain = partInfoFor('Fix You', 'Bass 1', false);
  check('an ordinary part says nothing extra',
    plain.label === 'bass' && plain.name === 'bass' && plain.reference === undefined,
    JSON.stringify(plain));

  const already = partInfoFor('Fix You', 'REF VOX', true);
  check('a label that already says ref is not made to say it twice',
    already.label === 'ref vox' && already.name === 'vox', JSON.stringify(already));
}

/* ---------------------- the click and cues as sampler parts ---------------------- */

group('the click and cues as sampler parts');
{
  const { isSetStem, samplerPartFor, sampleFileName } = await import('../src/lib/prepare.ts');
  const { manifestFromSongs, validateManifest } = await import('../src/lib/preparedSet.ts');
  const { isProjectScaffolding } = await import('../src/lib/scan.ts');

  const clip = (path, startBar, extra = {}) => ({
    path, startBar, endBar: startBar + 16, sourceStartSec: 0, disabled: false, fadeInSec: 0, fadeOutSec: 0,
    warped: false, semitones: 0, speed: 1, gain: 1, ...extra,
  });
  const stem = (clips, extra = {}) => ({
    name: 'Click', reference: false, gain: 1, pan: 0, devices: [], sends: [], direct: true,
    path: clips[0]?.path ?? '', regions: null, clips, ...extra,
  });

  check('the set\'s click and cues are what become sampler parts, by name',
    isSetStem({ name: 'Click' }) && isSetStem({ name: 'CUES' }) && !isSetStem({ name: 'Bass' }));

  // A drum-rack click: notes keep their number, their velocity, and the pad's level.
  const rack = samplerPartFor(stem([
    clip('Samples/MetronomeUp.wav', 1, { note: 44, velocity: 127, padGain: 1.58 }),
    clip('Samples/MetronomeDown.wav', 1.25, { note: 46, velocity: 100, padGain: 1 }),
    clip('Samples/MetronomeDown.wav', 1.5, { note: 46, velocity: 100, padGain: 1, disabled: true }),
    clip('Samples/MetronomeDown.wav', 1.75, { note: 46, velocity: 100, padGain: 1 }),
  ]));
  check('every note that plays is written, a disabled one is not', rack.notes.length === 3, String(rack?.notes.length));
  check('a note keeps its MIDI number', rack.notes[0].note === 44 && rack.notes[1].note === 46);
  check('velocity is the raw MIDI velocity over 127, and absent when full',
    rack.notes[0].velocity === undefined && Math.abs(rack.notes[1].velocity - 100 / 127) < 1e-9,
    JSON.stringify(rack.notes.map((n) => n.velocity)));
  check('the pad\'s level rides on the sample, apart from velocity',
    rack.sources.get('samples/metronomeup.wav').gain === 1.58 && rack.sources.size === 2);

  // An audio cue track has no notes, so it is given some.
  const cues = samplerPartFor(stem([
    clip('Cues/Chorus.wav', 4, { gain: 0.25 }),
    clip('Cues/Verse.wav', 12),
    clip('cues/chorus.wav', 20),
  ], { name: 'Cues' }));
  check('a cue track\'s files are numbered from 36, one note per distinct file',
    cues.notes.map((n) => n.note).join() === '36,37,36', cues.notes.map((n) => n.note).join());
  check('and a cue\'s clip gain goes into velocity, square-rooted, since the player squares it',
    Math.abs(cues.notes[0].velocity - 0.5) < 1e-9 && cues.notes[1].velocity === undefined,
    JSON.stringify(cues.notes.map((n) => n.velocity)));

  const gated = samplerPartFor(stem([clip('a.wav', 1, { note: 44, velocity: 127 }), clip('a.wav', 5, { note: 44, velocity: 127 })],
    { regions: [{ startBar: 1, endBar: 3 }] }));
  check('a mute region silences the notes inside it', gated.notes.length === 1, String(gated?.notes.length));
  check('a track with nothing playing is no part at all', samplerPartFor(stem([])) === null);

  check('a sample is named for what it is: its own name plus a hash of its bytes, under Resources/',
    sampleFileName('Some/Folder/kick.wav', '1a2b3c4d5e6f') === 'Resources/kick-1a2b3c4d.wav',
    sampleFileName('Some/Folder/kick.wav', '1a2b3c4d5e6f'));
  {
    const { isSlateSource } = await import('../src/lib/prepare.ts');
    check('a sample off a Slates track, or out of a Slates folder, is a slate',
      isSlateSource({ path: 'Cues/x.wav', track: 'Slates' }) && isSlateSource({ path: 'Slates/Fix You.wav' }) && !isSlateSource({ path: 'Cues/Chorus.wav', track: 'Cues' }));
    check('and is filed under Resources/slates/',
      sampleFileName('Slates/Fix You.wav', 'abcdef0123', 'slates') === 'Resources/slates/Fix You-abcdef01.wav',
      sampleFileName('Slates/Fix You.wav', 'abcdef0123', 'slates'));
    const slated = samplerPartFor(stem([clip('Slates/Fix You.wav', 1, { track: 'Slates' })], { name: 'Cues' }));
    check('the track a cue came from travels with it', slated.sources.get('slates/fix you.wav').track === 'Slates');
  }
  check('and Resources/ is a folder the scan never reads',
    isProjectScaffolding('Resources/kick-1a2b3c4d.wav') && !isProjectScaffolding('Rehearsal Tool/Sets/x/a.mp3'));

  // Editing a song in the studio rewrites its manifest entry from the library,
  // which knows nothing of files on disk. What describes them must survive.
  const samplerPart = { label: 'click', name: 'click', kind: 'sampler', id: 'x#sampler:click', role: 'stem', rev: 'r',
    samples: [{ note: 44, path: 'Resources/a.wav', rev: 'h', sizeBytes: 1 }], notes: rack.notes };
  const previous = { preparedBy: 'rehearsaltool', preparedAt: 'x', paddingSec: 0.02,
    songs: [{ folder: 'Fix You {120, G, 4-4}', title: 'Fix You', firstBarOffsetSec: 0.02,
      parts: [{ label: 'bass', name: 'bass' }, samplerPart] }] };
  const song = { id: 's', title: 'Fix You', folderPath: 'Rehearsal Tool/Sets/Friday/Fix You {120, G, 4-4}', variants: [],
    markers: [{ id: 'm', name: 'Verse', bar: 5 }], bpm: 120, timeSigNum: 4, timeSigDen: 4, firstBarOffsetSec: 0.02, transpose: 0 };
  const rewritten = manifestFromSongs([song], 'Rehearsal Tool/Sets/Friday', previous);
  check('a rewrite from the library keeps the parts it cannot know, sampler ones included',
    rewritten.songs[0].parts?.length === 2 && rewritten.songs[0].parts[1].kind === 'sampler',
    JSON.stringify(rewritten.songs[0].parts?.map((p) => p.kind ?? 'audio')));

  const ok = validateManifest({ preparedBy: 'rehearsaltool', preparedAt: 'x', paddingSec: 0, songs: [{ folder: 'f', parts: [samplerPart] }] });
  check('a manifest with a sampler part validates', ok.ok, ok.errors.join('; '));
  const empty = validateManifest({ preparedBy: 'rehearsaltool', preparedAt: 'x', paddingSec: 0,
    songs: [{ folder: 'f', parts: [{ ...samplerPart, notes: [] }] }] });
  check('and a sampler with no notes is named, not swallowed', !empty.ok && /no "notes"/.test(empty.errors.join()), empty.errors.join());
  const hot = validateManifest({ preparedBy: 'rehearsaltool', preparedAt: 'x', paddingSec: 0,
    songs: [{ folder: 'f', parts: [{ ...samplerPart, notes: [{ bar: 1, note: 44, velocity: 1.5 }] }] }] });
  check('as is a velocity outside 0..1', !hot.ok && /velocity/.test(hot.errors.join()));
}

/* ------------------------------ naming a set ------------------------------ */

group('naming a prepared set');
{
  const { safeSetName, defaultSetName } = await import('../src/lib/setName.ts');
  check('a name loses what a folder cannot carry, and keeps the rest',
    safeSetName('Friday: at the Dock / late?') === 'Friday at the Dock late', safeSetName('Friday: at the Dock / late?'));
  check('runs of space collapse and the ends are trimmed', safeSetName('  Friday   night  ') === 'Friday night');
  check('an empty name is empty, so the default can stand in', safeSetName('  ') === '');
  check('the default is the set\'s file name and the day',
    /^TS TEST FOR RTS \d{4}-\d{2}-\d{2}$/.test(defaultSetName('/x/TS TEST FOR RTS.als')), defaultSetName('/x/TS TEST FOR RTS.als'));
  check('and a set with no path is called Set', /^Set \d{4}-/.test(defaultSetName(null)));
}

/* ------------------------------ a whole run's bar ------------------------------ */

group('overall progress of a prepare');
{
  const { overallProgress } = await import('../src/lib/prepare.ts');
  const at = (songIndex, partIndex, stage, ratio = 0) =>
    overallProgress({ songIndex, songCount: 2, songTitle: '', partName: '', partIndex, partCount: 2, stage, ratio });
  check('starts at nothing', at(1, 1, 'reading') === 0);
  check('halfway through encoding part 1 of 2 in song 1 of 2 is a little over a tenth',
    Math.abs(at(1, 1, 'encoding', 0.5) - 0.1375) < 1e-9, String(at(1, 1, 'encoding', 0.5)));
  const steps = [at(1,1,'reading'), at(1,1,'rendering'), at(1,1,'encoding',0.2), at(1,1,'encoding',0.9), at(1,1,'writing'), at(1,2,'reading'), at(1,2,'encoding',0.5), at(2,1,'reading'), at(2,2,'writing')];
  check('and never goes backwards', steps.every((v, i) => i === 0 || v >= steps[i - 1]), steps.map((v) => v.toFixed(3)).join(' '));
  check('the second song starts at half', Math.abs(at(2, 1, 'reading') - 0.5) < 1e-9);
  check('done is full', overallProgress({ songIndex: 2, songCount: 2, songTitle: '', partName: '', partIndex: 0, partCount: 0, stage: 'done', ratio: 1 }) === 1);
  const shifting = (ratio) =>
    overallProgress({ songIndex: 1, songCount: 2, songTitle: '', partName: '', partIndex: 0, partCount: 2, stage: 'shifting', ratio, shiftShare: 0.5 });
  check('a song with shifts spends its first half of the bar on them', Math.abs(shifting(0.5) - 0.125) < 1e-9 && shifting(1) === 0.25, String(shifting(0.5)));
  check('and its parts take the second half', Math.abs(overallProgress({ songIndex: 1, songCount: 2, songTitle: '', partName: '', partIndex: 1, partCount: 2, stage: 'reading', ratio: 0, shiftShare: 0.5 }) - 0.25) < 1e-9);
  check('a song with nothing to shift gives its parts the whole song', at(1, 1, 'reading') === 0);
  check('a run of nothing does not divide by zero',
    Number.isFinite(overallProgress({ songIndex: 0, songCount: 0, songTitle: '', partName: '', partIndex: 0, partCount: 0, stage: 'reading', ratio: 0 })));
}

/* ------------------------------ the orders a list takes ------------------------------ */

group('sorting songs');
{
  const { sortSongs, keyRank, choose, flip } = await import('../src/lib/songSort.ts');
  const song = (id, title, bpm, originalKey, tempoUnset = false) =>
    ({ id, title, bpm, originalKey, tempoUnset, variants: [], transpose: 0 });
  const songs = [
    song('c', 'Cold Water', 96, 'Am'),
    song('a', 'Anthem', 128, 'D'),
    song('b', 'Bridge', 120, 'C#m'),
    song('d', 'Drift', 0, undefined, true),
  ];
  const setOrder = new Map([['b', 0], ['a', 1], ['c', 2]]);
  const ids = (spec) => sortSongs(songs, spec, setOrder).map((s) => s.id).join('');

  check('set order follows the running order, with a song not in it last', ids({ key: 'set', dir: 'asc' }) === 'bacd', ids({ key: 'set', dir: 'asc' }));
  check('turned over, the set runs backwards but the stray still sits last', ids({ key: 'set', dir: 'desc' }) === 'cabd', ids({ key: 'set', dir: 'desc' }));
  check('by name', ids({ key: 'name', dir: 'asc' }) === 'abcd');
  check('by name, reversed', ids({ key: 'name', dir: 'desc' }) === 'dcba');
  check('by tempo, and a song with none last either way',
    ids({ key: 'tempo', dir: 'asc' }) === 'cbad' && ids({ key: 'tempo', dir: 'desc' }) === 'abcd', ids({ key: 'tempo', dir: 'desc' }));
  check('by key: chromatic from C, minor after its major, none last',
    ids({ key: 'key', dir: 'asc' }) === 'bacd', ids({ key: 'key', dir: 'asc' }));
  check('C before Cm before C#', keyRank('C') < keyRank('Cm') && keyRank('Cm') < keyRank('C#') && keyRank('Db') === keyRank('C#'));
  check('a key that is not one has no rank', keyRank('nope') === null && keyRank(undefined) === null);
  check('choosing the field already chosen changes nothing', choose({ key: 'name', dir: 'desc' }, 'name').dir === 'desc');
  check('choosing another starts it the right way up', choose({ key: 'name', dir: 'desc' }, 'key').dir === 'asc');
  check('flipping turns it over and back', flip(flip({ key: 'set', dir: 'asc' })).dir === 'asc' && flip({ key: 'set', dir: 'asc' }).dir === 'desc');
}

/* ------------------------------ cutting a PCM file ------------------------------ */

group('cutting a stretch out of a PCM file');
{
  const { probePcmHeader, byteRangeOf, frameAt, wrapPcmSlice, readPcmWindow } = await import('../src/lib/audioSlice.ts');

  // A little float WAV, 48 kHz stereo, one second, with a JUNK chunk before fmt as Live writes.
  const rate = 48000, ch = 2, frames = 48000;
  const wav = (() => {
    const junk = 28, fmt = 16, data = frames * ch * 4;
    const out = new ArrayBuffer(12 + 8 + junk + 8 + fmt + 8 + data);
    const v = new DataView(out), b = new Uint8Array(out);
    const tag = (at, t) => { for (let i = 0; i < 4; i++) b[at + i] = t.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, out.byteLength - 8, true); tag(8, 'WAVE');
    let at = 12; tag(at, 'JUNK'); v.setUint32(at + 4, junk, true); at += 8 + junk;
    tag(at, 'fmt '); v.setUint32(at + 4, fmt, true); v.setUint16(at + 8, 3, true); v.setUint16(at + 10, ch, true);
    v.setUint32(at + 12, rate, true); v.setUint32(at + 16, rate * ch * 4, true); v.setUint16(at + 20, ch * 4, true); v.setUint16(at + 22, 32, true);
    at += 8 + fmt; tag(at, 'data'); v.setUint32(at + 4, data, true); at += 8;
    const f = new Float32Array(out, at, frames * ch);
    for (let i = 0; i < frames; i++) { f[i * 2] = i / frames; f[i * 2 + 1] = -i / frames; } // a ramp, so any sample says where it is
    return out;
  })();
  const h = probePcmHeader(wav.slice(0, 4096), wav.byteLength);
  check('a float WAV is read past its junk', h?.kind === 'wav' && h.sampleRate === 48000 && h.channels === 2 && h.bitsPerSample === 32 && h.frames === frames, JSON.stringify(h && { ...h, fmt: undefined }));
  check('and its data found', h.dataOffset === 12 + 8 + 28 + 8 + 16 + 8);
  const r = byteRangeOf(h, frameAt(h, 0.5), 0.25 * rate);
  check('a range is frames times bytes per frame', r.frames === 12000 && r.end - r.start === 12000 * 8 && r.start === h.dataOffset + 24000 * 8);
  check('and is clipped to the file', byteRangeOf(h, 47000, 5000).frames === 1000 && byteRangeOf(h, 50000, 10).frames === 0);

  const readRange = async (a, z) => ({ bytes: wav.slice(a, z), size: wav.byteLength });
  const cut = await readPcmWindow(readRange, 0.5, 0.25);
  const h2 = probePcmHeader(cut.bytes, cut.bytes.byteLength);
  check('the cut is a WAV of its own, of the right length', h2?.kind === 'wav' && h2.frames === 12000 && h2.format === 3 && cut.fromSec === 0.5, JSON.stringify(h2 && { ...h2, fmt: undefined }));
  const first = new Float32Array(cut.bytes, h2.dataOffset, 2);
  check('holding the samples from where the cut began', Math.abs(first[0] - 24000 / frames) < 1e-6 && Math.abs(first[1] + 24000 / frames) < 1e-6, String(first[0]));
  const beyond = await readPcmWindow(readRange, 5, 1);
  const h3 = probePcmHeader(beyond.bytes, beyond.bytes.byteLength);
  check('a window past the end is a few frames of silence, not the whole file', h3?.frames === 64 && beyond.bytes.byteLength < 1000 && beyond.fromSec === 5, JSON.stringify(h3 && { ...h3, fmt: undefined }));
  check('a file that is not PCM cannot be cut', probePcmHeader(new TextEncoder().encode('ID3      mp3 bytes here').buffer, 100) === null);
  check('nor a WAV squeezed with something', (() => {
    const gone = wav.slice(0, 4096); new DataView(gone).setUint16(12 + 8 + 28 + 8, 85, true); // fmt tag: MP3
    return probePcmHeader(gone, wav.byteLength) === null;
  })());

  // AIFF-C as Live writes floats: big-endian header, fl32.
  const aiff = (() => {
    const compression = new Uint8Array([0x66, 0x6c, 0x33, 0x32, 5, 0x66, 0x6c, 0x33, 0x32, 0]); // 'fl32' + pstring "fl32" + pad
    const comm = 18 + compression.length, data = frames * ch * 4;
    const out = new ArrayBuffer(12 + 8 + comm + 16 + data);
    const v = new DataView(out), b = new Uint8Array(out);
    const tag = (at, t) => { for (let i = 0; i < 4; i++) b[at + i] = t.charCodeAt(i); };
    tag(0, 'FORM'); v.setUint32(4, out.byteLength - 8); tag(8, 'AIFC');
    let at = 12; tag(at, 'COMM'); v.setUint32(at + 4, comm); v.setInt16(at + 8, ch); v.setUint32(at + 10, frames); v.setInt16(at + 14, 32);
    // 48000 as an 80-bit float: exponent 16383+15, mantissa 48000<<48
    v.setUint8(at + 16, 0x40); v.setUint8(at + 17, 0x0e); v.setUint32(at + 18, 0xbb800000); v.setUint32(at + 22, 0);
    b.set(compression, at + 26); at += 8 + comm;
    tag(at, 'SSND'); v.setUint32(at + 4, 8 + data); v.setUint32(at + 8, 0); v.setUint32(at + 12, 0);
    return out;
  })();
  const a = probePcmHeader(aiff.slice(0, 4096), aiff.byteLength);
  check('an AIFF-C of floats is read, rate and all', a?.kind === 'aiff' && a.sampleRate === 48000 && a.channels === 2 && a.frames === frames && a.format === 'fl32', JSON.stringify(a && { ...a, aifcCompression: undefined }));
  const acut = await readPcmWindow(async (x, y) => ({ bytes: aiff.slice(x, y), size: aiff.byteLength }), 0.25, 0.5);
  const a2 = probePcmHeader(acut.bytes, acut.bytes.byteLength);
  check('and its cut is an AIFF-C of its own, at the same rate', a2?.kind === 'aiff' && a2.frames === 24000 && a2.sampleRate === 48000 && a2.format === 'fl32', JSON.stringify(a2 && { ...a2, aifcCompression: undefined }));
  check('the wrapper never writes more than it was given', wrapPcmSlice(h, new ArrayBuffer(8 * 10 + 3)).byteLength === 12 + h.fmt.byteLength + 8 + 80);
}

/* ------------------------------- frozen tracks ------------------------------ */

group('frozen tracks');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const clip = (id, start, end, path, extra = '') => `
        <AudioClip Id="${id}" Time="${start}"><CurrentStart Value="${start}" /><CurrentEnd Value="${end}" />
          <LoopStart Value="0" /><LoopEnd Value="${end - start}" /><StartRelative Value="0" />
          <Disabled Value="false" /><Fade Value="false" /><IsWarped Value="true" />
          <SampleRef><FileRef><RelativePath Value="${path}" /></FileRef><DefaultSampleRate Value="48000" /></SampleRef>
          <WarpMarkers><WarpMarker Id="0" SecTime="0" BeatTime="0" /><WarpMarker Id="1" SecTime="0.015625" BeatTime="0.03125" /></WarpMarkers>
          ${extra}
        </AudioClip>`;
  const track = (id, group, name, frozen, main, freeze, devices = '') => `
    <AudioTrack Id="${id}"><TrackGroupId Value="${group}" /><EffectiveName Value="${name}" />
      <Speaker><LomId Value="0" /><Manual Value="true" /></Speaker>
      <Freeze Value="${frozen}" />
      <DeviceChain>
        <MainSequencer><Sample><ArrangerAutomation><Events>${main}</Events></ArrangerAutomation></Sample></MainSequencer>
        <FreezeSequencer><Sample><ArrangerAutomation><Events>${freeze}</Events></ArrangerAutomation></Sample></FreezeSequencer>
        <DeviceChain>${devices}</DeviceChain>
      </DeviceChain>
    </AudioTrack>`;
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
    <Locator Id="2"><Time Value="32" /><Name Value="Clocks" /></Locator>
    <Locator Id="3"><Time Value="64" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /></GroupTrack>
    <GroupTrack Id="20"><TrackGroupId Value="-1" /><EffectiveName Value="Clocks" /></GroupTrack>
    ${track(11, 10, 'Bass', 'true',
      clip(1, 0, 32, 'Stems/Bass.wav', '<PitchCoarse Value="-2" /><PitchFine Value="0" />'),
      clip(0, 0, 32, 'Samples/Processed/Freeze/Freeze Bass [x].wav'),
      '<Eq8 Id="1"><On><Manual Value="true" /></On></Eq8>')}
    ${track(12, 10, 'Keys', 'false',
      clip(1, 0, 32, 'Stems/Keys.wav', '<PitchCoarse Value="-2" /><PitchFine Value="0" />'),
      '')}
    ${track(21, 20, 'Drums', 'true',
      clip(1, 32, 64, 'Stems/Drums.wav'),
      clip(0, 0, 64, 'Samples/Processed/Freeze/Freeze Drums [x].wav'))}
  </Ableton>`;
  const project = parseAlsXml(xml);
  const yellow = project.songs.find((s) => s.title === 'Yellow');
  const bass = yellow.stems.find((s) => s.name === 'Bass');
  const keys = yellow.stems.find((s) => s.name === 'Keys');
  check("a frozen track's clip is its freeze file", bass?.frozen === true && bass.clips.length === 1 && /Freeze Bass/.test(bass.clips[0].path), JSON.stringify(bass?.clips));
  check('at pitch, at speed, and marked', bass.clips[0].semitones === 0 && bass.clips[0].speed === 1 && bass.clips[0].frozen === true);
  check('with its own devices inside the render, so none listed', bass.devices.length === 0);
  check('an unfrozen track beside it keeps its clip and its transposition', keys?.frozen === false && /Stems\/Keys/.test(keys.clips[0].path) && keys.clips[0].semitones === -2);
  check('and the arrangement is not doubled', yellow.stems.every((s) => s.clips.length === 1));

  // A freeze file spanning the set: the song's stretch of it begins where the song does.
  const clocks = project.songs.find((s) => s.title === 'Clocks');
  const drums = clocks.stems.find((s) => s.name === 'Drums');
  check('a freeze clip running from the set start is cut to the song', drums?.frozen === true && Math.abs(drums.clips[0].startBar - 1) < 1e-9 && Math.abs(drums.clips[0].endBar - 9) < 1e-9, JSON.stringify(drums?.clips));
  check('and starts in the file where the song starts, in seconds along the set', Math.abs(drums.clips[0].sourceStartSec - 32 * 60 / 120) < 1e-9, String(drums.clips[0].sourceStartSec));

  // The checker points a shifted track at freezing, and names a frozen one.
  const { checkSet } = await import('../src/lib/setReview.ts');
  const findings = checkSet(project).filter((f) => f.song === 'Yellow' && f.topic === 'playback');
  check('the checker names the frozen track', findings.some((f) => /frozen — Bass —/.test(f.message)), findings.map((f) => f.message).join(' | '));
  check('and suggests freezing the shifted one', findings.some((f) => /Keys — and will be shifted here/.test(f.message)));

  // Into the library: the freeze file is under Samples/, which the scan never
  // lists, so the set's own path to it is what the part is built on.
  const { songsFromProject } = await import('../src/lib/alsImport.ts');
  const alsPath = '/Band/Show/Show.als';
  const listed = (p) => ({ path: p, name: p.split('/').pop(), rev: 'r', size: 10, modified: 1 });
  const imported = songsFromProject(project, alsPath, [listed('/Band/Show/Stems/Keys.wav')], new Map());
  const yellowSong = imported.songs.find((s) => s.title === 'Yellow');
  const bassPart = yellowSong?.variants.find((v) => v.name === 'Bass');
  check('a frozen track becomes a part by its freeze file, though the scan never saw it',
    bassPart?.frozen === true && /\/Band\/Show\/Samples\/Processed\/Freeze\/Freeze Bass/.test(bassPart.path), JSON.stringify(bassPart));
  check('carried as its one clip, so the player reads only its stretch of the file',
    bassPart?.clips?.length === 1 && bassPart.clips[0].frozen === true && bassPart.placement === undefined, JSON.stringify(bassPart?.clips));
  check('an ordinary part beside it is placed once, as ever',
    yellowSong?.variants.find((v) => v.name === 'Keys')?.clips === undefined);
}

/* ------------------------------ what changed since ------------------------------ */

group('a song\'s audio as a key');
{
  const { audioKeyFor, audioKeySegments, audioStanding, AUDIO_KEY_VERSION } = await import('../src/lib/audioKey.ts');
  const { validateManifest } = await import('../src/lib/preparedSet.ts');
  const { songInfoFor } = await import('../src/lib/updatePrepared.ts');

  const clip = (path, extra = {}) => ({
    path, startBar: 1, endBar: 65, sourceStartSec: 0, disabled: false, fadeInSec: 0, fadeOutSec: 0,
    warped: true, semitones: 0, speed: 1, gain: 1, ...extra,
  });
  const stem = (name, path, extra = {}) => ({
    name, reference: false, frozen: false, gain: 1, pan: 0, devices: [], sends: [], direct: true,
    path, regions: null, clips: [clip(path)], ...extra,
  });
  const project = { creator: 'x', tempo: 120, timeSigNum: 4, timeSigDen: 4, songs: [], warnings: [] };
  const song = (over = {}) => ({
    title: 'Yellow', raw: '', startBar: 1, endBar: 65, bpm: 120, key: 'G', durationText: null, tags: [],
    sections: [], chords: [], lanes: [], lyrics: [], tempoChanges: [], rigMarks: [],
    stems: [stem('Bass', 'Stems/Bass.wav'), stem('Vox', 'Stems/Vox.wav')],
    ...over,
  });
  const revs = { 'stems/bass.wav': '100-5', 'stems/vox.wav': '100-7' };
  const inputs = (over = {}) => ({ fileRev: (p) => revs[p.toLowerCase()] ?? null, bitrate: 192, sampleRate: 48000, ...over });

  const base = audioKeyFor(song(), project, inputs());
  check('the key is five segments, version first', base.split('.').length === 5 && base.startsWith(`${AUDIO_KEY_VERSION}.`), base);
  check('and the same set keys the same twice', audioKeyFor(song(), project, inputs()) === base);
  check('the words changing changes nothing',
    audioKeyFor(song({ lyrics: [{ bar: 3, text: 'hello' }], sections: [{ bar: 1, text: 'INTRO' }] }), project, inputs()) === base);

  const seg = (key, i) => key.split('.')[i];
  const reExported = audioKeyFor(song(), project, inputs({ fileRev: (p) => (p.toLowerCase() === 'stems/bass.wav' ? '200-5' : revs[p.toLowerCase()]) }));
  check('a re-exported file changes only the files segment',
    seg(reExported, 1) !== seg(base, 1) && seg(reExported, 2) === seg(base, 2) && seg(reExported, 3) === seg(base, 3));
  const moved = audioKeyFor(song({ stems: [stem('Bass', 'Stems/Bass.wav', { clips: [clip('Stems/Bass.wav', { startBar: 3 })] }), stem('Vox', 'Stems/Vox.wav')] }), project, inputs());
  check('a moved clip changes the arrangement segment', seg(moved, 2) !== seg(base, 2) && seg(moved, 1) === seg(base, 1));
  const quieter = audioKeyFor(song({ stems: [stem('Bass', 'Stems/Bass.wav', { gain: 0.5 }), stem('Vox', 'Stems/Vox.wav')] }), project, inputs());
  check('a fader changes the mix segment', seg(quieter, 3) !== seg(base, 3) && seg(quieter, 2) === seg(base, 2));
  const planned = audioKeyFor(song(), project, inputs({ plan: { print: ['Vox'], combine: [{ name: 'band', stems: ['Bass'] }] } }));
  check('so does the plan', planned !== base);
  const bitrate = audioKeyFor(song(), project, inputs({ bitrate: 128 }));
  check('and the encoder settings their own', seg(bitrate, 4) !== seg(base, 4) && seg(bitrate, 1) === seg(base, 1));
  const gone = audioKeyFor(song(), project, inputs({ fileRev: () => null }));
  check('a missing file is a fact in the key', seg(gone, 1) !== seg(base, 1));
  check('a disabled clip counts for nothing',
    audioKeyFor(song({ stems: [stem('Bass', 'Stems/Bass.wav', { clips: [clip('Stems/Bass.wav'), clip('Stems/Other.wav', { disabled: true })] }), stem('Vox', 'Stems/Vox.wav')] }), project, inputs()) === base);
  check('the segments read plainly', /Stems\/Bass\.wav 100-5/.test(audioKeySegments(song(), project, inputs()).files));

  // What the dialog says about each song.
  check('never prepared is new', audioStanding(base, undefined, false).state === 'new');
  check('prepared before keys existed is taken as changed',
    audioStanding(base, undefined, true).state === 'changed' && /before this could be told/.test(audioStanding(base, undefined, true).why));
  check('the same key is unchanged', audioStanding(base, base, true).state === 'unchanged');
  check('a re-export says so', /re-exported/.test(audioStanding(reExported, base, true).why));
  check('a moved clip says so', /arrangement/.test(audioStanding(moved, base, true).why));
  check('a fader says so', /fader/.test(audioStanding(quieter, base, true).why));
  check('a new version of the renderer trumps the rest', /renders parts differently/.test(audioStanding(`${AUDIO_KEY_VERSION + 1}.a.b.c.d`, base, true).why));

  // Into and out of the manifest.
  const manifest = { preparedBy: 'rehearsaltool', preparedAt: 'x', paddingSec: 0, songs: [{ folder: 'Yellow {120}', title: 'Yellow', firstBarOffsetSec: 0, audioKey: base }] };
  check('the manifest carries the key', validateManifest(manifest).ok);
  check('and refuses one that is not text', !validateManifest({ ...manifest, songs: [{ ...manifest.songs[0], audioKey: 5 }] }).ok);
  check('a words-only update carries it forward', songInfoFor(song(), project, '/x.als', { folder: 'Yellow {120}', firstBarOffsetSec: 0, audioKey: base }).audioKey === base);
}

/* ------------------------------ what the band is shown ------------------------------ */

group('what the band\'s library is built from');
{
  const { publishable } = await import('../src/lib/publish.ts');
  const f = (p) => ({ path: p, name: p.split('/').pop(), rev: 'r', size: 1, modified: 1 });
  const files = [
    f('/Sets/Friday/Yellow {120}/Yellow [bass].mp3'),
    f('/Sets/Friday/set.json'),
    f('/Resources/MetronomeUp-1a2b3c4d.flac'),
    f('/Resources/slates/Yellow-5e6f7a8b.wav'),
    f('/Resources/Cues/1 One.flac'),
    f('/Prints/Yellow (no vocal v1 2026-08-13 rehearsaltool).wav'),
    f('/Rehearsal Tool/Sets/Old/Clocks {131}/Clocks [drums].mp3'),
  ];
  const kept = publishable(files).map((x) => x.path);
  check('a prepared part is a song', kept.includes('/Sets/Friday/Yellow {120}/Yellow [bass].mp3'));
  check('so is one under the old wrapper', kept.includes('/Rehearsal Tool/Sets/Old/Clocks {131}/Clocks [drums].mp3'));
  check('nothing under Resources is', !kept.some((p) => /\/Resources\//.test(p)), kept.join(', '));
  check('nor a print', !kept.some((p) => /\/Prints\//.test(p)));
  check('the manifest rides along for the reader', kept.includes('/Sets/Friday/set.json'));
}

/* ------------------------------ the order AbleSet plays ------------------------------ */

group('running order from AbleSet');
{
  const { parseAbleSetSetlist, orderFromAbleSet, abletSetlistFiles } = await import('../src/lib/ableset.ts');
  const { setlistFromProject, songIdFor } = await import('../src/lib/alsImport.ts');
  const { folderOrder } = await import('../src/lib/prepare.ts');

  const song = (title, startBar) => ({
    title, raw: title, startBar, endBar: startBar + 30, bpm: 120, key: null, durationText: null, tags: [],
    sections: [], chords: [], lyrics: [], lanes: [], tempoChanges: [], rigMarks: [], stems: [],
  });
  const project = {
    creator: 'x', tempo: 120, timeSigNum: 4, timeSigDen: 4, warnings: [],
    songs: [song('Sound Check', 1), song('Yellow', 17), song('Yellow', 19), song('Clocks', 65), song('Fix You', 129)],
  };
  // AbleSet plays Fix You first, then Yellow, then Clocks; it has not heard of Sound Check.
  const raw = [
    { id: 'a', time: 512, lastKnownName: 'Fix You' },
    { id: 'b', time: 64, lastKnownName: 'Yellow' },
    { id: 'c', time: 999, lastKnownName: 'Clocks - Play in D' },
  ];
  const entries = parseAbleSetSetlist(raw);
  check('a setlist file is a list of positions and names', entries?.length === 3 && entries[0].time === 512 && entries[0].name === 'Fix You');
  check('anything else is not one', parseAbleSetSetlist({ songs: [] }) === null && parseAbleSetSetlist([{ id: 'x' }]) === null);

  const order = orderFromAbleSet(project, entries);
  check('songs come out in AbleSet\'s order, matched by beat', order.slice(0, 2).join(' | ') === 'Fix You | Yellow', order.join(' | '));
  check('a moved locator is matched by name, brackets and all', order[2] === 'Clocks');
  check('a song the setlist never names follows, as the set has it', order[3] === 'Sound Check' && order.length === 4, order.join(' | '));
  check('a count-in locator repeating a title does not double it', order.filter((t) => t === 'Yellow').length === 1);

  const als = '/Band/Show/Show.als';
  const setlist = setlistFromProject(als, project, () => true, order, 'from AbleSet');
  check('the set\'s own setlist takes that order', setlist.songIds[0] === songIdFor(als, 'Fix You') && setlist.songIds.length === 4 && setlist.notes === 'from AbleSet');
  check('and the arrangement\'s without one', setlistFromProject(als, project, () => true).songIds[0] === songIdFor(als, 'Sound Check'));

  const folders = folderOrder(project, order);
  check('the manifest follows it too', folders[0].startsWith('Fix You') && folders[3].startsWith('Sound Check') && folders.length === 4, folders.join(' | '));
  check('and the set without it', folderOrder(project)[0].startsWith('Sound Check'));

  const files = [
    { path: '/Band/Show/AbleSet/Setlists/Tour.json', name: 'Tour.json', rev: 'r', size: 1, modified: 10 },
    { path: '/Band/Show/AbleSet/Setlists/Rehearsal.json', name: 'Rehearsal.json', rev: 'r', size: 1, modified: 20 },
    { path: '/Band/Show/AbleSet/Settings/settings.json', name: 'settings.json', rev: 'r', size: 1, modified: 30 },
    { path: '/Band/Other/AbleSet/Setlists/Other.json', name: 'Other.json', rev: 'r', size: 1, modified: 40 },
  ];
  const found = abletSetlistFiles(files, als);
  check('the setlists beside a set are found, newest first, and nobody else\'s', found.map((f) => f.name).join(',') === 'Rehearsal.json,Tour.json', found.map((f) => f.name).join(','));

  // What AbleSet is showing right now, from its log: the last order it sent itself.
  const { liveSetlistFromLog } = await import('./studio-files.mjs');
  const line = (ts, map, name = 'Tour') => JSON.stringify({ level: 'debug', message: 'POST Request', method: 'POST', module: 'server', path: '/api/setlist/setCueMeta', timestamp: ts, body: { setlistName: name, metaMap: map } });
  const log = [
    '{"level":"info","message":"Starting","timestamp":"2026-09-05T20:00:00Z"}',
    line('2026-09-05T20:01:00Z', [{ id: 'a', time: 512, lastKnownName: 'Fix You', order: 1 }, { id: 'b', time: 64, lastKnownName: 'Yellow', order: 0 }]),
    'not json at all',
    line('2026-09-05T21:18:24Z', [{ id: 'a', time: 512, lastKnownName: 'Fix You', order: 0 }, { id: 'b', time: 64, lastKnownName: 'Yellow', order: 1 }], 'Tour 2'),
    '{"level":"info","message":"Stopping","timestamp":"2026-09-05T21:20:00Z"}',
  ].join('\n');
  const live = liveSetlistFromLog(log);
  check('the last order AbleSet sent itself is the one taken', live?.at === '2026-09-05T21:18:24Z' && live.setlistName === 'Tour 2', JSON.stringify(live));
  check('sorted by its order field, names carried', live.entries.map((e) => e.lastKnownName).join(',') === 'Fix You,Yellow');
  check('a log with no such line has none', liveSetlistFromLog('{"a":1}\nnope') === null);
}

/* ------------------------------ song info clips ------------------------------ */

group('song info as AbleSet clips');
{
  const { infoLinesFor, infoClipsFor, songLengthSec, DEFAULT_INFO_FIELDS, DEFAULT_INFO_TRACK, abletReads } = await import('../src/lib/infoTrack.ts');
  const project = { creator: 'x', tempo: 120, timeSigNum: 4, timeSigDen: 4, warnings: [], songs: [] };
  const song = (over = {}) => ({
    title: 'Yellow', raw: '', startBar: 9, endBar: 72, bpm: 88, startBpm: 88, key: 'Bb', durationText: null, tags: ['#slow'],
    flags: [], endsAtStop: true, slateBars: [], sections: [{ bar: 1, text: 'INTRO' }, { bar: 5, text: 'VERSE 1' }], chords: [], lyrics: [], lanes: [],
    tempoChanges: [], rigMarks: [], timeSigNum: 4, timeSigDen: 4, stems: [], notes: 'Watch the drummer\nfor the stop.', ...over,
  });
  const all = Object.fromEntries(Object.keys(DEFAULT_INFO_FIELDS).map((k) => [k, true]));
  const lines = infoLinesFor(song(), project, all);
  check('the title is bold, as AbleSet reads it', lines[0] === '**Yellow**', lines[0]);
  check('the key is said', lines.includes('Key: Bb'));
  check('tempo, time and length share a line', lines.some((l) => l === '88 BPM · 4/4 · 64 bars · 2:55'), lines.join(' | '));
  check('sections are listed in order', lines.includes('Sections: INTRO · VERSE 1'));
  check('notes lose their line breaks for AbleSet\'s own', lines.includes('Watch the drummer \\ for the stop.'), lines.join(' | '));
  check('tags ride along', lines.includes('#slow'));
  check('unticked facts are left out', infoLinesFor(song(), project, { ...DEFAULT_INFO_FIELDS, sections: false, tags: false, notes: false }).length === 3);
  check('a key typed by hand wins over the locator\'s', infoLinesFor(song(), project, all, 'A').includes('Key: A'));
  check('a song with a tempo change is timed through it', Math.abs(songLengthSec(song({ tempoChanges: [{ bar: 33, bpm: 176 }] }), project) - (32 * 4 * 60 / 88 + 32 * 4 * 60 / 176)) < 1e-6);

  const p2 = { ...project, songs: [song(), song({ title: 'Yellow' }), song({ title: 'Clocks', startBar: 80, endBar: 100, key: 'D', notes: '', tags: [], sections: [] }), song({ title: 'Blank', startBar: 110, endBar: 120, key: null, notes: '', tags: [], sections: [] })] };
  const { clips, songs, empty } = infoClipsFor(p2, ['Yellow', 'Clocks'], { ...DEFAULT_INFO_FIELDS, title: false, tempo: false, timeSig: false, length: false });
  check('one clip per song, at its first bar, the song long', clips.length === 2 && clips[0].bar === 9 && clips[0].bars === 64 && clips[1].bar === 80, JSON.stringify(clips.map((c) => [c.bar, c.bars])));
  check('a repeated title is one song', songs.join() === 'Yellow,Clocks' && empty.length === 0);
  const bare = infoClipsFor(p2, ['Blank'], { ...DEFAULT_INFO_FIELDS, title: false, tempo: false, timeSig: false, length: false, key: true });
  check('a song with nothing to say under the ticks is named, not written', bare.clips.length === 0 && bare.empty.join() === 'Blank');
  check('a first-bar clip is a bar long', infoClipsFor(p2, ['Yellow'], all, { wholeSong: false }).clips[0].bars === 1);
  check('lines are joined with AbleSet\'s break', /\*\*Yellow\*\* \\ Key: Bb \\ /.test(infoClipsFor(p2, ['Yellow'], all).clips[0].text), infoClipsFor(p2, ['Yellow'], all).clips[0].text);

  // Off AbleSet's tracks, a clip is a plain name for Live: no stars, no backslashes.
  check('the default track is a plain one, and says what to do with it', DEFAULT_INFO_TRACK === 'ADD THIS SONG INFO' && !abletReads(DEFAULT_INFO_TRACK) && abletReads('Info +LYRICS'));
  const plain = infoClipsFor(p2, ['Yellow'], all, { forAbleSet: false }).clips[0].text;
  check('and its clip is one plain line', plain.startsWith('Yellow · Key: Bb · ') && !/[\\*]/.test(plain), plain);
  check('with the notes\' line break made a dot too', /Watch the drummer · for the stop\./.test(plain));
}

/* ------------------------------ patch changes from MIDI clips ------------------------------ */

group('patch changes the set sends from MIDI clips');
{
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');
  const { clipsFromRig, isFromMidiClip } = await import('../src/lib/alsImport.ts');
  const envelope = (pointee, events) => `
              <ClipEnvelope Id="1"><EnvelopeTarget><PointeeId Value="${pointee}" /></EnvelopeTarget>
                <Automation><Events>${events.map(([t, v], i) => `<FloatEvent Id="${i}" Time="${t}" Value="${v}" />`).join('')}</Events></Automation>
              </ClipEnvelope>`;
  const clip = (id, start, end, name, pgm, coarse, fine, envs = '') => `
            <MidiClip Id="${id}" Time="${start}"><CurrentStart Value="${start}" /><CurrentEnd Value="${end}" />
              <Name Value="${name}" /><Disabled Value="false" />
              <BankSelectCoarse Value="${coarse}" /><BankSelectFine Value="${fine}" /><ProgramChange Value="${pgm}" />
              <Envelopes><Envelopes>${envs}</Envelopes></Envelopes>
            </MidiClip>`;
  // Live numbers controller targets from pitch bend: 45 is CC 43, 47 is CC 45.
  const targets = Array.from({ length: 131 }, (_, i) => `<ControllerTargets.${i} Id="${9000 + i}"><LomId Value="0" /></ControllerTargets.${i}>`).join('');
  const xml = `<Ableton Creator="Live 12">
    <Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator>
    <Locator Id="2"><Time Value="64" /><Name Value="Clocks" /></Locator>
    <Locator Id="3"><Time Value="128" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /></GroupTrack>
    <GroupTrack Id="20"><TrackGroupId Value="-1" /><EffectiveName Value="Clocks" /></GroupTrack>
    <MidiTrack Id="30"><TrackGroupId Value="-1" /><EffectiveName Value="MIDI - Quad Cortex" />
      <DeviceChain>
        <MidiOutputRouting><Target Value="MidiOut/External.Dev:Box/2" /><UpperDisplayString Value="Box" /><LowerDisplayString Value="Ch. 3" /></MidiOutputRouting>
        <MainSequencer><ClipTimeable><ArrangerAutomation><Events>
          ${clip(1, 0, 4, 'A', 3, 0, 2, envelope(9045, [[-63072000, 0], [0, 0]]))}
          ${clip(2, 16, 24, 'C then D', -1, -1, -1, envelope(9045, [[-63072000, 2], [0, 2], [4, 3.7]]))}
          ${clip(3, 64, 68, 'Toggle Tuner', -1, -1, -1, envelope(9047, [[-63072000, 127], [0, 127]]))}
          ${clip(4, 72, 76, 'bend only', -1, -1, -1, envelope(9000, [[0, 0.5]]))}
        </Events></ArrangerAutomation></ClipTimeable></MainSequencer>
        <MidiControllers>${targets}</MidiControllers>
      </DeviceChain>
    </MidiTrack>
  </Ableton>`;
  const project = parseAlsXml(xml);
  const yellow = project.songs.find((s) => s.title === 'Yellow');
  const clocks = project.songs.find((s) => s.title === 'Clocks');
  check('a clip with a program and bank sends them on the track\'s channel, as the wire has them',
    yellow?.rigPatches[0]?.bar === 1 && yellow.rigPatches[0].channel === 3 && yellow.rigPatches[0].program === 3 && yellow.rigPatches[0].bank === 2,
    JSON.stringify(yellow?.rigPatches));
  check('and its scene envelope as CC 43, rounded', JSON.stringify(yellow?.rigPatches[0]?.controls) === '[{"cc":43,"value":0}]');
  check('an envelope that steps mid-clip is a change of its own, on its bar',
    yellow?.rigPatches.length === 3 && yellow.rigPatches[1].bar === 5 && yellow.rigPatches[2].bar === 6 && yellow.rigPatches[2].controls[0].value === 4,
    JSON.stringify(yellow?.rigPatches.map((r) => [r.bar, r.controls])));
  check('a clip in the next song belongs to it', clocks?.rigPatches.length === 1 && clocks.rigPatches[0].name === 'Toggle Tuner' && clocks.rigPatches[0].controls[0].cc === 45);
  check('pitch bend is not a patch change', !clocks?.rigPatches.some((r) => r.name === 'bend only'));

  const clips = clipsFromRig(yellow.rigPatches, 'yellow');
  check('they become patch clips the player fires, naming their clip', clips[0].patch.source === 'MIDI - Quad Cortex: A' && clips[0].patch.channel === 3);
  check('and are known for what they are, so the locator writer leaves them out', clips.every(isFromMidiClip) && !isFromMidiClip({ id: 'als:x:0' }));
}

/* ------------------------------ the rig loop ------------------------------ */

group('patch changes to and from the band');
{
  const { rigTrackMember, rigTrackName, addRigTracks } = await import('../src/lib/rigTrack.ts');
  const { parseMemberRig, rigTrackSpecFor, studioChanges } = await import('../src/lib/rigFiles.ts');
  const { parseAlsXml } = await import('../src/lib/alsParser.ts');

  check('a rig track names its member', JSON.stringify(rigTrackMember('RIG Alex (Quad Cortex)')) === '{"member":"Alex","rig":"Quad Cortex"}');
  check('with or without the rig, and with ADD THIS in front', rigTrackMember('ADD THIS RIG Sam')?.member === 'Sam' && rigTrackMember('MIDI - Quad Cortex') === null);
  check('and is named the same way back', rigTrackName('Alex', 'Quad Cortex') === 'RIG Alex (Quad Cortex)' && rigTrackName('Sam') === 'RIG Sam');

  const file = parseMemberRig({
    member: 'Alex', rig: 'Quad Cortex', updatedAt: '2026-09-05T23:40:00Z',
    songs: {
      'Yellow {120, G, 4-4}': [
        { bar: 1, name: 'Scene A', patch: { channel: 1, program: 3, bank: 2, controls: [{ cc: 43, value: 0 }] } },
        { bar: 9, patch: { channel: 1, controls: [{ cc: 43, value: 2 }] } },
        { bar: 'x', patch: { channel: 1 } },
        { bar: 3, patch: { channel: 99 } },
      ],
      'Gone {100}': [{ bar: 1, patch: { channel: 1, program: 1 } }],
    },
  });
  check('a member file is read, bad entries left out', file?.member === 'Alex' && file.rig === 'Quad Cortex' && file.songs['Yellow {120, G, 4-4}'].length === 2, JSON.stringify(file));
  check('and something else is not one', parseMemberRig({ songs: {} }) === null && parseMemberRig('no') === null);

  const song = (title, startBar, key) => ({
    title, raw: title, startBar, endBar: startBar + 30, bpm: 120, key, durationText: null, tags: [], flags: [], endsAtStop: true, startBpm: 120,
    slateBars: [], sections: [], chords: [], lyrics: [], lanes: [], tempoChanges: [], rigMarks: [], rigTracks: [], rigPatches: [], timeSigNum: 4, timeSigDen: 4, stems: [], notes: '', caveats: [],
  });
  const project = { creator: 'x', tempo: 120, timeSigNum: 4, timeSigDen: 4, warnings: [], songs: [song('Yellow', 1, 'G'), song('Clocks', 33, null)] };
  const { spec, unknownFolders } = rigTrackSpecFor(file, project);
  check('its changes land on the set\'s ruler, by song folder', spec.changes.map((c) => c.bar).join(',') === '1,9' && spec.member === 'Alex', JSON.stringify(spec.changes.map((c) => [c.bar, c.name])));
  check('a song the set no longer has is named', unknownFolders.join() === 'Gone {100}');
  check('a nameless change gets a name that says whose', spec.changes[1].name === 'Alex: bar 9');
  check('the studio\'s own changes are the ones not from the set', studioChanges([{ id: 'als:x:midi:0', bar: 1, patch: { channel: 1 } }, { id: 'p1', bar: 5, patch: { channel: 2, program: 7 } }], 33, (c) => c.id.includes(':midi:')).map((c) => c.bar).join() === '37');

  // Written into a set as clips, on a track modelled on the set's own rig track.
  const targets = Array.from({ length: 131 }, (_, i) => `<ControllerTargets.${i} Id="${9000 + i}"><LomId Value="0" /></ControllerTargets.${i}>`).join('');
  const xml = `<Ableton Creator="Live 12">
    <LiveSet>
    <NextPointeeId Value="20000" />
    <Tracks>
      <MidiTrack Id="30"><LomId Value="0" /><Name><EffectiveName Value="RIG Alex (Quad Cortex)" /><UserName Value="RIG Alex (Quad Cortex)" /></Name><TrackGroupId Value="-1" />
        <AutomationEnvelopes><Envelopes /></AutomationEnvelopes>
        <DeviceChain>
          <MidiOutputRouting><Target Value="MidiOut/External.Dev:Box/0" /><UpperDisplayString Value="Box" /><LowerDisplayString Value="Ch. 1" /></MidiOutputRouting>
          <MainSequencer><ClipTimeable><ArrangerAutomation><Events>
            <MidiClip Id="0" Time="0"><CurrentStart Value="0" /><CurrentEnd Value="4" />
              <Loop><LoopStart Value="0" /><LoopEnd Value="4" /><StartRelative Value="0" /><LoopOn Value="false" /><OutMarker Value="4" /><HiddenLoopStart Value="0" /><HiddenLoopEnd Value="4" /></Loop>
              <Name Value="A" /><Disabled Value="true" />
              <Envelopes><Envelopes><ClipEnvelope Id="1"><EnvelopeTarget><PointeeId Value="9045" /></EnvelopeTarget><Automation><Events><FloatEvent Id="0" Time="0" Value="0" /></Events></Automation></ClipEnvelope></Envelopes></Envelopes>
              <Notes><KeyTracks><KeyTrack Id="1"><Notes><MidiNoteEvent Time="0" Duration="1" Velocity="100" /></Notes><MidiKey Value="60" /></KeyTrack></KeyTracks></Notes>
              <BankSelectCoarse Value="0" /><BankSelectFine Value="2" /><ProgramChange Value="3" />
            </MidiClip>
          </Events></ArrangerAutomation></ClipTimeable></MainSequencer>
          <MidiControllers>${targets}</MidiControllers>
        </DeviceChain>
      </MidiTrack>
      <ReturnTrack Id="59"><LomId Value="0" /></ReturnTrack>
    </Tracks>
    </LiveSet>
  </Ableton>`;
  const out = addRigTracks(xml, [spec, { member: 'Studio', changes: [{ bar: 5, name: 'Helix snapshot', patch: { channel: 2, controls: [{ cc: 69, value: 1 }, { cc: 200, value: 1 }] } }] }], project);
  check('one track per member, named to say what to do with it',
    out.tracks.map((t) => `${t.name}:${t.clips}`).join(' | ') === 'ADD THIS RIG Alex (Quad Cortex):2 | ADD THIS RIG Studio:1', out.tracks.map((t) => `${t.name}:${t.clips}`).join(' | '));
  const first = out.xml.indexOf('<Tracks>');
  const firstName = out.xml.slice(first + out.xml.slice(first).search(/<MidiTrack /)).match(/<EffectiveName Value="([^"]*)"/)?.[1];
  check('the first member\'s track comes first, above the set\'s own', firstName === 'ADD THIS RIG Alex (Quad Cortex)', firstName);
  const alex = out.xml.slice(out.xml.indexOf('ADD THIS RIG Alex'), out.xml.indexOf('ADD THIS RIG Studio'));
  check('the program and bank go into the clip box as bytes', /<BankSelectCoarse Value="0" \/><BankSelectFine Value="2" \/><ProgramChange Value="3" \/>/.test(alex.replace(/\s+/g, ' ').replace(/> </g, '><')) || (alex.includes('<ProgramChange Value="3"') && alex.includes('<BankSelectFine Value="2"')));
  check('a change with no program says none', alex.includes('<ProgramChange Value="-1"'));
  const newTarget = alex.match(/<ControllerTargets\.45 Id="(\d+)"/)?.[1];
  check('a CC is an envelope pointed at the new track\'s own target for it', !!newTarget && newTarget !== '9045' && alex.includes(`<PointeeId Value="${newTarget}" />`), String(newTarget));
  check('the model\'s notes and its old envelope are gone', !alex.includes('MidiNoteEvent') && !alex.includes('<PointeeId Value="9045"'));
  check('a CC the model cannot address is dropped and counted', out.tracks[1].dropped === 1 && out.tracks[1].clips === 1);
  check('and every clip is switched on', !alex.includes('<Disabled Value="true"'));
  check('the pointee counter moved on', Number(out.xml.match(/<NextPointeeId Value="(\d+)"/)[1]) > 20000);

  // Read back by the parser: the member comes off the track's name.
  const back = parseAlsXml(`<Ableton Creator="Live 12"><Tempo><Manual Value="120" /><AutomationTarget Id="9" /></Tempo>
    <RemoteableTimeSignature><Numerator Value="4" /><Denominator Value="4" /></RemoteableTimeSignature>
    <Locator Id="1"><Time Value="0" /><Name Value="Yellow" /></Locator><Locator Id="3"><Time Value="128" /><Name Value="AUTOSTOP" /></Locator>
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Yellow" /></GroupTrack>
    ${out.xml.slice(out.xml.indexOf('<MidiTrack Id='), out.xml.indexOf('<ReturnTrack'))}
  </Ableton>`);
  const yellow = back.songs[0];
  check('and the parser reads them back with the member on', yellow.rigPatches.some((r) => r.member === 'Alex' && r.rig === 'Quad Cortex' && r.program === 3 && r.controls?.[0]?.cc === 43), JSON.stringify(yellow.rigPatches));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILURE(S).`);
process.exit(failures ? 1 : 0);
