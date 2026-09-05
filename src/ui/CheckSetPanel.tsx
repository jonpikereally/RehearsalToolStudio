import { useMemo, useState } from 'react';
import type { AlsProject } from '../lib/alsParser';
import { songIdFor } from '../lib/alsImport';
import { navigate, songUrl } from '../lib/router';
import { checkSet, TOPIC_LABEL, TOPIC_ORDER, type Finding, type Severity, type Topic } from '../lib/setReview';
import { useStore } from '../lib/store';

/**
 * The preflight, arranged so a long report can be worked through.
 *
 * Twenty songs give a couple of hundred lines, and a flat list is fine to
 * glance at and hopeless to act on. So: filed by song or by subject, each
 * group folding shut once it is dealt with; the three severities switchable
 * on and off; a box to search by; and from any song's group, a way straight
 * to that song. How it is arranged is remembered on this device — the way you
 * read a report is a habit, not a choice per set.
 */

type GroupBy = 'song' | 'topic';
type SortBy = 'order' | 'severity';

interface View {
  groupBy: GroupBy;
  sortBy: SortBy;
  show: Record<Severity, boolean>;
}

const LS_VIEW = 'ls.check.view';
const DEFAULT_VIEW: View = {
  groupBy: 'song',
  sortBy: 'order',
  show: { problem: true, warning: true, info: true },
};

