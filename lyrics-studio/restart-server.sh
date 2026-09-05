#!/bin/bash
# Restart Lyrics Studio (used by the Start command and by Claude after updates).
#
# Only a Lyrics Studio is stopped: a port is identified by what answers on it,
# never assumed from its number, since 8765 has been taken by other apps.
cd "$(dirname "$0")"
lyrics_port() {
  for p in 8765 8766 8767 8768 8769 8770 8771 8772 8773 8774 8775; do
    case "$(curl -s -m 1 "http://127.0.0.1:$p/api/version" 2>/dev/null)" in
      *lyrics-studio*) echo "$p"; return 0 ;;
    esac
  done
  return 1
}
while PORT="$(lyrics_port)"; do
  kill $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null) 2>/dev/null
  sleep 1
done
nohup /opt/homebrew/bin/uv run server.py > server.log 2>&1 &
n=0
until PORT="$(lyrics_port)"; do
  n=$((n + 1)); [ $n -gt 60 ] && { echo "server: not responding"; exit 1; }
  sleep 1
done
echo "server: up on http://127.0.0.1:$PORT"
