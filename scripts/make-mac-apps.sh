#!/bin/bash
# Install the studio's Mac apps, straight into /Applications.
#
# Rehearsal Tool Studio is a real app, a WebKit window of its own, built by
# make-studio-app.sh. Lyrics Studio is part of it — the Lyrics tab — and has
# no app of its own any more; a Lyrics Studio.app left by an earlier run of
# this is taken away. Run this again when the repo moves, since the studio
# app carries its path.
#
#     bash scripts/make-mac-apps.sh [destination]
#
# Run it from a normal terminal, not from a sandboxed agent: macOS stamps
# files created in the sandbox with a provenance attribute that makes
# LaunchServices refuse the app outright.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="$(pwd)"
ICON_SRC="public/icon-512.png"
OUT="${1:-/Applications}"
mkdir -p "$OUT" 2>/dev/null || true
[ -w "$OUT" ] || OUT="$HOME/Applications"
mkdir -p "$OUT"

# A modern .icns can simply carry a PNG — ic09 is the 512-point slot, and
# macOS scales the rest. No sips, no iconutil, no temp files.
make_icns() {
  node -e '
    const { readFileSync, writeFileSync } = require("fs");
    const png = readFileSync(process.argv[1]);
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const chunk = Buffer.concat([Buffer.from("ic09"), u32(8 + png.length), png]);
    writeFileSync(process.argv[2], Buffer.concat([Buffer.from("icns"), u32(8 + chunk.length), chunk]));
  ' "$ICON_SRC" "$1"
}

make_app() {
  local name="$1" tool="$2" id="$3"
  local app="$OUT/$name.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleName</key><string>$name</string>
	<key>CFBundleDisplayName</key><string>$name</string>
	<key>CFBundleIdentifier</key><string>$id</string>
	<key>CFBundleVersion</key><string>2.0</string>
	<key>CFBundleExecutable</key><string>launch</string>
	<key>CFBundleIconFile</key><string>app.icns</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

  cat > "$app/Contents/MacOS/launch" <<LAUNCH
#!/bin/sh
exec /bin/sh "$REPO/scripts/app-launch.sh" $tool
LAUNCH
  chmod +x "$app/Contents/MacOS/launch"
  make_icns "$app/Contents/Resources/app.icns"
  plutil -lint "$app/Contents/Info.plist" >/dev/null
  echo "installed $app"
}

# The studio's window is its own app; a stub stands in only where there is no compiler.
if command -v swiftc >/dev/null 2>&1 || [ -x /Library/Developer/CommandLineTools/usr/bin/swiftc ]; then
  bash scripts/make-studio-app.sh "$OUT"
else
  make_app "Rehearsal Tool Studio" studio "com.pikemusicschool.rehearsaltool.studio.launcher"
fi

# Lyrics Studio used to be an app of its own. Only ours is removed — known by
# its bundle identifier, never by name alone.
for DIR in "$OUT" /Applications "$HOME/Applications"; do
  OLD="$DIR/Lyrics Studio.app"
  [ -d "$OLD" ] || continue
  case "$(/usr/bin/plutil -extract CFBundleIdentifier raw "$OLD/Contents/Info.plist" 2>/dev/null)" in
    com.pikemusicschool.rehearsaltool.lyrics*) rm -rf "$OLD" 2>/dev/null && echo "removed $OLD — Lyrics Studio is the studio's Lyrics tab now" ;;
  esac
done
echo "Done — it's in $OUT, ready for the Dock. Future launcher changes need no reinstall."
