#!/bin/bash
# Build and install the studio's Mac app: a WebKit window around the studio's
# own server, compiled from mac/RehearsalToolStudio/main.swift.
#
#     bash scripts/make-studio-app.sh [destination]      (default /Applications)
#
# Run it from a normal terminal, not from a sandboxed agent: macOS stamps
# files created in the sandbox with a provenance attribute that makes
# LaunchServices refuse the app outright. It needs only the command line
# tools (`xcode-select --install`), not Xcode.
#
# The repo's path is baked into Info.plist as RTSRepo, which is how the app
# finds scripts/app-launch.sh to start its servers — so rebuild it if the
# checkout moves. The launcher itself changes by commit, as before.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="$(pwd)"
NAME="Rehearsal Tool Studio"
ICON_SRC="public/icon-512.png"
OUT="${1:-/Applications}"
mkdir -p "$OUT" 2>/dev/null || true
[ -w "$OUT" ] || OUT="$HOME/Applications"
mkdir -p "$OUT"
APP="$OUT/$NAME.app"

SWIFTC="$(command -v swiftc || true)"
[ -n "$SWIFTC" ] || SWIFTC=/Library/Developer/CommandLineTools/usr/bin/swiftc
[ -x "$SWIFTC" ] || { echo "swiftc not found — run: xcode-select --install" >&2; exit 1; }
SDK="$(xcrun --sdk macosx --show-sdk-path)"

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
"$SWIFTC" -O -sdk "$SDK" -target "$(uname -m)-apple-macos12.0" -module-cache-path "$BUILD/cache" \
  -o "$BUILD/$NAME" mac/RehearsalToolStudio/main.swift -framework Cocoa -framework WebKit

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

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "$BUILD/$NAME" "$APP/Contents/MacOS/$NAME"
make_icns "$APP/Contents/Resources/app.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleName</key><string>$NAME</string>
	<key>CFBundleDisplayName</key><string>$NAME</string>
	<key>CFBundleIdentifier</key><string>com.pikemusicschool.rehearsaltool.studio</string>
	<key>CFBundleVersion</key><string>3.0</string>
	<key>CFBundleShortVersionString</key><string>3.0</string>
	<key>CFBundleExecutable</key><string>$NAME</string>
	<key>CFBundleIconFile</key><string>app.icns</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSAppTransportSecurity</key>
	<dict><key>NSAllowsLocalNetworking</key><true/></dict>
	<key>RTSRepo</key><string>$REPO</string>
	<!-- Folders and sets can be dropped on the Dock icon; the app never claims .als from Live. -->
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key><string>Folder</string>
			<key>CFBundleTypeRole</key><string>Viewer</string>
			<key>LSHandlerRank</key><string>None</string>
			<key>LSItemContentTypes</key><array><string>public.folder</string></array>
		</dict>
		<dict>
			<key>CFBundleTypeName</key><string>Ableton Live Set</string>
			<key>CFBundleTypeRole</key><string>Viewer</string>
			<key>LSHandlerRank</key><string>None</string>
			<key>CFBundleTypeExtensions</key><array><string>als</string></array>
		</dict>
	</array>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# Ad hoc signed, which is all an app that never leaves this machine needs.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "installed $APP"
