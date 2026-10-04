# Working on Rehearsal Tool Studio

## Errors carry a code

Every error a user can see — in the page, in a dialog of the Mac app, in
Lyrics Studio's engine, in a log line meant for a person — carries a short,
stable error code beside its message, so that troubleshooting with an LLM can
start from the code rather than a paraphrase. A code names one failure, is
never reused for another, and survives rewording of the message.

How, in this repo:

- Codes are `RTS-<AREA>-<nn>`, defined once in `src/lib/errorCodes.ts` with a
  title and what to do. `npm run errors` writes the public list,
  `docs/errors.md` (public on GitHub, so anyone's LLM can read it).
- In the page, set an error with `coded('RTS-…', err)` and show it with
  `<ErrorNotice code="RTS-…" text={error} />` — never a hand-drawn
  `notice error`. ErrorNotice shows the code, links it to the list, and
  gives the hover text pointing there. A code given deeper down (the engine's)
  is kept over the one for where it surfaced.
- The Mac app: `coded(alert, "RTS-MAC-…")` on an NSAlert (text plus the ?
  button to the list); `errorLine(...)` on an error page.
- The Lyrics engine: `[RTS-LSE-…]` at the start of a message;
  `with_code` gives anything uncoded `RTS-LSE-00`.
- `npm test` fails when a code is used but not listed, listed but unused,
  the list is out of date, or an error notice is drawn without ErrorNotice.

## Conventions

- Commit messages are prose: what changed and why, in the voice of the
  existing history. `npm run changelog` regenerates CHANGELOG.md from them;
  include it in the commit it describes.
- `npm run typecheck && npm test && npm run build` before pushing.
- Changes land on `main` through a pull request, merged with rebase. Pushing
  to `main` with app paths changed builds the installer and publishes a
  release; pull requests touching `mac/**` or the packaging scripts build it
  as a check, which is where the Swift is compiled.
