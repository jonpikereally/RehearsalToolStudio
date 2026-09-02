/**
 * Looking a set over before it matters.
 *
 * `checkSet` is the preflight: everything the parser can see that would go
 * wrong at a gig — a reference recording left active, a song nothing stops, a
 * locator promising one tempo while the automation plays another — reported
 * as findings rather than discovered live. `setlistText` is the other side of
 * the same look: the running order with keys, tempos and honest durations,
 * ready to print.
 *
 * Both work purely on a parsed project, so they cost one scan and no clicks.
 */

import type { AlsProject, AlsSong } from './alsParser.ts';

export type Severity = 'problem' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** Which song it concerns, or null for the set as a whole. */
  song: string | null;
  message: string;
}

const beatsPerBarOf = (p: AlsProject) => p.timeSigNum * (4 / p.timeSigDen);

/**
 * How long the song actually runs, from its bars and its tempo automation.
 *
 * Deliberately not the `[3:20]` a locator pins — that is what somebody once
 * wrote, and the whole point of computing is catching the two disagreeing.
 */
export function songDurationSec(song: AlsSong, beatsPerBar: number): number {
  const totalBars = song.endBar - song.startBar;
  if (totalBars <= 0) return 0;

  // Piecewise: each stretch runs at its tempo until the next change.
  const changes = song.tempoChanges.filter((c) => c.bar > 1 && c.bar < 1 + totalBars);
  let atBar = 1;
  let bpm = song.startBpm || 120;
  let sec = 0;
  for (const next of [...changes, { bar: 1 + totalBars, bpm: 0 }]) {
    sec += ((next.bar - atBar) * beatsPerBar * 60) / bpm;
    atBar = next.bar;
    if (next.bpm) bpm = next.bpm;
  }
  return sec;
}

export function formatSec(sec: number): string {
  const whole = Math.round(sec);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return (h ? `${h}:${mm}` : mm) + ':' + String(s).padStart(2, '0');
}

