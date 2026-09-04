#!/bin/sh
#
# The launcher that travels inside the packaged app, as Contents/Resources/launch.sh.
#
# The development app runs scripts/app-launch.sh out of the repo, which
# rebuilds the studio when the source has moved and finds Node wherever the
# machine keeps it. This one has neither job: the app carries its own Node
# and a finished build, and nothing inside the bundle ever changes. All it
# does is start the two servers from what it was shipped with and wait for
# the studio to answer.
#
# It writes nothing inside the bundle — a signed app that is written into
# stops being the app that was signed — so the log goes to ~/Library/Logs.
RES="$(cd "$(dirname "$0")" && pwd)"
NODE="$RES/node"
# The log, somewhere writable. Not being able to keep one is no reason not to
# start the studio, so failing that it goes to the temp folder, and failing
# that nowhere — the servers start either way.
LOGDIR="${RTS_LOG_DIR:-$HOME/Library/Logs/Rehearsal Tool Studio}"
mkdir -p "$LOGDIR" 2>/dev/null || LOGDIR="${TMPDIR:-/tmp}"
LOG="$LOGDIR/launch.log"
( : >>"$LOG" ) 2>/dev/null || LOG=/dev/null

listening() { /usr/bin/nc -z 127.0.0.1 "$1" 2>/dev/null; }
stamp() { /usr/bin/sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$RES/dist/build.json" 2>/dev/null; }

[ -x "$NODE" ] || { echo "$(date '+%F %T') no node inside the app at $NODE" >>"$LOG"; exit 1; }

# The voice helper, which slates and spoken cues go through.
if ! listening 5175; then
  ( cd "$RES" && /usr/bin/nohup "$NODE" scripts/slate-helper.mjs >>"$LOG" 2>&1 & )
fi

# The studio itself. A server already on the port is reused only when it is
# ours and serving this very build: an older one is replaced, since it would
# answer with an older file API; a stranger is left alone and said so.
if listening 5177; then
  answer="$(/usr/bin/curl -s --max-time 2 http://127.0.0.1:5177/__rehearsal-studio)"
  case "$answer" in
    *rehearsal-tool-studio*) ;;
    *) echo "$(date '+%F %T') port 5177 is taken by something else" >>"$LOG"; exit 0 ;;
  esac
  case "$answer" in
    *"\"server\":\"$(stamp)\""*) exit 0 ;;
  esac
  echo "$(date '+%F %T') replacing a studio server from another build" >>"$LOG"
  /bin/kill $(/usr/sbin/lsof -nP -ti tcp:5177 2>/dev/null) 2>/dev/null
  sleep 0.5
fi

( cd "$RES" && /usr/bin/nohup "$NODE" scripts/serve-studio.mjs >>"$LOG" 2>&1 & )
n=0
until listening 5177; do
  n=$((n + 1)); [ $n -gt 40 ] && break
  sleep 0.5
done
