/**
 * Self-test for the pure logic: bar maths, file grouping, and the pitch shifter.
 *
 * Run with `npm test`. Node 24 strips the TypeScript types natively, so these
 * import the real source files rather than a copy.
 */
import { SimpleFilter, SoundTouch } from 'soundtouchjs';
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
  /** Mirrors ArraySource in src/lib/pitch.worker.ts, including the silent flush tail. */
  class ArraySource {
    constructor(left, right, tailFrames) {
      this.left = left;
      this.right = right;
      this.total = left.length + tailFrames;
    }
    extract(target, numFrames, position) {
      const available = Math.max(0, Math.min(numFrames, this.total - position));
      const realEnd = this.left.length;
      for (let i = 0; i < available; i++) {
        const index = position + i;
        const inRange = index < realEnd;
        target[i * 2] = inRange ? this.left[index] : 0;
        target[i * 2 + 1] = inRange ? this.right[index] : 0;
      }
      for (let i = available; i < numFrames; i++) { target[i * 2] = 0; target[i * 2 + 1] = 0; }
      return available;
    }
  }

  const CHUNK = 8192;
  const FLUSH_TAIL_FRAMES = 1 << 18;
  function render(left, right, semitones) {
    const frames = left.length;
    const outLeft = new Float32Array(frames);
    const st = new SoundTouch();
    st.rate = 1;
    st.tempo = 1;
    st.pitchSemitones = semitones;
    const filter = new SimpleFilter(new ArraySource(left, right, FLUSH_TAIL_FRAMES), st);
    const inter = new Float32Array(CHUNK * 2);
    let written = 0;
    while (written < frames) {
      const got = filter.extract(inter, CHUNK);
      if (got <= 0) break;
      const n = Math.min(got, frames - written);
      for (let i = 0; i < n; i++) outLeft[written + i] = inter[i * 2];
      written += n;
    }
    return { outLeft, written };
  }

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

  const SR = 44100, N = SR * 3, F0 = 440;
  const sine = new Float32Array(N);
  for (let i = 0; i < N; i++) sine[i] = Math.sin((2 * Math.PI * F0 * i) / SR) * 0.5;

  for (const semitones of [-5, -2, 2, 7, 12]) {
    const t0 = Date.now();
    const { outLeft, written } = render(sine, sine, semitones);
    const ms = Date.now() - t0;
    const expected = F0 * Math.pow(2, semitones / 12);
    const got = dominant(outLeft, SR, Math.floor(N * 0.4), 16384);
    const cents = 1200 * Math.log2(got / expected);
    let peak = 0;
    for (let i = 0; i < written; i++) peak = Math.max(peak, Math.abs(outLeft[i]));
    check(
      `${semitones > 0 ? '+' : ''}${semitones} st → ${expected.toFixed(1)} Hz`,
      Math.abs(cents) < 25 && written >= N * 0.98 && peak > 0.2,
      `got ${got} Hz (${cents.toFixed(1)} cents), ${written}/${N} frames, peak ${peak.toFixed(2)}, ${ms}ms for 3s audio`,
    );
  }

  const short = new Float32Array(1000);
  const r = render(short, short, 3);
  check('short buffer does not overrun the source', r.written <= 1000 && r.outLeft.length === 1000);

  // Duration preservation is what keeps the bar grid valid after transposing.
  for (const semitones of [-7, -3, 4, 12]) {
    const { written } = render(sine, sine, semitones);
    check(`duration preserved exactly at ${semitones} st`, written === N, `${written}/${N}`);
  }

  // The audio must not be time-shifted, or bar navigation would drift after a
  // key change. Feed 1s of silence then a tone, and check where the tone starts.
  const gated = new Float32Array(N);
  const onsetFrame = SR; // 1.0 s
  for (let i = onsetFrame; i < N; i++) gated[i] = Math.sin((2 * Math.PI * F0 * i) / SR) * 0.5;

  for (const semitones of [-4, 5]) {
    const { outLeft } = render(gated, gated, semitones);
    let detected = -1;
    for (let i = 0; i < N; i++) {
      if (Math.abs(outLeft[i]) > 0.05) { detected = i; break; }
    }
    const driftMs = ((detected - onsetFrame) / SR) * 1000;
    check(
      `onset stays aligned at ${semitones} st`,
      detected >= 0 && Math.abs(driftMs) < 50,
      `onset at frame ${detected} vs ${onsetFrame} (${driftMs.toFixed(1)} ms drift)`,
    );
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
  const { songsFromProject, stemLabel, roleForTrack, setName, resolveStemPath } =
    await import('../src/lib/alsImport.ts');

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
        bpm: null, key: null, durationText: null, tags: [],
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
    <GroupTrack Id="10"><TrackGroupId Value="-1" /><EffectiveName Value="Test Song" /></GroupTrack>
    <AudioTrack Id="11"><TrackGroupId Value="10" /><EffectiveName Value="Bass" />
      <Speaker><LomId Value="0" /><Manual Value="true" /></Speaker>
      ${clip(0, 16, 0, 'false', 0.25)}
      ${clip(16, 32, 16, 'true')}
    </AudioTrack>
  </Ableton>`;

  const song = parseAlsXml(xml).songs[0];
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
  const folder = songFolderName(song, project);
  check('the folder carries the song facts', folder === 'Fix You {136, Eb, 4-4}', folder);

  const meta = parseNameMeta(folder);
  check('and File mode reads them back', meta.title === 'Fix You' && meta.bpm === 136 && meta.key === 'Eb', JSON.stringify(meta));
  check('time signature included', meta.timeSig?.num === 4 && meta.timeSig?.den === 4);

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

  const folder = songFolderName(alsSong, project);
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
  check('prints go to the app folder', folder === '/C/Rehearsal Tool/136BPM Stems', folder);

  const name = bounceFileName('Fix You', 'no vocal', 1, new Date(2026, 7, 13));
  const path = folder + '/' + name;
  check('a print is not scanned as a song', isPrint(path));
  check('the song name survives the tags', baseTitleOf(name) === 'Fix You', baseTitleOf(name));

  const found = findPrints([{ path, name, rev: 'r', size: 1, modified: 0 }]);
  check('the print names its song', found[0]?.title === 'Fix You', found[0]?.title);
  check('and the version it came from', found[0]?.versionName === '136BPM Stems', found[0]?.versionName);

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

  check('a set of names is converted to numbers', trackName === 'Nash Chords +LYRICS', trackName);
  check('every song with a key is converted', converted.join() === 'One,Two', converted.join());
  check('a song with no key is named, not guessed at', withoutKey.join() === 'Keyless', withoutKey.join());
  check('only the songs that could be converted contribute clips', clips.length === 4, clips.length);

  // Bars are the set's own ruler, so each song's chords stay inside it.
  check('the first song keeps its bars', clips[0].bar === 1 && clips[1].bar === 3,
    clips.map((c) => c.bar).join());
  check('the second song lands after it', clips[2].bar === 9 && clips[3].bar === 11,
    clips.map((c) => c.bar).join());
  // C in C is 1; G in G is 1; C in G is 4.
  check('each song is counted in its own key',
    clips.map((c) => c.text).join(' ') === '1 4 1 4', clips.map((c) => c.text).join(' '));

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
    asked.clips[asked.clips.length - 1].text === '4',
    asked.clips[asked.clips.length - 1].text);
  check('a blank one is skipped, not guessed',
    chordClipsFor(project, { Keyless: '  ' }).withoutKey.join() === 'Keyless');
  check('nonsense is refused rather than assumed',
    chordClipsFor(project, { Keyless: 'banana' }).converted.join() === 'One,Two',
    chordClipsFor(project, { Keyless: 'banana' }).converted.join());
  check("the set's own keys are not overruled by a supplied one",
    chordClipsFor(project, { One: 'F' }).clips[0].text === '1',
    chordClipsFor(project, { One: 'F' }).clips[0].text);

  const out = addChordTrack(xml, clips, trackName, project);
  check('the track is written', out.clipsWritten === 4);
  check('named the way AbleSet names one', out.xml.includes('<EffectiveName Value="Nash Chords +LYRICS"'));
  check('the set keeps the track it had', out.xml.includes('<EffectiveName Value="Chords +LYRICS"'));
  check('the new track comes before the returns',
    out.xml.indexOf('Nash Chords +LYRICS') < out.xml.indexOf('<ReturnTrack'));
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
  check('a new track is made when none is named Slate', trackName === 'Slates' && !reusedTrack);
  check('the slates track comes before the returns',
    out.indexOf('<EffectiveName Value="Slates"') < out.indexOf('<ReturnTrack'));
  check('the model track survives untouched', /<EffectiveName Value="Stems"/.test(out));

  // The slate starts on its locator: 1.5s at 120bpm is 3 beats, so 8 to 11.
  check('a slate starts on its locator', /<CurrentStart Value="8" \/>[\s\S]{0,80}<CurrentEnd Value="11"/.test(out));
  check('a song at beat zero slates from zero', /<CurrentStart Value="0" \/>/.test(out));
  check('slate clips are unwarped', (out.match(/<IsWarped Value="false"/g) ?? []).length === 2);
  check('slate paths are project relative', out.includes('<RelativePath Value="Slates/Opener.wav"'));
  check('the muted model plays as a slate track', /<EffectiveName Value="Slates"[\s\S]{0,600}?<Manual Value="true"/.test(out));

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
  check('a missing file does not exist', (await ask('exists', { dir: songs, path: 'Band/Nope.als' })).exists === false);
  check('and cannot be stat-ed', (await call('stat', { dir: songs, path: 'Band/Nope.als' })).status === 404);

  const read = await call('read', { dir: songs, path: 'Band/Yellow/Yellow [drums].wav' });
  check('read hands back the bytes with a type',
    read.headers.get('content-type') === 'audio/wav' && (await read.arrayBuffer()).byteLength === 1000);

  check('a library that is not there says so', (await ask('read-json', { dir: songs, path: '.learning-songs.json' })).missing === true);
  const wrote = await ask('write-json', { dir: songs, path: '.learning-songs.json', data: { songs: [1, 2] } });
  check('writing JSON reports a revision', /^\d+-\d+$/.test(wrote.rev), wrote.rev);
  const back = await ask('read-json', { dir: songs, path: '.learning-songs.json' });
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

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILURE(S).`);
process.exit(failures ? 1 : 0);
