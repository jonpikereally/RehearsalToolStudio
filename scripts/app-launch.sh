#!/bin/sh
# The studio's launcher: `app-launch.sh <tool>`.
#
# The Studio app calls this before showing its window, and the Lyrics Studio
# stub in /Applications is nothing but a call to it. All the judgement lives
# here, in the repo, so a change to how a tool opens is a normal commit that
# the installed apps pick up on their next click.
#
# Tools: studio | studio-servers | lyrics
#        studio-servers — start what the studio needs and stop, opening
#        nothing; the native Studio app calls this before showing its window.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$HOME/Library/Application Support/Rehearsal Tool Studio"

# Apps launch with a bare PATH, so the tools node and uv are found the long way.
find_bin() {
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    [ -x "$p/$1" ] && { echo "$p/$1"; return; }
  done
  command -v "$1" 2>/dev/null || true
}

listening() { /usr/bin/nc -z 127.0.0.1 "$1" 2>/dev/null; }

# A tool installed as a Chrome web app (from a normal window of the suite's
# profile: address bar → Install) gets a real .app of its own. That app owns
# the window, so the Dock shows the tool's icon rather than Chrome's, and a
# second click focuses the open window instead of piling up fresh ones. When
# such an app exists, launching is its job — this script still runs first,
# because somebody has to start the servers.
open_shim() {
  for DIR in "$HOME/Applications/Chrome Apps.localized" "$HOME/Applications/Chrome Apps"; do
    for NAME in "$@"; do
      [ -d "$DIR/$NAME.app" ] && exec /usr/bin/open "$DIR/$NAME.app"
    done
  done
}

# The studio has a Mac app of its own — a WebKit window, not a browser — made
# by scripts/make-studio-app.sh. When it is installed, the window is its job;
# it starts the servers itself, so this only needs to hand over.
open_native_studio() {
  for DIR in /Applications "$HOME/Applications"; do
    APP="$DIR/Rehearsal Tool Studio.app"
    [ -x "$APP/Contents/MacOS/Rehearsal Tool Studio" ] && exec /usr/bin/open "$APP"
  done
}

# The studio and the playback helper speak through the voice helper; their
# windows should never open onto an "isn't running" notice.
start_voice_helper() {
  NODE="$(find_bin node)"
  if [ -n "$NODE" ] && ! listening 5175; then
    ( cd "$REPO" && /usr/bin/nohup "$NODE" scripts/slate-helper.mjs >/dev/null 2>&1 & )
  fi
}

# The studio is served from this machine — an offline tool has no deployed
# copy to lean on. Rebuild when the source has moved on, but never let a
# failed build brick the app: the stale build opens and the log says why.
start_studio_server() {
  NODE="$(find_bin node)"
  NPM="$(find_bin npm)"
  [ -n "$NODE" ] || return

  newest="$(/usr/bin/find "$REPO/src" "$REPO/public" "$REPO/index.html" \
    "$REPO/package.json" "$REPO/vite.config.ts" "$REPO/tsconfig.json" \
    -type f -newer "$REPO/dist/index.html" 2>/dev/null | head -1)"
  # File times alone can lie: a bundle built moments before its commit is
  # newer than everything yet stamped with the old hash. So the stamp the
  # build wrote is also held against git — any new commit means a rebuild,
  # whatever the clocks say.
  stamped="$(/usr/bin/sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$REPO/dist/build.json" 2>/dev/null)"
  current="$(cd "$REPO" && /usr/bin/git rev-parse --short HEAD 2>/dev/null)"
  if [ ! -f "$REPO/dist/index.html" ] || [ -n "$newest" ] ||
     { [ -n "$current" ] && [ "$current" != "$stamped" ]; }; then
    # Builds leave the last build's files in place for any page still on
    # them; what nothing has referenced for a day is let go afterwards.
    # npm's scripts find node by name, and an app's PATH has no node in it:
    # "env: node: No such file" was every build failing from the Dock while
    # the same command worked from a terminal. Node's own folder goes first.
    ( cd "$REPO" && PATH="$(dirname "$NODE"):$PATH" "$NPM" run build && /bin/sh scripts/prune-build.sh ) >"$REPO/.studio-build.log" 2>&1 \
      || echo "build failed; serving the previous build" >>"$REPO/.studio-build.log"
  fi

  stamped="$(/usr/bin/sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$REPO/dist/build.json" 2>/dev/null)"
  if listening 5177; then
    answer="$(/usr/bin/curl -s --max-time 2 "http://127.0.0.1:5177/__rehearsal-studio")"
    case "$answer" in
      *rehearsal-tool-studio*) ;;
      # Only reuse the port if it is actually us; a stranger squatting there
      # would otherwise be served up as the studio.
      *) echo "port 5177 is taken by something else" >>"$REPO/.studio-build.log"; return ;;
    esac
    # It is ours — but a long-lived server keeps running the code it started
    # with, file API included, and answers with the build it started as. When
    # that is behind what sits on disk, replace it rather than trust it. No
    # stamp on disk means there is nothing to disagree with. (An answer with
    # no "server" at all is a server from before it said, and is replaced.)
    [ -z "$stamped" ] && return
    case "$answer" in
      *"\"server\":\"$stamped\""*) return ;;
    esac
    echo "replacing an outdated studio server" >>"$REPO/.studio-build.log"
    /bin/kill $(/usr/sbin/lsof -ti tcp:5177 2>/dev/null) 2>/dev/null
    sleep 0.5
  fi
  ( cd "$REPO" && /usr/bin/nohup "$NODE" scripts/serve-studio.mjs >/dev/null 2>&1 & )
  n=0
  until listening 5177; do
    n=$((n + 1)); [ $n -gt 40 ] && break
    sleep 0.5
  done
}

