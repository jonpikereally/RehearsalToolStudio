#!/bin/bash
# Open a .als in Ableton Live and report whether it loaded, crashed, or had errors.
FILE="$1"
LOG="$HOME/Library/Preferences/Ableton/Live 12.4/Log.txt"
CRASHDIR="$HOME/Library/Logs/DiagnosticReports"

before_crash=$(ls -t "$CRASHDIR"/Live-*.ips 2>/dev/null | head -1)
before=$(stat -f%z "$LOG" 2>/dev/null || echo 0)

osascript -e 'tell application "Live" to quit' 2>/dev/null
sleep 4
pkill -x Live 2>/dev/null
sleep 2
open -a "Ableton Live 12 Suite" "$FILE" 2>&1

result="TIMEOUT (no load marker seen)"
for i in $(seq 1 90); do
  sleep 1
  newest=$(ls -t "$CRASHDIR"/Live-*.ips 2>/dev/null | head -1)
  if [ "$newest" != "$before_crash" ]; then result="CRASHED -> $(basename "$newest")"; break; fi
  if tail -c +$((before+1)) "$LOG" 2>/dev/null \
     | grep -qE "Loaded document was created by|is corrupt|Rejected by the user"; then
    result="LOADED"
    sleep 4   # let post-load errors surface
    break
  fi
done

echo "=== RESULT: $result ==="
echo "--- relevant log lines ---"
tail -c +$((before+1)) "$LOG" 2>/dev/null \
  | grep -iE "loading document|loaded document|exception|repair |corrupt|could not|missing|error" \
  | sed 's/^[0-9T:.-]*: info: //' | head -20
osascript -e 'tell application "Live" to quit' 2>/dev/null
sleep 4
pkill -x Live 2>/dev/null
exit 0
