import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from '../lib/store';
import { usePlayer } from '../lib/usePlayer';
import { useMediaSession } from '../lib/useMediaSession';
import { back, navigate, setlistUrl, songUrl } from '../lib/router';
import { barToSec, formatBarBeat, formatTime, hasTempoChanges, secToBar, tempoAt, tempoSegments, totalBars } from '../lib/bars';
import { formatSemitones, transposeKeyName } from '../lib/pitchService';
import { visibleVariants } from '../lib/songLoader';
import Timeline from './Timeline';
import SongEditor from './SongEditor';
import SettingsView from './SettingsView';
import StemMixer from './StemMixer';
import ChartView from './ChartView';
import ConfidenceMonitor from './ConfidenceMonitor';
import { useSpokenCues } from '../lib/useSpokenCues';
import { cuesAvailable, cuesEnabled, setCuesEnabled } from '../lib/spokenCues';
import { useMidiPatches } from '../lib/useMidiPatches';
import {
  clipsOf, clipsToAdopt, defaultChannel, defaultDeviceId, forgetAdopted, midiEnabled,
  midiSupported, newClip, withClip, withoutClip, type PatchClip,
} from '../lib/midi';
import PatchLane from './PatchLane';
import { parseAls } from '../lib/alsParser';
import { writeClipsToSet } from '../lib/alsWrite';
import { rehearsalCopyPath } from '../lib/alsPatch';
import { canEditLibrary } from '../lib/appMode';
import { readBytes as readSourceBytes, writeFile as writeSourceFile } from '../lib/source';
import { startingPatch } from '../lib/devices';
import ContextMenu, { type MenuAnchor } from './ContextMenu';
import PatchDialog from './PatchDialog';
import TempoDialog from './TempoDialog';
import TimecodeDialog from './TimecodeDialog';
import PrepareSongDialog from './PrepareSongDialog';
import { hasDevices } from '../lib/usePlayer';
import { isAbsoluteRef } from '../lib/localSource';
import type { FileStanding } from '../lib/songLoader';
import { chainSummary, unsupportedIn } from '../lib/fx';
import BlockHead from './BlockHead';
import SetMenu from './SetMenu';
import { allSets, currentSet, otherSetsInProject } from '../lib/songSets';
import { usePlayerBlocks } from '../lib/usePlayerBlocks';
import { hasChart } from '../lib/chart';
import { stemsOf, versionButtons } from '../lib/stemMix';
import { closeRun, positionIn, useRun } from '../lib/run';
import type { Marker, Song } from '../types';

const LOOP_LENGTHS = [2, 4, 8, 16];

/**
 * The player. `shown` is false while the page is held open behind Settings:
 * the song stays loaded and keeps playing, but the shortcuts that reach for
 * the transport are the page's, not the whole window's.
 */
