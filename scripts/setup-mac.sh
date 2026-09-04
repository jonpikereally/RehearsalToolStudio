#!/bin/sh
#
# Set this Mac up to run Rehearsal Tool Studio.
#
#     bash scripts/setup-mac.sh
#
# For the second machine, where there is nobody to ask. Everything the README
# describes, in order, checking as it goes: prerequisites, dependencies, the
# self-test, and the two apps in /Applications.
#
# Run it from a real Terminal. The apps it builds are refused by macOS if they
# are stamped with a sandbox's provenance, which is what an agent or a script
# runner leaves behind — this is the one step nobody can do for you remotely.
#
# Safe to run again. It is also what to run after moving this folder, since
# the apps carry its path.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m%s\033[0m\n\n%s\n\n' "$1" "$2"; exit 1; }

say "Rehearsal Tool Studio — setting up this Mac"
printf 'from %s\n' "$REPO"

# ------------------------------- the machine -------------------------------

[ "$(uname)" = "Darwin" ] || fail "This is a Mac app." "It builds .app bundles and speaks to macOS's own voices, so it only runs on macOS."

if ! xcode-select -p >/dev/null 2>&1; then
  fail "The command line tools are not installed." "Run this, let it finish, then run this script again:

    xcode-select --install

Xcode itself is not needed — only the tools."
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node is not installed." "Install Node 24 or newer — https://nodejs.org, or 'brew install node' — then run this again."

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 24 ]; then
  fail "Node $(node -v) is too old." "Node 24 or newer is needed: the self-test imports the TypeScript sources directly, which relies on Node stripping the types itself.

Install a newer Node and run this again."
fi
printf '  node %s\n' "$(node -v)"

if command -v uv >/dev/null 2>&1; then
  printf '  uv %s\n' "$(uv --version 2>/dev/null | head -1)"
else
  printf '  uv is not installed — Lyrics Studio will not run. Everything else will.\n'
  printf '  Install it later with: brew install uv\n'
fi

# ------------------------------ the repo itself -----------------------------

if git -C "$REPO" rev-parse --short HEAD >/dev/null 2>&1; then
  printf '  commit %s\n' "$(git -C "$REPO" rev-parse --short HEAD)"
  if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
    printf '  (uncommitted changes here — probably a half-finished Dropbox sync; let it settle if so)\n'
  fi
fi

# ------------------------------- dependencies -------------------------------

say "Installing dependencies"
# Not the ones Dropbox carried over: node_modules holds binaries built for
# whichever Mac installed them, and an Intel esbuild on Apple silicon fails in
# ways that read as the app being broken.
rm -rf node_modules
npm install

say "Checking it actually works here"
npm run typecheck
npm test
npm run build

# ---------------------------------- the apps --------------------------------

say "Building the apps"
sh "$REPO/scripts/make-mac-apps.sh"

say "Done."
cat <<'NEXT'
Rehearsal Tool Studio.app and Lyrics Studio.app are in /Applications.

Next, and only on this machine:

  1. Open Rehearsal Tool Studio. It asks for the folder your sets live in.
     Point it at the same Dropbox folder the other Mac uses.

  2. Settings → choose the band's folder under "Publish to", if you intend
     to prepare sets from here.

  3. Make that sets folder available offline in Dropbox. If it is set to
     online-only, the stems are placeholders rather than audio, and
     preparing will fail on files that are not really there.

Two studios must not run at once against the same folder: both write the
library file in it, and Dropbox will answer with conflicted copies.

Run this script again after moving this folder — the apps carry its path.
NEXT
