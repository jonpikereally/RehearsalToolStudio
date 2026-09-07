/**
 * Write CHANGELOG.md from the commits themselves.
 *
 *     node scripts/changelog.mjs        (or: npm run changelog)
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

const log = execFileSync(
  'git',
  ['log', `--pretty=format:%ad${FIELD}%s${FIELD}%b${RECORD}`, '--date=short'],
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
