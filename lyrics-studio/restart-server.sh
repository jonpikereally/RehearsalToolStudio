#!/bin/bash
# Restart Lyrics Studio (used by the Start command and by Claude after updates)
cd "$(dirname "$0")"
kill $(lsof -nP -tiTCP:8765 -sTCP:LISTEN 2>/dev/null) 2>/dev/null
sleep 1
nohup /opt/homebrew/bin/uv run server.py > server.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "server: %{http_code}\n" http://127.0.0.1:8765/ || echo "server: not responding"
