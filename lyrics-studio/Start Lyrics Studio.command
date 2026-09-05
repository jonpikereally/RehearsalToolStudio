#!/bin/bash
# Double-click to start Lyrics Studio. Opens it in your browser once it answers.
#
# It lives on http://localhost:8765 unless something else has that port, in
# which case it takes the next free one — so the port is looked up, not assumed.
cd "$(dirname "$0")"
lyrics_port() {
  for p in 8765 8766 8767 8768 8769 8770 8771 8772 8773 8774 8775; do
    case "$(curl -s -m 1 "http://127.0.0.1:$p/api/version" 2>/dev/null)" in
      *lyrics-studio*) echo "$p"; return 0 ;;
    esac
  done
  return 1
}
( until PORT="$(lyrics_port)"; do sleep 1; done; open "http://localhost:$PORT" ) &
exec /opt/homebrew/bin/uv run server.py