# Lyrics Studio is its own local server: bring it up and wait for an answer,
# because a browser aimed at a port that isn't up yet shows an error page.
#
# Its port is found, not assumed. Home is 8765, but another app on this Mac
# took to listening there, and a launcher that only asked "is 8765 busy?"
# opened a browser on a stranger. So the server steps to the next free port
# when it must, and this asks each port in turn who is actually there.
lyrics_port() {
  for p in 8765 8766 8767 8768 8769 8770 8771 8772 8773 8774 8775; do
    case "$(/usr/bin/curl -s -m 1 "http://127.0.0.1:$p/api/version" 2>/dev/null)" in
      *lyrics-studio*) echo "$p"; return 0 ;;
    esac
  done
  return 1
}

start_lyrics_studio() {
  UV="$(find_bin uv)"
  LYRICS_PORT="$(lyrics_port)" && return
  [ -n "$UV" ] && ( cd "$REPO/lyrics-studio" && /usr/bin/nohup "$UV" run server.py >/dev/null 2>&1 & )
  n=0
  until LYRICS_PORT="$(lyrics_port)"; do
    n=$((n + 1)); [ $n -gt 120 ] && { LYRICS_PORT=8765; break; }
    sleep 0.5
  done
}

case "$1" in
  studio)       URL="http://localhost:5177"; start_voice_helper; start_studio_server
                open_native_studio
                open_shim "Rehearsal Tool Studio" ;;
  studio-servers) start_voice_helper; start_studio_server; exit 0 ;;
  lyrics)       start_lyrics_studio; URL="http://localhost:$LYRICS_PORT"
                open_shim "Lyrics Studio" ;;
  *) echo "usage: app-launch.sh studio|studio-servers|lyrics" >&2; exit 2 ;;
esac

# The browser binary is called directly — unlike `open --args`, that reaches a
# running browser too. Detached rather than exec'd, so the wrapper app exits at
# once and a Dock click is always a fresh launch of the tool, never a Chrome
# "reactivation" with its blank window. The suite's own profile keeps a cold
# start from restoring ordinary browsing windows beside the app window.
# Handed to LaunchServices, which owns the browser from then on. A child of
# this wrapper gets reaped the moment the wrapper exits — that is how the
# apps opened nothing for days — and macOS only reliably outlives us through
# `open`. This same approach once looked broken, but the real fault then was
# a poisoned profile Chrome refused to lock; two bugs wearing one symptom.
# `-n` (a new instance) is right only when the browser is already running —
# then it opens our window beside the ordinary browsing one. Launched cold,
# `-n` can race the app's registration and the arguments are dropped, so the
# window never appears; a plain `open -a` cold takes the arguments reliably
# and is the first instance anyway.
for APP in "Google Chrome" "Brave Browser"; do
  if [ -d "/Applications/$APP.app" ]; then
    if /usr/bin/pgrep -xq "$APP"; then N="-n"; else N=""; fi
    exec /usr/bin/open $N -a "$APP" --args --user-data-dir="$PROFILE" \
      --no-first-run --no-default-browser-check --app="$URL"
  fi
done
exec /usr/bin/open "$URL"