/** "3:20" → 200; null when it doesn't read as a time. */
export function parseTimeText(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** An unwarped clip this long is a stem, not a one-shot, and worth flagging. */
const UNWARPED_BARS = 8;
/** A pinned duration this far off the arrangement is a lie, not rounding. */
const DURATION_SLACK_SEC = 5;

export function checkSet(project: AlsProject): Finding[] {
  const beatsPerBar = beatsPerBarOf(project);
  const out: Finding[] = [];

  if (!project.songs.length) {
    out.push({
      severity: 'problem',
      song: null,
      message: 'No locators name any songs — there is nothing here to play as a set.',
    });
    return out;
  }

  /* ------------------------------- set-wide ------------------------------- */

  const counts = new Map<string, number>();
  for (const song of project.songs) counts.set(song.title, (counts.get(song.title) ?? 0) + 1);
  for (const [title, n] of counts) {
    if (n > 1) {
      out.push({
        severity: 'warning',
        song: null,
        message: `“${title}” is named by ${n} locators — jumps and setlists cannot tell them apart.`,
      });
    }
  }

  if (project.songs.every((s) => !s.sections.length)) {
    out.push({
      severity: 'warning',
      song: null,
      message:
        'No sections anywhere — without a +SECTIONS track there is no jumping to a chorus in rehearsal.',
    });
  }

  const anySlates = project.songs.some((s) => s.slateBars.length);
  if (!anySlates) {
    out.push({
      severity: 'info',
      song: null,
      message: 'No slate track — the Slates tool can speak each title onto one.',
    });
  }

  // The parser already noticed songs it could find no audio for.
  // What the player cannot follow, said before the gig rather than at it.
  for (const song of project.songs) {
    for (const caveat of song.caveats ?? []) out.push({ severity: 'warning', song: song.title, message: caveat });
    /*
     * Devices are imitated at best. Any that cannot be — a plugin, a rack —
     * mean the raw file is not what the song sounds like; worth a warning
     * before it is relied on.
     */
    // Only the song's own tracks: a return bus is the venue's chain, not the song's.
    const cannot = new Set<string>();
    for (const stem of song.stems) {
      for (const d of stem.devices ?? []) if (d.on && !d.supported) cannot.add(d.name ? `${d.kind} “${d.name}”` : d.kind);
    }
    if (cannot.size) {
      out.push({
        severity: 'warning',
        song: song.title,
        message: `Runs through devices this app cannot imitate — ${[...cannot].join(', ')} — so it will not sound as it does in Live.`,
      });
    }
  }

  for (const warning of project.warnings) {
    out.push({ severity: 'problem', song: null, message: warning });
  }

  /* ------------------------------- per song ------------------------------- */

  const anySections = project.songs.some((s) => s.sections.length);

  project.songs.forEach((song, index) => {
    const last = index === project.songs.length - 1;
    const next = project.songs[index + 1];
    const push = (severity: Severity, message: string) =>
      out.push({ severity, song: song.title, message });

    const stopped = song.endsAtStop || song.flags.includes('END') || song.flags.includes('PAUSE');
    if (!stopped && last) {
      push(
        'problem',
        'Nothing ever stops it — the set has no STOP locator or +END after the last song, so playback runs off the end.',
      );
    } else if (!stopped && next) {
      push(
        'info',
        `Runs straight into “${next.title}” — no STOP locator or +PAUSE/+END flag between them. Fine if that segue is meant.`,
      );
    }

    if (!song.key) {
      push('warning', 'No key in the locator — chord conversion and transposition have nothing to count from.');
    }
    if (song.bpm == null) {
      push('info', `The locator names no tempo; it plays at ${Math.round(song.startBpm)} BPM.`);
    } else if (Math.abs(song.bpm - song.startBpm) > 0.5) {
      push(
        'warning',
        `The locator says ${song.bpm} BPM but the tempo there is actually ${Math.round(song.startBpm)} — one of them is out of date.`,
      );
    }

    const bars = song.endBar - song.startBar;
    if (song.durationText && bars > 0) {
      const pinned = parseTimeText(song.durationText);
      const actual = songDurationSec(song, beatsPerBar);
      if (pinned != null && Math.abs(pinned - actual) > DURATION_SLACK_SEC) {
        push(
          'warning',
          `The locator pins it at ${song.durationText} but the arrangement runs ${formatSec(actual)}.`,
        );
      }
    }

    if (anySlates && !song.slateBars.length) {
      push('info', 'No slate — the Slates tool can add the spoken title.');
    }
    if (anySections && !song.sections.length) {
      push('info', 'No sections, though the rest of the set has them.');
    }
    if (song.tempoChanges.length > 1) {
      const spots = song.tempoChanges
        .slice(0, 3)
        .map((t) => `${Math.round(t.bpm)} at bar ${Math.round(t.bar)}`)
        .join(', ');
      push('info', `The tempo moves inside the song: ${spots}${song.tempoChanges.length > 3 ? '…' : ''}.`);
    }

    for (const stem of song.stems) {
      const active = stem.clips.filter((c) => !c.disabled);
      const muted = stem.regions !== null && stem.regions.length === 0;

      // The finished record playing under the band is the classic live horror.
      if (stem.reference && active.length && !muted) {
        push(
          'problem',
          `The reference recording “${stem.name}” is active — the record itself would sound at the gig. Mute the track or deactivate its clips.`,
        );
      }
      if (!stem.reference) {
        const off = stem.clips.length - active.length;
        if (off) {
          push('info', `${off} deactivated clip${off === 1 ? '' : 's'} on “${stem.name}” will stay silent.`);
        }
        const drifty = active.find((c) => !c.warped && c.endBar - c.startBar > UNWARPED_BARS);
        if (drifty) {
          push(
            'warning',
            `“${stem.name}” has an unwarped clip ${Math.round(drifty.endBar - drifty.startBar)} bars long — it plays at the file's own speed and will drift from the click if the tempos differ.`,
          );
        }
      }
    }
  });

  return out;
}

/**
 * The running order as text: order, title, duration, key, tempo, and the
 * total at the bottom. Durations prefer what the arrangement computes to what
 * a locator pins, for the same reason the checker compares them.
 */
export function setlistText(project: AlsProject, only?: Set<string>): string {
  const beatsPerBar = beatsPerBarOf(project);
  const songs = project.songs.filter((s) => !only || only.has(s.title));
  let totalSec = 0;

  const lines = songs.map((song, i) => {
    const sec = songDurationSec(song, beatsPerBar);
    totalSec += sec;
    const facts = [
      sec > 0 ? formatSec(sec) : song.durationText,
      song.key,
      `${Math.round(song.bpm ?? song.startBpm)} BPM`,
    ].filter(Boolean);
    return `${String(i + 1).padStart(2)}. ${song.title} — ${facts.join(', ')}`;
  });

  return [
    ...lines,
    '',
    `${songs.length} song${songs.length === 1 ? '' : 's'}, ${formatSec(totalSec)}`,
  ].join('\n');
}