function readView(): View {
  try {
    const raw = localStorage.getItem(LS_VIEW);
    return raw ? { ...DEFAULT_VIEW, ...(JSON.parse(raw) as Partial<View>) } : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

const RANK: Record<Severity, number> = { problem: 0, warning: 1, info: 2 };
const MARK: Record<Severity, { glyph: string; color: string; word: string }> = {
  problem: { glyph: '●', color: 'var(--bad)', word: 'problem' },
  warning: { glyph: '●', color: 'var(--accent)', word: 'warning' },
  info: { glyph: '○', color: 'var(--text-faint)', word: 'note' },
};

/** The set as a whole, grouped like a song so it reads in the same list. */
const THE_SET = '__set__';

interface Group {
  key: string;
  name: string;
  /** The song this group is, when it is one, for the way to it. */
  song: string | null;
  findings: Finding[];
}

export default function CheckSetPanel({
  project,
  selected,
  setPath,
}: {
  project: AlsProject;
  selected: Set<string>;
  /** The set's path in the library, for opening a song from its findings; null for a lone .als. */
  setPath: string | null;
}) {
  const { library } = useStore();
  const [view, setViewState] = useState<View>(readView);
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  // From the latest state, not the render's: two taps in one frame — a
  // severity and a sort — must both land, and a stale closure lost the second.
  const setView = (patch: Partial<View> | ((current: View) => Partial<View>)) =>
    setViewState((current) => {
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
      try {
        localStorage.setItem(LS_VIEW, JSON.stringify(next));
      } catch {
        /* the arrangement simply won't persist */
      }
      return next;
    });

  const all = useMemo(
    () => checkSet(project).filter((f) => !f.song || selected.has(f.song)),
    [project, selected],
  );
  const count = (severity: Severity) => all.filter((f) => f.severity === severity).length;
  const problems = count('problem');
  const warnings = count('warning');
  const notes = count('info');

  /* --------------------------------- filing --------------------------------- */

  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (f) =>
      view.show[f.severity] &&
      (!needle ||
        f.message.toLowerCase().includes(needle) ||
        (f.song ?? '').toLowerCase().includes(needle)),
  );

  const order = new Map(project.songs.map((s, i) => [s.title, i]));
  const bySeverity = (a: Finding, b: Finding) => RANK[a.severity] - RANK[b.severity];
  const sortRows = (rows: Finding[]) => (view.sortBy === 'severity' ? [...rows].sort(bySeverity) : rows);

  const groups: Group[] = useMemo(() => {
    const made = new Map<string, Group>();
    if (view.groupBy === 'song') {
      for (const f of shown) {
        const key = f.song ?? THE_SET;
        if (!made.has(key)) made.set(key, { key, name: f.song ?? 'The set', song: f.song, findings: [] });
        made.get(key)!.findings.push(f);
      }
      // The set first, then the songs in the order they are played: the order they'd bite.
      return [...made.values()].sort(
        (a, b) => (a.song ? (order.get(a.song) ?? 0) : -1) - (b.song ? (order.get(b.song) ?? 0) : -1),
      );
    }
    for (const f of shown) {
      if (!made.has(f.topic)) {
        made.set(f.topic, { key: f.topic, name: TOPIC_LABEL[f.topic], song: null, findings: [] });
      }
      made.get(f.topic)!.findings.push(f);
    }
    return [...made.values()].sort(
      (a, b) => TOPIC_ORDER.indexOf(a.key as Topic) - TOPIC_ORDER.indexOf(b.key as Topic),
    );
  }, [shown, view.groupBy]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A song's page, when the set is the library's and the song is in it. */
  const wayTo = (title: string | null): string | null => {
    if (!title || !setPath) return null;
    const id = songIdFor(setPath, title);
    return library.songs.some((s) => s.id === id) ? songUrl(id) : null;
  };

  const toggle = (key: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /* --------------------------------- copying -------------------------------- */

  const report = () =>
    groups
      .map((g) =>
        [
          g.name,
          ...sortRows(g.findings).map(
            (f) => `  ${MARK[f.severity].glyph} ${g.song === null && f.song ? `${f.song}: ` : ''}${f.message}`,
          ),
        ].join('\n'),
      )
      .join('\n\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy the report:', report());
    }
  };

  const dots = (rows: Finding[]) =>
    (['problem', 'warning', 'info'] as Severity[])
      .map((s) => ({ s, n: rows.filter((f) => f.severity === s).length }))
      .filter(({ n }) => n > 0);

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  return (
    <div className="check">
      <div className="notice">
        {problems
          ? `${plural(problems, 'problem')}, ${plural(warnings, 'warning')}, ${plural(notes, 'note')}.`
          : warnings
            ? `No problems, ${plural(warnings, 'warning')}, ${plural(notes, 'note')}.`
            : 'Nothing would go wrong live that this checker can see.'}{' '}
        Red would go wrong at the gig, amber deserves a look, hollow is worth knowing.
      </div>

      <div className="controls flush check-tools" role="toolbar" aria-label="Arrange the findings">
        {(['problem', 'warning', 'info'] as Severity[]).map((s) => {
          const n = count(s);
          return (
            <button
              key={s}
              className={view.show[s] ? 'chip on' : 'chip'}
              aria-pressed={view.show[s]}
              disabled={n === 0}
              onClick={() => setView((v) => ({ show: { ...v.show, [s]: !v.show[s] } }))}
              title={`${view.show[s] ? 'Hide' : 'Show'} ${MARK[s].word}s`}
            >
              <span aria-hidden style={{ color: MARK[s].color }}>
                {MARK[s].glyph}
              </span>{' '}
              {plural(n, MARK[s].word)}
            </button>
          );
        })}
        <span className="control-label">By</span>
        <div className="segmented" role="radiogroup" aria-label="Group by">
          {(['song', 'topic'] as GroupBy[]).map((g) => (
            <button
              key={g}
              role="radio"
              aria-checked={view.groupBy === g}
              className={view.groupBy === g ? 'seg on' : 'seg'}
              onClick={() => setView({ groupBy: g })}
            >
              {g === 'song' ? 'Song' : 'Subject'}
            </button>
          ))}
        </div>
        <span className="control-label">Order</span>
        <div className="segmented" role="radiogroup" aria-label="Sort by">
          {(['order', 'severity'] as SortBy[]).map((o) => (
            <button
              key={o}
              role="radio"
              aria-checked={view.sortBy === o}
              className={view.sortBy === o ? 'seg on' : 'seg'}
              onClick={() => setView({ sortBy: o })}
            >
              {o === 'order' ? 'As checked' : 'Worst first'}
            </button>
          ))}
        </div>
        <input
          className="text-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search findings…"
          aria-label="Search findings"
        />
        <button className="chip" onClick={() => setClosed(new Set())} disabled={closed.size === 0}>
          Expand all
        </button>
        <button
          className="chip"
          onClick={() => setClosed(new Set(groups.map((g) => g.key)))}
          disabled={groups.length === 0}
        >
          Collapse all
        </button>
        <button
          className="chip"
          onClick={() => void copy()}
          disabled={groups.length === 0}
          title="The report as text, arranged as it is here"
        >
          {copied ? 'Copied' : 'Copy report'}
        </button>
      </div>

      {groups.length === 0 && all.length > 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13.5 }}>
          Nothing matches — clear the search, or show a severity again.
        </div>
      )}

      {groups.map((g) => {
        const open = !closed.has(g.key);
        const way = wayTo(g.song);
        const summary = dots(g.findings);
        return (
          <section key={g.key} className="check-group">
            <div className="check-head">
              <button className="check-toggle" onClick={() => toggle(g.key)} aria-expanded={open}>
                <span className={open ? 'caret open' : 'caret'} aria-hidden>
                  ▸
                </span>
                <strong>{g.name}</strong>
                <span
                  className="check-dots"
                  aria-label={summary.map(({ s, n }) => plural(n, MARK[s].word)).join(', ')}
                >
                  {summary.map(({ s, n }) => (
                    <span key={s}>
                      <span aria-hidden style={{ color: MARK[s].color }}>
                        {MARK[s].glyph}
                      </span>{' '}
                      {n}
                    </span>
                  ))}
                </span>
              </button>
              {way && (
                <button className="chip" onClick={() => navigate(way)} title={`Open ${g.name}`}>
                  Open ›
                </button>
              )}
            </div>
            {open && (
              <div className="check-rows">
                {sortRows(g.findings).map((f, i) => {
                  const rowWay = g.song === null ? wayTo(f.song) : null;
                  return (
                    <div key={i} className="check-row">
                      <span aria-hidden style={{ color: MARK[f.severity].color }}>
                        {MARK[f.severity].glyph}
                      </span>
                      <span>
                        {g.song === null &&
                          f.song &&
                          (rowWay ? (
                            <button className="check-song" onClick={() => navigate(rowWay)} title={`Open ${f.song}`}>
                              {f.song}
                            </button>
                          ) : (
                            <strong style={{ marginRight: 6 }}>{f.song}</strong>
                          ))}
                        <span style={{ color: f.severity === 'info' ? 'var(--text-dim)' : 'var(--text)' }}>
                          {f.message}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
