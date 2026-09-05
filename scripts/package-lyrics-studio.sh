#!/bin/bash
# Package Lyrics Studio as an app of its own.
#
#     bash scripts/package-lyrics-studio.sh [destination]      (default: Mac apps/)
#
# Lyrics Studio is Python, and it carries a lot: FastAPI, librosa, and Whisper
# on Apple's MLX. Bundling a Python with all of that inside an app is a
# project in itself, so this bundles the next best thing — the source and a
# copy of uv, which on first launch fetches a Python and the dependencies into
# its own cache and runs the server from there. The first open needs the
# network and a few minutes; after that it is instant and offline.
#
# The app never writes into itself: the log and the remembered paths go to
# ~/Library/Application Support/Lyrics Studio, which the server is told about.
# Whisper on MLX is Apple silicon only, and so is the uv here.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="Lyrics Studio"
OUT="${1:-$(pwd)/Mac apps}"
mkdir -p "$OUT"
APP="$OUT/$NAME.app"

UV_BIN="$(command -v uv || true)"
[ -n "$UV_BIN" ] || { echo "uv not found — it is what gets bundled (brew install uv)" >&2; exit 1; }
UV_BIN="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$UV_BIN")"
echo "bundling uv $(uv --version | head -1) ($(lipo -archs "$UV_BIN" 2>/dev/null || echo unknown))"

make_icns() {
  node -e '
    const { readFileSync, writeFileSync } = require("fs");
    const png = readFileSync(process.argv[1]);
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const chunk = Buffer.concat([Buffer.from("ic09"), u32(8 + png.length), png]);
    writeFileSync(process.argv[2], Buffer.concat([Buffer.from("icns"), u32(8 + chunk.length), chunk]));
  ' public/icon-512.png "$1"
}

echo "assembling $APP"
rm -rf "$APP"
RES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/MacOS" "$RES/lyrics-studio"
cp "$UV_BIN" "$RES/uv" && chmod 755 "$RES/uv"
# The program, and none of what running it leaves behind.
for f in server.py index.html template.xml audiotrack.xml midiclip-12.xml build_audiotrack.py; do
  cp "lyrics-studio/$f" "$RES/lyrics-studio/"
done
make_icns "$RES/app.icns"

cat > "$APP/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/sh
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
DATA="$HOME/Library/Application Support/Lyrics Studio"
mkdir -p "$DATA"
export LYRICS_STUDIO_DATA="$DATA"
LOG="$DATA/server.log"
# Found by what answers, not by port number: 8765 is home, but the server
# steps to the next free port when another app is sitting there.
lyrics_port() {
  for p in 8765 8766 8767 8768 8769 8770 8771 8772 8773 8774 8775; do
    case "$(/usr/bin/curl -s -m 1 "http://127.0.0.1:$p/api/version" 2>/dev/null)" in
      *lyrics-studio*) echo "$p"; return 0 ;;
    esac
  done
  return 1
}

if ! PORT="$(lyrics_port)"; then
  echo "$(date '+%F %T') starting" >>"$LOG"
  ( cd "$RES/lyrics-studio" && /usr/bin/nohup "$RES/uv" run server.py >>"$LOG" 2>&1 & )
fi
# The first launch fetches a Python and everything the server needs, which is
# minutes rather than seconds; the page is opened as soon as it answers, and
# after ten minutes regardless, so a failure ends up on screen and not in silence.
n=0
until PORT="$(lyrics_port)"; do
  n=$((n + 1)); [ $n -gt 1200 ] && { PORT=8765; break; }
  sleep 0.5
done
exec /usr/bin/open "http://localhost:$PORT"
LAUNCH
chmod 755 "$APP/Contents/MacOS/launch"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleName</key><string>$NAME</string>
	<key>CFBundleDisplayName</key><string>$NAME</string>
	<key>CFBundleIdentifier</key><string>com.pikemusicschool.rehearsaltool.lyrics</string>
	<key>CFBundleVersion</key><string>$(sed -n 's/^VERSION = "\(.*\)"/\1/p' lyrics-studio/server.py)</string>
	<key>CFBundleExecutable</key><string>launch</string>
	<key>CFBundleIconFile</key><string>app.icns</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

ZIP="$OUT/$NAME.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "packaged $APP  ($(du -sh "$APP" | cut -f1))"
echo "and $ZIP — that is the file to move to another Mac"
