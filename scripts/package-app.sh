#!/bin/bash
# Package Rehearsal Tool Studio as an app that installs like any other.
#
#     bash scripts/package-app.sh [destination]      (default: Mac apps/)
#
# What make-studio-app.sh builds is a window onto this folder: it needs Node
# on the machine and the repo on the disk, and rebuilds itself on launch. That
# is right for the machine the studio is developed on, where a commit is the
# deploy. This builds the other thing — an app with a Node runtime, a finished
# build and its servers all inside it, that a Mac with none of that can run
# from Applications. It carries no path to anywhere.
#
# Alongside the .app it writes a .zip made with ditto, which is how to move it
# between Macs: a zip keeps the bundle's permissions where a folder sync may
# not. On the other Mac, unzip and drag to Applications. Nothing here is
# signed with a Developer ID, so a copy that came through a browser is held by
# Gatekeeper once — on macOS 15 and later, System Settings → Privacy &
# Security → "Open Anyway". For an installer that does the dragging, and
# carries Lyrics Studio too, see scripts/make-installer.sh.
#
# Run it from a normal terminal, not a sandboxed agent: macOS refuses apps
# stamped with a sandbox's provenance. Needs the command line tools and Node.
#
# Lyrics Studio is packaged separately: scripts/package-lyrics-studio.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
NAME="Rehearsal Tool Studio"
OUT="${1:-$REPO/Mac apps}"
mkdir -p "$OUT"
APP="$OUT/$NAME.app"

SWIFTC="$(command -v swiftc || true)"
[ -n "$SWIFTC" ] || SWIFTC=/Library/Developer/CommandLineTools/usr/bin/swiftc
[ -x "$SWIFTC" ] || { echo "swiftc not found — run: xcode-select --install" >&2; exit 1; }
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found — it is what gets bundled" >&2; exit 1; }
NODE_BIN="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$NODE_BIN")"

# The Node that ships is this machine's. A universal binary runs on either kind
# of Mac; a single-architecture one runs only on its own kind, which is worth
# knowing before the app is handed to an Intel Mac.
ARCHS="$(lipo -archs "$NODE_BIN" 2>/dev/null || echo unknown)"
echo "bundling node $(node -v) ($ARCHS) from $NODE_BIN"
case "$ARCHS" in *x86_64*arm64*|*arm64*x86_64*) ;; *) echo "  note: single-architecture — it will only run on $ARCHS Macs" ;; esac

SDK="$(xcrun --sdk macosx --show-sdk-path)"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/rts-package.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT

# The build that ships, made now into a clean folder of its own — never
# dist/, which keeps earlier builds' files around for any page still on
# them and would carry them into the bundle.
echo "building the studio"
npx tsc -b >/dev/null
npx vite build --outDir "$BUILD/dist" --emptyOutDir >/dev/null
STAMP="$(sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$BUILD/dist/build.json")"
echo "compiling the window"
compile_window() {
  "$SWIFTC" -O -sdk "$SDK" -target "$1-apple-macos12.0" -module-cache-path "$BUILD/cache-$1" \
    -o "$2" mac/RehearsalToolStudio/main.swift -framework Cocoa -framework WebKit
}
compile_window "$(uname -m)" "$BUILD/$NAME"
# And for the other kind of Mac when the tools can, so the window is as
# universal as the Node beside it; when they can't, the app is this Mac's kind.
OTHER=x86_64; [ "$(uname -m)" = x86_64 ] && OTHER=arm64
if compile_window "$OTHER" "$BUILD/$NAME-$OTHER" 2>/dev/null; then
  lipo -create "$BUILD/$NAME" "$BUILD/$NAME-$OTHER" -output "$BUILD/$NAME-universal"
  mv "$BUILD/$NAME-universal" "$BUILD/$NAME"
  rm -f "$BUILD/$NAME-$OTHER"
else
  echo "  note: the window compiled for $(uname -m) only"
fi

# A modern .icns can simply carry a PNG — ic09 is the 512-point slot.
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
mkdir -p "$APP/Contents/MacOS" "$RES/scripts"
mv "$BUILD/$NAME" "$APP/Contents/MacOS/$NAME"
make_icns "$RES/app.icns"
cp "$NODE_BIN" "$RES/node" && chmod 755 "$RES/node"
cp -R "$BUILD/dist" "$RES/dist"
# The servers, laid out as they are here, so serve-studio finds ../dist unchanged.
cp scripts/serve-studio.mjs scripts/studio-files.mjs scripts/slate-helper.mjs "$RES/scripts/"
cp scripts/packaged-launch.sh "$RES/launch.sh" && chmod 755 "$RES/launch.sh"

# No RTSRepo: its absence is how the window knows it is the packaged kind.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleName</key><string>$NAME</string>
	<key>CFBundleDisplayName</key><string>$NAME</string>
	<key>CFBundleIdentifier</key><string>com.pikemusicschool.rehearsaltool.studio</string>
	<key>CFBundleVersion</key><string>$STAMP</string>
	<key>CFBundleShortVersionString</key><string>3.0</string>
	<key>CFBundleExecutable</key><string>$NAME</string>
	<key>CFBundleIconFile</key><string>app.icns</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSAppTransportSecurity</key>
	<dict><key>NSAllowsLocalNetworking</key><true/></dict>
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

# Ad hoc, the whole bundle. Not a Developer ID, so Gatekeeper asks once on
# another Mac (right-click → Open); after that it is an ordinary app.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

ZIP="$OUT/$NAME $STAMP.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "packaged $APP  ($(du -sh "$APP" | cut -f1), build $STAMP)"
echo "and $ZIP — that is the file to move to another Mac"
