# Working on Rehearsal Tool Studio

## Errors carry a code

Every error a user can see — in the page, in a dialog of the Mac app, in
Lyrics Studio's engine, in a log line meant for a person — carries a short,
stable error code beside its message, so that troubleshooting with an LLM can
start from the code rather than a paraphrase. A code names one failure, is
never reused for another, and survives rewording of the message.

## Conventions

- Commit messages are prose: what changed and why, in the voice of the
  existing history. `npm run changelog` regenerates CHANGELOG.md from them;
  include it in the commit it describes.
- `npm run typecheck && npm test && npm run build` before pushing.
- Changes land on `main` through a pull request, merged with rebase. Pushing
  to `main` with app paths changed builds the installer and publishes a
  release; pull requests touching `mac/**` or the packaging scripts build it
  as a check, which is where the Swift is compiled.
