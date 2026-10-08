/**
 * Write CHANGELOG.md from the commits themselves.
 *
 *     node scripts/changelog.mjs        (or: npm run changelog)
 *     node scripts/changelog.mjs --since build-20261008-1530-cf59cc6
 *
 * The second prints, rather than writes, the entries of one update: every
 * commit after the given release up to this one, newest first. The
 * installer's release carries it as its notes, so each update says what it
 * changed where it is offered. Given an empty ref, or one this history
 * does not have, it prints this commit's entry alone.
 *
 * Every change to the studio is already described where it was made — the
 * commit's subject says what changed, its body says why — so the log is read
 * out of the history rather than kept by hand beside it, which is how a log
 * falls out of step with what it is logging. Run it after committing.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Field and record marks no commit message will contain. */
const FIELD = '\x1f';
const RECORD = '\x1e';

const sinceAt = process.argv.indexOf('--since');
const since = sinceAt === -1 ? null : (process.argv[sinceAt + 1] ?? '');

/** Whether this history has the ref at all: a first release, or a shallow clone, may not. */
function known(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const range = since === null ? [] : since && known(since) ? [`${since}..HEAD`] : ['-1', 'HEAD'];
const log = execFileSync(
  'git',
  ['log', `--pretty=format:%ad${FIELD}%s${FIELD}%b${RECORD}`, '--date=short', ...range],
  { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

/** The commit's own explanation: its first paragraph, without the trailers. */
function description(body) {
  const text = body
    .split('\n')
    .filter((line) => !/^(Co-Authored-By|Signed-off-by|Generated with|🤖)/i.test(line.trim()))
    .join('\n')
    .trim();
  const paragraph = text.split(/\n\s*\n/)[0] ?? '';
  return paragraph
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

const entries = log
  .split(RECORD)
  .map((record) => record.replace(/^\n/, ''))
  .filter((record) => record.trim())
  .map((record) => {
    const [date, subject, body = ''] = record.split(FIELD);
    return { date, subject, description: description(body) };
  });

/** One update's entries, for its release notes: no title, no dates — the release has both. */
if (since !== null) {
  const notes = entries.flatMap((entry) => [`**${entry.subject}**`, '', ...(entry.description ? [entry.description, ''] : [])]);
  process.stdout.write(notes.length ? notes.join('\n').trimEnd() + '\n' : 'No changes since the last release.\n');
  process.exit(0);
}

const lines = [
  '# Changelog',
  '',
  'Every change to the studio, newest first, as it was described when it was made.',
  'Written by `node scripts/changelog.mjs` from the commits themselves — so a change is',
  'logged by describing it in its commit message, not by editing this file. No commit',
  'ids: they change when a commit is amended, and the log would go stale in the writing.',
  '',
];

let day = null;
for (const entry of entries) {
  if (entry.date !== day) {
    day = entry.date;
    lines.push(`## ${day}`, '');
  }
  lines.push(`**${entry.subject}**`, '');
  if (entry.description) lines.push(entry.description, '');
}

writeFileSync(join(repo, 'CHANGELOG.md'), lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
console.log(`CHANGELOG.md — ${entries.length} changes`);
