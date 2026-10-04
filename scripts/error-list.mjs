#!/usr/bin/env node
/**
 * Writes docs/errors.md — the public list of Rehearsal Tool Studio's error
 * codes — from src/lib/errorCodes.ts, the one place they are defined.
 *
 *     npm run errors            write it
 *     npm run errors -- --check say whether it is out of date (the self-test does)
 *
 * Each code is a heading of its own, so a link to …/errors.md#rts-lyr-02
 * lands on it, and the page reads as plain text for an LLM handed the code.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'errors.md');

export async function errorListMarkdown() {
  const { ERROR_AREAS, ERROR_CODES, ERROR_LIST_URL } = await import('../src/lib/errorCodes.ts');
  const lines = [
    '# Rehearsal Tool Studio — error codes',
    '',
    'Every error Rehearsal Tool Studio shows carries a code like `RTS-LYR-02`, beside its message. Find the code below for what it means and what to do.',
    '',
    'To get help from an LLM (ChatGPT, Claude, …), give it the code, the full message, and this page:',
    '',
    `> I got error RTS-XXX-00 in Rehearsal Tool Studio: "<the message>". The error list is at ${ERROR_LIST_URL} — what does it mean and how do I fix it?`,
    '',
    'Logs that help with any of them, on the Mac running the studio: `~/Library/Logs/Rehearsal Tool Studio/` (`launch.log`, `lyrics-studio.log`, `update.log`).',
    '',
    '_This page is written from `src/lib/errorCodes.ts` by `npm run errors`; edit that, not this._',
    '',
  ];
  for (const [area, label] of Object.entries(ERROR_AREAS)) {
    const codes = Object.entries(ERROR_CODES).filter(([, e]) => e.area === area);
    if (!codes.length) continue;
    lines.push(`## ${label}`, '');
    for (const [code, e] of codes) {
      lines.push(`### ${code}`, '', `**${e.title}**`, '', e.help, '');
    }
  }
  return lines.join('\n');
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const md = await errorListMarkdown();
  if (process.argv.includes('--check')) {
    let now = '';
    try {
      now = readFileSync(OUT, 'utf8');
    } catch {
      /* missing is out of date */
    }
    if (now !== md) {
      console.error('docs/errors.md is out of date: npm run errors');
      process.exit(1);
    }
    console.log('docs/errors.md is up to date');
  } else {
    writeFileSync(OUT, md);
    console.log(`wrote ${OUT}`);
  }
}