export default function PlayerView({ songId, setlistId, shown = true }: { songId: string; setlistId: string | null; shown?: boolean }) {
  const { library, settings, updateSong, pickResourcesFolder } = useStore();
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const song = library.songs.find((s) => s.id === songId) ?? null;

  /*
   * The run this song belongs to: the songs someone opened together, kept
   * decoded so stepping between them costs nothing. Opening a song that isn't
   * one of them ends it — a run you didn't ask for quietly governing Next is
   * worse than no run at all.
   */
  const run = useRun();
  const runAt = positionIn(run, songId);
  useEffect(() => {
    if (run.songIds.length && !run.songIds.includes(songId)) closeRun();
  }, [songId, run]);

  /*
   * The rest of the run, in the order it will be wanted: what is still to come
   * first, then what is behind, so Next is ready before Previous is.
   */
  const ahead = useMemo(() => {
    if (!runAt) return [];
    const ids = [...run.songIds.slice(runAt.index + 1), ...run.songIds.slice(0, runAt.index).reverse()];
    return ids
      .map((id) => library.songs.find((s) => s.id === id))
      .filter((s): s is Song => !!s);
  }, [run, runAt?.index, library.songs]);

  const player = usePlayer(song, settings.cacheBudgetGB, settings.keepAwake, ahead, settings.runMemoryGB);
  const [jump, setJump] = useState(settings.jumpSizes[1] ?? 4);
  const [editing, setEditing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bigWords, setBigWords] = useState(false);
  const [setMenu, setSetMenu] = useState(false);
  const [timecode, setTimecode] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [cues, setCues] = useState(cuesEnabled);
  /*
   * Held in state rather than read while rendering. Settings opens as a panel
   * on top of the player, and switching patch changes on there writes to the
   * device without telling React — so the send loop went on believing it was
   * off until something unrelated re-rendered the page.
   */
  const [midiOn, setMidiOn] = useState(midiEnabled);
  const editorRef = useRef<HTMLDivElement>(null);

  /*
   * The last loop that was set, so the button by the play control is a real
   * toggle: release it to hear the passage in context, tap again to get the
   * same loop back rather than having to mark it out a second time.
   */
  const lastLoop = useRef<{ startSec: number; endSec: number } | null>(null);
  const toggleLoop = () => {
    if (player.loop) {
      lastLoop.current = player.loop;
      player.setLoop(null);
    } else if (lastLoop.current) {
      player.setLoop(lastLoop.current);
    } else {
      player.loopBarsFromHere(jump);
    }
  };

  /*
   * The editor sits near the top of the page, so opening it from the header
   * while scrolled down at the mixer put it off-screen above — it looked as
   * though the button had done nothing. Bring it into view instead.
   */
  useEffect(() => {
    if (!editing) return;
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [editing]);

  /**
   * Closing Settings is also when anything it changed on this device gets read
   * back — there is no event for a localStorage write, and the player is still
   * mounted underneath the whole time it's open.
   */
  const closeSettings = () => {
    setSettingsOpen(false);
    setMidiOn(midiEnabled());
  };

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);


  /*
   * The set this song sits in — the setlist you came from, or the folder it
   * lives in — and everything else reachable from it. Worth a menu only when
   * there is somewhere else to go: on a lone song the title is just a title.
   */
  const sets = useMemo(() => allSets(library), [library]);
  const set = useMemo(() => currentSet(library, songId, setlistId), [library, songId, setlistId]);
  const canBrowseSet =
    !!set && (set.songs.length > 1 || otherSetsInProject(sets, set).length > 0);

  const setlist = setlistId ? library.setlists.find((s) => s.id === setlistId) ?? null : null;
  const setlistIndex = setlist ? setlist.songIds.indexOf(songId) : -1;

  /*
   * What Previous and Next walk along: the run when this song is in one, and
   * otherwise the setlist it was opened from. A run outranks the setlist,
   * being the songs actually chosen to work through.
   */
  const step =
    runAt ??
    (setlist && setlistIndex >= 0
      ? {
          index: setlistIndex,
          total: setlist.songIds.length,
          prev: setlistIndex > 0 ? setlist.songIds[setlistIndex - 1] : null,
          next:
            setlistIndex < setlist.songIds.length - 1 ? setlist.songIds[setlistIndex + 1] : null,
        }
      : null);
  const prevSongId = step?.prev ?? null;
  const nextSongId = step?.next ?? null;
  const goToSong = (id: string) => navigate(songUrl(id, setlistId ?? run.setlistId ?? undefined));
  /** A song already decoded opens the moment you ask for it. */
  const heldReady = (id: string | null) => !!id && player.readySongIds.includes(id);

  const variants = useMemo(() => (song ? visibleVariants(song) : []), [song]);
  const allStems = useMemo(() => (song ? stemsOf(song) : []), [song]);

  /*
   * Version buttons only when there are no stems. With stems, a mix is a
   * channel in the mixer with its own fader, so a button switching it on and
   * off would be a second control fighting the first.
   */
  const mixes = useMemo(() => (song ? versionButtons(song) : []), [song]);
  const stems = allStems;

  const blocks = usePlayerBlocks(song?.id ?? '');

  // Sections called out loud as they come up, over whatever is playing.
  useSpokenCues(song ?? null, player.subscribePosition, player.playing, cues && cuesAvailable());

  /*
   * Patch changes to whatever is on stage. Kept in state as well as on the
   * device so the lane redraws as you edit, and so the send loop picks a change
   * up on the next pass rather than at the next reload.
   */
  const [patchEdit, setPatchEdit] = useState<{ clip: PatchClip; existing: boolean } | null>(null);
  /* Counts edits, not clips: moving one changes nothing about the length. */
  const [clipRev, setClipRev] = useState(0);
  const clips = useMemo(() => (song ? clipsOf(song) : []), [song?.patchClips]);

  /*
   * Clips programmed before they were saved with the song are still sitting on
   * this device. Bring them in once, on the way past.
   */
  useEffect(() => {
    if (!song) return;
    const adopted = clipsToAdopt(song);
    if (!adopted) return;
    updateSong(song.id, { patchClips: adopted });
    forgetAdopted(song.id);
  }, [song?.id]);

  /*
   * Writing the set's patch changes into a copy of the .als beside it. The
   * whole set goes at once, since it's one file — every song in it the library
   * knows about, not just this one.
   *
   * Read from the copy when there is one, so anything done in Ableton since
   * the last write survives; from the original otherwise.
   */
  const [setWrite, setSetWrite] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  const writeToSet = async () => {
    if (!song?.setPath) return;
    setWriting(true);
    setSetWrite(null);
    try {
      const copy = rehearsalCopyPath(song.setPath);
      const readFrom = async (path: string) => (await readSourceBytes(path)).bytes;
      const source = await readFrom(copy).then(
        (bytes) => ({ bytes, path: copy }),
        async () => ({ bytes: await readFrom(song.setPath!), path: song.setPath! }),
      );
      const result = await writeClipsToSet({
        alsPath: source.path,
        project: await parseAls(source.bytes),
        songs: library.songs,
        readBytes: readFrom,
        writeFile: writeSourceFile,
      });
      const missed = result.missed.length
        ? ` ${result.missed.length} song${result.missed.length === 1 ? '' : 's'} in the set aren't in the library, so nothing went in for them.`
        : '';
      setSetWrite(
        `Wrote ${result.written} change${result.written === 1 ? '' : 's'} to ${result.path.split('/').pop()}. Open that one in Ableton.${missed}`,
      );
    } catch (err) {
      setSetWrite(err instanceof Error ? err.message : String(err));
    } finally {
      setWriting(false);
    }
  };

  const commitClips = (next: PatchClip[]) => {
    if (song) updateSong(song.id, { patchClips: next });
    setClipRev((n) => n + 1);
    setPatchEdit(null);
  };

  useMidiPatches(song ?? null, player.subscribePosition, player.playing, midiOn, clipRev);

  /*
   * Remember how long the song is, once something has decoded it. A setlist can
   * then show its running order without opening every song in it. Written only
   * when the number is actually new, since a library file churning on every
   * play would sync for no reason.
   */
  useEffect(() => {
    if (!song || !player.ready || player.duration <= 0) return;
    if (Math.abs((song.durationSec ?? 0) - player.duration) < 0.5) return;
    updateSong(song.id, { durationSec: player.duration });
  }, [song?.id, player.ready, player.duration]);

  // Always offer whatever is currently selected, even if Settings no longer lists it.
  const jumpChoices = useMemo(
    () => [...new Set([...settings.jumpSizes, jump])].sort((a, b) => a - b),
    [settings.jumpSizes, jump],
  );

  /* ----------------------------- lock screen ------------------------------ */

  useMediaSession({
    song,
    playing: player.playing,
    position: player.position,
    duration: player.duration,
    play: player.play,
    pause: player.pause,
    seek: player.seek,
    jumpBars: player.jumpBars,
    onPrevious: prevSongId ? () => goToSong(prevSongId) : undefined,
    onNext: nextSongId ? () => goToSong(nextSongId) : undefined,
  });

  /* ------------------------------- shortcuts ------------------------------- */

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          player.toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          player.jumpBars(-(e.shiftKey ? jump * 4 : jump));
          break;
        case 'ArrowRight':
          e.preventDefault();
          player.jumpBars(e.shiftKey ? jump * 4 : jump);
          break;
        case 'ArrowUp':
          e.preventDefault();
          player.cycleVariant(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          player.cycleVariant(1);
          break;
        case 'm':
        case 'M':
          player.toggleClick();
          break;
        case 'l':
        case 'L':
          // Toggle: clear an active loop, otherwise loop the current jump length.
          if (player.loop) player.setLoop(null);
          else player.loopBarsFromHere(jump);
          break;
        case 'Escape':
          player.setLoop(null);
          break;
        default:
          if (/^[1-9]$/.test(e.key)) {
            const variant = mixes[Number(e.key) - 1];
            if (variant) player.setVariant(variant.id);
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, jump, variants, shown]);

  if (!song) {
    return (
      <div className="player-shell">
        <div className="topbar">
          <button className="icon-btn" onClick={() => back()}>
            ‹
          </button>
          <h1>Song not found</h1>
        </div>
        <div className="empty">
          <p>This song is no longer in your library. Rescan the folder to refresh.</p>
          <button className="btn" onClick={() => navigate('/')}>
            Back to songs
          </button>
        </div>
      </div>
    );
  }

  /*
   * The lengths the page lays itself out against. `player.duration` is 0 until
   * something has decoded, so anything drawn along the song falls back to the
   * length the library remembers — otherwise the rig lane collapses into a
   * sliver every time a song is opened and only spreads out once it loads.
   */
  const laidOutSec = player.duration || song.durationSec || 0;
  const bars = totalBars(player.duration, song);
  const currentBar = Math.max(1, Math.floor(secToBar(player.position, song)));
  const displayKey = transposeKeyName(song.originalKey, song.transpose);

  const setTranspose = (semitones: number) => {
    const clamped = Math.max(-12, Math.min(12, semitones));
    if (clamped !== song.transpose) updateSong(song.id, { transpose: clamped });
  };

  return (
    <div className="player-shell">
      <div className="topbar">
        <button className="icon-btn" onClick={() => (setlist ? navigate(setlistUrl(setlistId!)) : navigate('/'))} aria-label="Back">
          ‹
        </button>
        <h1>
          {canBrowseSet ? (
            <button
              className="song-title-btn"
              onClick={() => setSetMenu((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={setMenu}
              title="The other songs in this set"
            >
              {song.title}
              <span className={setMenu ? 'caret open' : 'caret'} aria-hidden>
                ▾
              </span>
            </button>
          ) : (
            song.title
          )}
          <span className="sub" style={{ display: 'block' }}>
            {song.tempoUnset ? 'tempo not set' : tempoSummary(song)} · {song.timeSigNum}/{song.timeSigDen}
            {displayKey ? ` · ${displayKey}` : song.transpose ? ` · ${formatSemitones(song.transpose)}` : ''}
            {step ? ` · ${step.index + 1}/${step.total}` : ''}
          </span>
        </h1>
        {canEditLibrary && (
          <button
            className={editing ? 'icon-btn on' : 'icon-btn'}
            onClick={() => setEditing((v) => !v)}
            aria-label="Song settings"
            title="Tempo, key, grouping and setlists for this song"
          >
            ✎
          </button>
        )}
        {/*
          The player has no tab bar, so app settings were unreachable without
          backing out of the song first. Opened as a panel on top rather than a
          route, so the song carries on playing underneath.
        */}
        <button
          className="icon-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label="App settings"
          title="App settings"
        >
          ⚙
        </button>

        {/* Inside the topbar, so it hangs from it without a hardcoded offset. */}
        {setMenu && set && (
          <SetMenu current={set} sets={sets} songId={songId} onClose={() => setSetMenu(false)} />
        )}
      </div>

      {player.loading && (
        <div className="loading-bar">
          <div style={{ width: `${loadPercent(player.progress)}%` }} />
        </div>
      )}

      <div className="player-scroll">
        {(player.files.forbidden.length > 0 || player.files.missing.length > 0 || player.files.failed.length > 0) && (
          <div className="notice stack">
            {player.files.forbidden.length > 0 && (
              <>
                <span>
                  <strong>
                    {player.files.forbidden.length} file{player.files.forbidden.length === 1 ? '' : 's'} for this song
                    {player.files.forbidden.length === 1 ? ' is' : ' are'} in a folder the studio hasn't been allowed to read
                  </strong>
                  {commonFolder(player.files.forbidden) ? (
                    <>
                      : <span className="code">{commonFolder(player.files.forbidden)}</span>
                    </>
                  ) : null}
                  . Read only, never written.
                </span>
                {resourcesError && <span style={{ color: 'var(--bad)' }}>{resourcesError}</span>}
                <div className="btn-row">
                  <button
                    className="btn primary"
                    onClick={() =>
                      void pickResourcesFolder(commonFolder(player.files.forbidden) ?? undefined).catch((err) => {
                        if (!/abort/i.test(String(err?.message ?? err))) setResourcesError(String(err?.message ?? err));
                      })
                    }
                  >
                    Allow that folder
                  </button>
                </div>
              </>
            )}
            {player.files.missing.length > 0 && (
              <span>
                <strong>Not in your folder:</strong> {describeStanding(player.files.missing)}. Copy{' '}
                {player.files.missing.length === 1 ? 'it' : 'them'} in and rescan; the song plays without{' '}
                {player.files.missing.length === 1 ? 'it' : 'them'} until then.
              </span>
            )}
            {player.files.failed.length > 0 && (
              <span>
                <strong>Left out:</strong>{' '}
                {player.files.failed.map((f) => `${f.part} (${f.reason})`).join('; ')}.
              </span>
            )}
          </div>
        )}
        {hasDevices(song) && !player.effectsDecided && (
          <div className="notice stack">
            <span>
              <strong>This song runs through devices in Live.</strong> {describeDevices(song)}{' '}
              Imitate them here with Web Audio — a likeness, not a match — or play the files raw?
            </span>
            <div className="btn-row">
              <button className="btn primary" onClick={() => player.setEffects(true)}>
                Imitate the devices
              </button>
              <button className="btn" onClick={() => player.setEffects(false)}>
                Play raw
              </button>
            </div>
          </div>
        )}
        {song.caveats?.length ? (
          <div className="notice">
            <strong>Not quite as Ableton plays it.</strong> {song.caveats.join(' ')}
          </div>
        ) : null}
        {song.variants.length === 0 && (
          <div className="notice">
            None of this song's audio is in the folder. The set points at stems that aren't
            here — copy them into the project (Live's Collect All and Save does it) and rescan.
          </div>
        )}
        {song.tempoUnset && (
          <div className="notice spread">
            <span>
              {canEditLibrary
                ? 'Set the tempo to enable bar navigation.'
                : 'This song has no tempo yet, so bars and loops are unavailable. Whoever runs the band can set it.'}
            </span>
            {canEditLibrary && (
              <button className="btn" style={{ minHeight: 36 }} onClick={() => setEditing(true)}>
                Set tempo
              </button>
            )}
          </div>
        )}

        {player.error && <div className="notice error">{player.error}</div>}

        {player.audioState === 'suspended' && (
          <div className="notice spread">
            <span>Audio is waiting for a tap — your browser blocks sound until you interact.</span>
            <button className="btn" style={{ minHeight: 36 }} onClick={() => void player.unlock()}>
              Enable audio
            </button>
          </div>
        )}

        {player.loading && player.progress && (
          <div className="notice">
            {describeProgress(player.progress)}
          </div>
        )}

        {editing && (
          <div ref={editorRef}>
            <SongEditor song={song} onClose={() => setEditing(false)} />
          </div>
        )}

        {timecode && (
          <TimecodeDialog
            song={song}
            durationSec={player.duration || song.durationSec || 0}
            onClose={() => setTimecode(false)}
          />
        )}

        {bigWords && (
          <ConfidenceMonitor song={song} player={player} onClose={() => setBigWords(false)} />
        )}

        {patchEdit && (
          <PatchDialog
            song={song}
            duration={laidOutSec}
            clip={patchEdit.clip}
            onClose={() => setPatchEdit(null)}
            onSave={(clip) => commitClips(withClip(clips, clip))}
            onDelete={
              patchEdit.existing
                ? () => commitClips(withoutClip(clips, patchEdit.clip.id))
                : undefined
            }
          />
        )}

        {player.audioReport && (
          <div className="sheet-backdrop" onClick={() => player.showAudioReport(false)}>
            <div className="dialog" role="dialog" aria-label="Audio diagnostics" onClick={(e) => e.stopPropagation()}>
              <h3>Audio path</h3>
              <p className="dialog-note">
                What this device's audio is actually doing. Read it out if the app is silent.
              </p>
              <pre className="report mono">{player.audioReport}</pre>
              <div className="btn-row">
                <button className="btn" onClick={() => player.showAudioReport(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {settingsOpen && (
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
            <SettingsView onClose={closeSettings} />
          </div>
        )}

        <div className="readout">
          <div className="bar-num mono">
            {currentBar}
            <span className="beat">.{formatBarBeat(player.position, song).split('.')[1] ?? '1'}</span>
          </div>
          <div className="of-bars">bar of {bars}</div>
          <div className="time mono">
            {formatTime(player.position)} / {formatTime(player.duration)}
          </div>
          <TempoReadout song={song} bar={currentBar} />
        </div>

        <Timeline
          song={song}
          duration={player.duration}
          position={player.position}
          loop={player.loop}
          onSeek={player.seek}
          onLoopDrag={player.setLoop}
          subscribePosition={player.subscribePosition}
        />

        <div className="transport">
          <button className="jump-btn" onClick={() => player.jumpBars(-jump)} aria-label={`Back ${jump} bars`}>
            ‹‹
            <span className="unit">{jump} BAR</span>
          </button>
          <button
            className="play-btn"
            onClick={() => player.toggle()}
            disabled={!player.ready}
            aria-label={player.playing ? 'Pause' : 'Play'}
          >
            {player.playing ? '❙❙' : '▶'}
          </button>
          <button className="jump-btn" onClick={() => player.jumpBars(jump)} aria-label={`Forward ${jump} bars`}>
            ››
            <span className="unit">{jump} BAR</span>
          </button>
          {hasChart(song) && (
            <button
              className="jump-btn"
              onClick={() => setBigWords(true)}
              aria-label="Show the words big"
              title="Big words, for playing to"
            >
              Aa
              <span className="unit">WORDS</span>
            </button>
          )}
          <button
            className={player.loop ? 'jump-btn loop-btn on' : 'jump-btn loop-btn'}
            onClick={toggleLoop}
            aria-pressed={!!player.loop}
            aria-label={player.loop ? 'Turn the loop off' : 'Loop from here'}
            title={
              player.loop
                ? `Looping bars ${Math.round(secToBar(player.loop.startSec, song))}–${Math.round(secToBar(player.loop.endSec, song))} — tap to release`
                : lastLoop.current
                  ? 'Put the last loop back'
                  : `Loop ${jump} bars from here`
            }
          >
            ⟲
            <span className="unit">
              {player.loop
                ? `${Math.round(secToBar(player.loop.startSec, song))}–${Math.round(secToBar(player.loop.endSec, song))}`
                : 'LOOP'}
            </span>
          </button>
        </div>

        {song.setPath && song.variants.length > 0 && (
          <button className="btn primary prepare-btn" onClick={() => setPreparing(true)}>
            Prepare song for Rehearsal Tool
            <span className="unit">choose the parts, print them small, hand them to the band</span>
          </button>
        )}

        {preparing && <PrepareSongDialog song={song} onClose={() => setPreparing(false)} />}

        <div className="blocks" onPointerMove={blocks.onMove} onPointerUp={blocks.endDrag} onPointerCancel={blocks.endDrag}>
          {blocks.order.map((id) => {
            const chrome = blocks.chromeFor(id);
            if (id === 'chart') {
              return hasChart(song) ? (
                <div key={id} ref={blocks.refFor(id)}>
                  <ChartView song={song} player={player} chrome={chrome} />
                </div>
              ) : null;
            }
            if (id === 'versions') {
              return mixes.length > 0 ? (
                <div key={id} ref={blocks.refFor(id)}>
                  <section className={chrome.dragging ? 'block dragging' : 'block'} aria-label="Versions">
                    <BlockHead title="Versions" chrome={chrome} />
                    {!chrome.collapsed && (
                      <div className="variants" role="group" aria-label="Versions">
                        {mixes.map((variant, i) => (
                          <button
                            key={variant.id}
                            className={player.activeVariantId === variant.id ? 'variant-btn on' : 'variant-btn'}
                            onClick={() => player.setVariant(variant.id)}
                          >
                            <span className="name">{variant.name}</span>
                            <span className="hint">{i < 9 ? `press ${i + 1}` : ''}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              ) : null;
            }
            if (id === 'mixer') {
              return stems.length > 0 ? (
                <div key={id} ref={blocks.refFor(id)}>
                  <StemMixer song={song} player={player} chrome={chrome} />
                </div>
              ) : null;
            }
            if (id === 'navigate') {
              return (
                <div key={id} ref={blocks.refFor(id)}>
                  <section className={chrome.dragging ? 'block dragging' : 'block'} aria-label="Navigate">
                    <BlockHead title="Navigate" chrome={chrome} />
                    {!chrome.collapsed && (
                      <>
                        <div className="controls flush" role="group" aria-label="Moving around">
                          <label className="chip jump-picker">
                            Jump
                            <select
                              className="jump-select"
                              value={jump}
                              onChange={(e) => setJump(Number(e.target.value))}
                              aria-label="Bars to jump"
                            >
                              {jumpChoices.map((size) => (
                                <option key={size} value={size}>
                                  {size} bar{size === 1 ? '' : 's'}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button className="chip" onClick={() => player.seek(barToSec(1, song))}>
                            ⏮ Top
                          </button>
                          {cuesAvailable() && song.markers.length > 0 && (
                            <button
                              className={cues ? 'chip on' : 'chip'}
                              onClick={() => {
                                setCues(!cues);
                                setCuesEnabled(!cues);
                              }}
                              aria-pressed={cues}
                              title="Call each section out loud, a bar before it arrives"
                            >
                              🗣 Cues
                            </button>
                          )}
                          {LOOP_LENGTHS.map((len) => (
                            <button key={len} className="chip" onClick={() => player.loopBarsFromHere(len)}>
                              ⟲ {len}
                            </button>
                          ))}
                          {player.loop && (
                            <button className="chip on" onClick={() => player.setLoop(null)}>
                              ✕ Loop{' '}
                              {Math.round(secToBar(player.loop.startSec, song))}–
                              {Math.round(secToBar(player.loop.endSec, song))}
                            </button>
                          )}
                        </div>
                        <MarkerStrip
                          song={song}
                          duration={player.duration}
                          currentBar={currentBar}
                          onJump={(bar) => player.seek(barToSec(bar, song))}
                          onLoop={(startBar, endBar) => {
                            player.setLoop({
                              startSec: barToSec(startBar, song),
                              endSec: barToSec(endBar, song),
                            });
                            player.seek(barToSec(startBar, song));
                          }}
                          onPatchAt={(bar) =>
                            setPatchEdit({
                              clip:
                                clips.find((c) => c.bar === bar) ??
                                newClip(bar, startingPatch(defaultDeviceId(), defaultChannel())),
                              existing: clips.some((c) => c.bar === bar),
                            })
                          }
                        />
                      </>
                    )}
                  </section>
                </div>
              );
            }
            if (id === 'rig') {
              return (
                <div key={id} ref={blocks.refFor(id)}>
                  <section className={chrome.dragging ? 'block dragging' : 'block'} aria-label="Rig">
                    <BlockHead
                      title="Rig"
                      chrome={chrome}
                      extra={
                        <div className="block-actions">
                          <button
                            className="chip"
                            onClick={() =>
                              setPatchEdit({
                                clip: newClip(currentBar, startingPatch(defaultDeviceId(), defaultChannel())),
                                existing: false,
                              })
                            }
                          >
                            + At bar {currentBar}
                          </button>
                          {song.setPath && (
                            <button
                              className="chip"
                              disabled={writing}
                              onClick={() => void writeToSet()}
                              title="Write every patch change in this set into a copy of the .als"
                            >
                              {writing ? 'Writing…' : 'Commit to .als'}
                            </button>
                          )}
                          <button className="chip" onClick={() => setTimecode(true)} title="LTC for playback">
                            Timecode…
                          </button>
                        </div>
                      }
                    />
                    {!chrome.collapsed && (
                      <>
                        <PatchLane
                          song={song}
                          duration={laidOutSec}
                          clips={clips}
                          markers={song.markers}
                          onEdit={(clip) => setPatchEdit({ clip, existing: true })}
                          onMove={(clip, bar) => commitClips(withClip(clips, { ...clip, bar }))}
                          onResize={(clip, lengthBars) =>
                            commitClips(withClip(clips, { ...clip, lengthBars }))
                          }
                          onAddAt={(bar) =>
                            setPatchEdit({
                              clip: newClip(bar, startingPatch(defaultDeviceId(), defaultChannel())),
                              existing: false,
                            })
                          }
                          subscribePosition={player.subscribePosition}
                        />
                        {setWrite && <div className="notice">{setWrite}</div>}
                        {!midiSupported() ? (
                          <div className="control-note">
                            This window can't send MIDI itself. Patch changes programmed here go
                            into the set — commit them to the .als and Live drives the rig.
                          </div>
                        ) : (
                          !midiOn &&
                          clips.length > 0 && (
                            <div className="control-note">
                              Switch patch changes on in Settings and these will be sent as you play.
                            </div>
                          )
                        )}
                        {/*
                          What the set itself sends the rig during this song: its MIDI,
                          video and timecode tracks, clip by clip. Read from the set and
                          shown as a running order, since Live is what plays them.
                        */}
                        {song.rig?.length ? (
                          <div className="rig-tracks">
                            {song.rig.map((track) => (
                              <div className="rig-track" key={track.name}>
                                <div className="rig-track-name">
                                  <span className={`badge ${track.kind === 'midi' ? '' : 'ok'}`}>{track.kind}</span>
                                  {track.name}
                                </div>
                                <div className="rig-clips">
                                  {track.clips.map((clip, i) => (
                                    <span className="rig-clip" key={i} title={clip.name}>
                                      <span className="mono">
                                        {clip.endBar > clip.bar
                                          ? `${formatBar(clip.bar)}–${formatBar(clip.endBar)}`
                                          : formatBar(clip.bar)}
                                      </span>{' '}
                                      {clip.name}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="control-note">
                            No MIDI, video or timecode tracks in the set play during this song.
                          </div>
                        )}
                      </>
                    )}
                  </section>
                </div>
              );
            }
            return (
              <div key={id} ref={blocks.refFor(id)}>
                <section className={chrome.dragging ? 'block dragging' : 'block'} aria-label="Song">
                  <BlockHead title="Song" chrome={chrome} />
                  {!chrome.collapsed && (
                    <>
                      <div className="controls flush" role="group" aria-label="Key">
                        <span className="control-label">Key</span>
                        <button
                          className="chip"
                          onClick={() => setTranspose(song.transpose - 1)}
                          aria-label="Down a semitone"
                        >
                          −
                        </button>
                        <button
                          className={song.transpose !== 0 ? 'chip on' : 'chip'}
                          onClick={() => setTranspose(0)}
                          title="Tap to reset to the original key"
                        >
                          {displayKey ?? formatSemitones(song.transpose)}
                        </button>
                        <button
                          className="chip"
                          onClick={() => setTranspose(song.transpose + 1)}
                          aria-label="Up a semitone"
                        >
                          +
                        </button>
                        <span className="control-note">
                          changing the key re-renders every part — a few seconds
                        </span>
                      </div>
                      <TempoControl song={song} />

                    </>
                  )}
                </section>
              </div>
            );
          })}
        </div>


        {(prevSongId || nextSongId) && (
          <div className="controls">
            <button className="chip" disabled={!prevSongId} onClick={() => prevSongId && goToSong(prevSongId)}>
              ‹ Previous
              {heldReady(prevSongId) && <span className="chip-note">ready</span>}
            </button>
            <button className="chip" disabled={!nextSongId} onClick={() => nextSongId && goToSong(nextSongId)}>
              Next ›
              {heldReady(nextSongId) && <span className="chip-note">ready</span>}
            </button>
            {runAt && (
              <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                {player.readySongIds.length} of {runAt.total} held ready
              </span>
            )}
          </div>
        )}

        <div style={{ height: 'calc(16px + var(--safe-bottom))' }} />
      </div>
    </div>
  );
}

/**
 * The song's tempo as a headline: one number normally, the range it covers when
 * the song actually moves, so the topbar doesn't claim a steady 136 for a song
 * that spends half its length at 140.
 */
function tempoSummary(song: import('../types').Song): string {
  if (!hasTempoChanges(song)) return `${round(song.bpm)} BPM`;
  const bpms = tempoSegments(song).map((seg) => seg.bpm);
  return `${round(Math.min(...bpms))}–${round(Math.max(...bpms))} BPM`;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * The tempo under the playhead.
 *
 * Highlighted briefly whenever it changes, so a tempo step is something you
 * notice rather than something you have to be watching for.
 */
function TempoReadout({ song, bar }: { song: import('../types').Song; bar: number }) {
  const bpm = round(tempoAt(song, bar));
  const [flash, setFlash] = useState(false);
  const previous = useRef(bpm);

  useEffect(() => {
    if (previous.current === bpm) return;
    previous.current = bpm;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 900);
    return () => window.clearTimeout(timer);
  }, [bpm]);

  const moves = hasTempoChanges(song);
  return (
    <div className={flash ? 'tempo-now changed' : 'tempo-now'}>
      <span className="mono">{bpm}</span> BPM
      {moves && <span className="tempo-hint">tempo map</span>}
    </div>
  );
}

/**
 * Changing how fast the song plays.
 *
 * Only the real thing lives here. There was a BPM box beside it that set the
 * song's stored tempo — where its bars fall — which reads as a speed control
 * but isn't one: the recording plays at its own speed whatever that number
 * says. Two adjacent controls, one of which silently did nothing to the sound,
 * was worse than one. Setting a song's tempo is still in the song editor,
 * where it belongs, next to key and time signature.
 */
function TempoControl({ song }: { song: import('../types').Song }) {
  const { updateSong } = useStore();
  const [changing, setChanging] = useState(false);
  const scale = song.tempoScale ?? 1;

  return (
    <div className="controls flush" role="group" aria-label="Speed">
      <span className="control-label">Speed</span>
      <button className="chip" onClick={() => setChanging(true)}>
        {scale === 1 ? 'Change speed…' : `${Math.round(scale * 100)}% — change…`}
        <span className="chip-note">re-renders audio</span>
      </button>
      {scale !== 1 && (
        <button
          className="chip"
          onClick={() => updateSong(song.id, { tempoScale: undefined })}
          title="Back to the recording's own speed"
        >
          Reset
        </button>
      )}

      {changing && (
        <TempoDialog
          song={song}
          onCancel={() => setChanging(false)}
          onSubmit={(next) => {
            setChanging(false);
            updateSong(song.id, { tempoScale: next === 1 ? undefined : next });
          }}
        />
      )}
    </div>
  );
}

function MarkerStrip({
  song,
  duration,
  currentBar,
  onJump,
  onLoop,
  onPatchAt,
}: {
  song: import('../types').Song;
  duration: number;
  currentBar: number;
  onJump: (bar: number) => void;
  onLoop: (startBar: number, endBar: number) => void;
  /** Place a patch change at a bar; the Rig block owns the clips themselves. */
  onPatchAt: (bar: number) => void;
}) {
  const { updateSong } = useStore();
  const [menu, setMenu] = useState<{ at: MenuAnchor; marker: Marker } | null>(null);

  const sorted = (markers: Marker[]) => [...markers].sort((a, b) => a.bar - b.bar);

  const addMarker = () => {
    const name = window.prompt(`Name for a marker at bar ${currentBar}`, 'Chorus');
    if (!name) return;
    const marker = { id: `m_${Date.now().toString(36)}`, name: name.trim(), bar: currentBar };
    updateSong(song.id, { markers: sorted([...song.markers, marker]) });
  };

  const removeMarker = (id: string) => {
    updateSong(song.id, { markers: song.markers.filter((m) => m.id !== id) });
  };

  const renameMarker = (marker: Marker) => {
    const name = window.prompt('Section name', marker.name);
    if (!name?.trim()) return;
    updateSong(song.id, {
      markers: song.markers.map((m) => (m.id === marker.id ? { ...m, name: name.trim() } : m)),
    });
  };

  const retimeMarker = (marker: Marker) => {
    const raw = window.prompt(`Bar for “${marker.name}”`, String(marker.bar));
    if (raw === null) return;
    const bar = Number(raw);
    if (!Number.isFinite(bar) || bar < 1) {
      window.alert('That needs to be a bar number, 1 or higher.');
      return;
    }
    updateSong(song.id, {
      markers: sorted(song.markers.map((m) => (m.id === marker.id ? { ...m, bar } : m))),
    });
  };

  /** A section runs to the next marker, or to the end of the song. */
  const sectionEnd = (marker: Marker): number => {
    const next = sorted(song.markers).find((m) => m.bar > marker.bar);
    return next ? next.bar : totalBars(duration, song) + 1;
  };

  const openMenu = (e: ReactMouseEvent, marker: Marker) => {
    e.preventDefault();
    setMenu({ at: { x: e.clientX, y: e.clientY }, marker });
  };

  return (
    <div className="controls" role="group" aria-label="Sections">
      {song.markers.map((marker) => (
        <button
          key={marker.id}
          className="chip"
          onClick={() => onJump(marker.bar)}
          onContextMenu={(e) => openMenu(e, marker)}
          title={canEditLibrary ? 'Right-click for section options' : 'Right-click to loop this section'}
        >
          {marker.name} <span style={{ opacity: 0.6 }}>{marker.bar}</span>
        </button>
      ))}
      {canEditLibrary && (
        <button className="chip" onClick={addMarker}>
          + Marker
        </button>
      )}

      {menu && (
        <ContextMenu
          at={menu.at}
          label={`Options for ${menu.marker.name}`}
          onClose={() => setMenu(null)}
          items={[
            {
              label: `Loop this section (bars ${menu.marker.bar}–${sectionEnd(menu.marker) - 1})`,
              onSelect: () => onLoop(menu.marker.bar, sectionEnd(menu.marker)),
            },
            ...(midiSupported()
              ? [
                  {
                    label: `Patch change at bar ${menu.marker.bar}…`,
                    onSelect: () => onPatchAt(menu.marker.bar),
                  },
                ]
              : []),
            // Naming a section, moving it and deleting it describe the song
            // itself, which only the build that can save one may offer.
            ...(canEditLibrary
              ? [
                  { label: 'Rename…', onSelect: () => renameMarker(menu.marker) },
                  { label: 'Change bar…', onSelect: () => retimeMarker(menu.marker) },
                  {
                    label: 'Delete',
                    danger: true,
                    onSelect: () => {
                      if (window.confirm(`Delete section “${menu.marker.name}”?`)) {
                        removeMarker(menu.marker.id);
                      }
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}

function loadPercent(progress: import('../lib/songLoader').LoadProgress | null): number {
  if (!progress) return 4;
  const per = 100 / Math.max(1, progress.total);
  return Math.min(100, (progress.index - 1) * per + progress.ratio * per);
}

function describeProgress(p: import('../lib/songLoader').LoadProgress): string {
  const where = `${p.index} of ${p.total}`;
  switch (p.phase) {
    case 'downloading':
      return p.cached ? `Loading “${p.variantName}” (${where})…` : `Downloading “${p.variantName}” (${where}) — ${Math.round(p.ratio * 100)}%`;
    case 'decoding':
      return `Decoding “${p.variantName}” (${where})…`;
    case 'transposing':
      return `Transposing “${p.variantName}” (${where}) — ${Math.round(p.ratio * 100)}%`;
    default:
      return 'Ready';
  }
}

/**
 * What the song's parts run through, track by track, and what among it
 * cannot be imitated — said before anyone chooses. A return bus's chain is
 * output processing, the venue's rather than the song's, and is not listed.
 */
function describeDevices(song: Song): string {
  const parts: string[] = [];
  const cannot = new Set<string>();
  for (const v of song.variants) {
    if (v.devices?.some((d) => d.on)) {
      parts.push(`${chainSummary(v.devices)} on ${v.name}`);
      for (const u of unsupportedIn(v.devices)) cannot.add(u);
    }
  }
  const list = parts.length ? `${parts.join('; ')}.` : '';
  const no = cannot.size ? ` Cannot be imitated at all: ${[...cannot].join(', ')}.` : '';
  return `${list}${no}`;
}

/** The folder a set of files share, when they do: the longest path they all start with. */
function commonFolder(files: FileStanding[]): string | null {
  const paths = files.map((f) => (isAbsoluteRef(f.path) ? f.path.slice(4) : f.path));
  if (!paths.length) return null;
  let parts = paths[0].split('/').slice(0, -1);
  for (const p of paths.slice(1)) {
    const other = p.split('/').slice(0, -1);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.length > 1 ? parts.join('/') : null;
}

/** "REF DRUMS (Cruel Summer_Drums.wav), Cues (3 files)" — by part, files named when few. */
function describeStanding(files: FileStanding[]): string {
  const byPart = new Map<string, string[]>();
  for (const f of files) byPart.set(f.part, [...(byPart.get(f.part) ?? []), f.path.split('/').pop() ?? f.path]);
  return [...byPart]
    .map(([part, names]) => (names.length <= 2 ? `${part} (${names.join(', ')})` : `${part} (${names.length} files)`))
    .join(', ');
}

/** A bar for a rig clip: whole when it is, else to a tenth. */
function formatBar(bar: number): string {
  return Number.isInteger(bar) ? String(bar) : bar.toFixed(1);
}
