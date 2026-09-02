#!/bin/bash
# Double-click to start Lyrics Studio. Opens http://localhost:8765 in your browser.
cd "$(dirname "$0")"
( until curl -s -o /dev/null http://127.0.0.1:8765/; do sleep 1; done; open "http://localhost:8765" ) &
exec /opt/homebrew/bin/uv run server.py
