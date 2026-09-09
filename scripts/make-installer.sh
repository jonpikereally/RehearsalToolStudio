#!/bin/bash
# Build one installer for the studio: a .pkg that installs like any other app.
#
#     bash scripts/make-installer.sh [destination]      (default: Mac apps/)
#
# What package-app.sh and package-lyrics-studio.sh make are apps in zips, to
# be unzipped and dragged to Applications by hand. This wraps the same two
# apps in a macOS installer package — double-click it on any Mac, it opens
# in Installer, asks for the admin password like every installer does, and
# puts Rehearsal Tool Studio and Lyrics Studio into /Applications. Installing
# a newer one over an older one replaces the apps in place, and what was set
# up on that Mac (the remembered folders, the caches) is untouched, since
# none of it lives in the app.
#
# The Mac it is built on is what gets bundled: its Node, its uv. A Homebrew
# Node is usually universal and the window is compiled for both kinds of Mac
# when the tools can, so the installer says which Macs it will run on and
# refuses the others with a plain message rather than an app that won't open.
# Lyrics Studio wants Apple silicon regardless — Whisper on MLX is that only —
# and is left out when uv isn't installed here.
#
# Nothing here carries a Developer ID, so a copy that arrives through a
# browser is held by Gatekeeper once: on macOS 15 and later that is System
# Settings → Privacy & Security → "Open Anyway", not right-click → Open. A
# copy that arrives by Dropbox sync carries no quarantine and just opens.
#
# Run it from a normal terminal, not a sandboxed agent: neither pkgbuild nor
# the apps it packages work from inside one. Needs the command line tools and
# Node; uv too for Lyrics Studio.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
NAME="Rehearsal Tool Studio"
OUT="${1:-$REPO/Mac apps}"
mkdir -p "$OUT"

for tool in pkgbuild productbuild; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found — run: xcode-select --install" >&2; exit 1; }
done

BUILD="$(mktemp -d "${TMPDIR:-/tmp}/rts-installer.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
PKGS="$BUILD/pkgs"
RES="$BUILD/resources"
mkdir -p "$PKGS" "$RES"

# Each app is packaged the way it always is, into a root of its own that
# holds nothing else — pkgbuild takes the whole root, so the zip that comes
# with it is taken back out.
STUDIO_ROOT="$BUILD/root-studio"
bash scripts/package-app.sh "$STUDIO_ROOT"
rm -f "$STUDIO_ROOT"/*.zip
STUDIO="$STUDIO_ROOT/$NAME.app"
STAMP="$(sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$STUDIO/Contents/Resources/dist/build.json")"
[ -n "$STAMP" ] || { echo "the packaged app carries no build stamp" >&2; exit 1; }

LYRICS_ROOT="$BUILD/root-lyrics"
LYRICS=""
if command -v uv >/dev/null 2>&1; then
  bash scripts/package-lyrics-studio.sh "$LYRICS_ROOT"
  rm -f "$LYRICS_ROOT"/*.zip
  LYRICS="$LYRICS_ROOT/Lyrics Studio.app"
  LYRICS_VERSION="$(sed -n 's/^VERSION = "\(.*\)"/\1/p' lyrics-studio/server.py)"
else
  echo "uv is not installed here, so Lyrics Studio is left out of this installer (brew install uv)"
fi

# Which Macs the studio runs on: the ones both the window and the Node inside
# it were built for. Installer is told, and declines the rest up front.
archs_of() { lipo -archs "$1" 2>/dev/null || echo unknown; }
WINDOW_ARCHS="$(archs_of "$STUDIO/Contents/MacOS/$NAME")"
NODE_ARCHS="$(archs_of "$STUDIO/Contents/Resources/node")"
HOST_ARCHS=""
for a in arm64 x86_64; do
  case " $WINDOW_ARCHS " in *" $a "*) case " $NODE_ARCHS " in *" $a "*) HOST_ARCHS="${HOST_ARCHS:+$HOST_ARCHS,}$a" ;; esac ;; esac
done
[ -n "$HOST_ARCHS" ] || { echo "the window ($WINDOW_ARCHS) and node ($NODE_ARCHS) share no architecture" >&2; exit 1; }
echo "the studio runs on: $HOST_ARCHS"

# The app is put where it says and replaced whole, whatever version is there
# already: not found and updated wherever a copy was dragged to, and not
# skipped because a commit hash reads as no newer than another.
component_plist() {
  cat > "$2" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>RootRelativeBundlePath</key><string>$1</string>
		<key>BundleIsRelocatable</key><false/>
		<key>BundleIsVersionChecked</key><false/>
		<key>BundleOverwriteAction</key><string>upgrade</string>
	</dict>
</array>
</plist>
PLIST
}

echo "packaging the studio"
component_plist "$NAME.app" "$BUILD/studio.plist"
pkgbuild --root "$STUDIO_ROOT" --component-plist "$BUILD/studio.plist" \
  --install-location /Applications \
  --identifier com.pikemusicschool.rehearsaltool.studio --version "$STAMP" \
  "$PKGS/studio.pkg"

if [ -n "$LYRICS" ]; then
  echo "packaging Lyrics Studio"
  component_plist "Lyrics Studio.app" "$BUILD/lyrics.plist"
  pkgbuild --root "$LYRICS_ROOT" --component-plist "$BUILD/lyrics.plist" \
    --install-location /Applications \
    --identifier com.pikemusicschool.rehearsaltool.lyrics --version "$LYRICS_VERSION" \
    "$PKGS/lyrics.pkg"
fi

# What Installer shows: a welcome before, and afterwards what to do first.
cat > "$RES/welcome.html" <<HTML
<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,Helvetica,sans-serif;font-size:13px;line-height:1.45;margin:0 8px}</style></head><body>
<p>This installs <b>Rehearsal Tool Studio</b> into your Applications folder — build $STAMP, with everything it needs inside it. Nothing else has to be installed first.</p>
$( [ -n "$LYRICS" ] && printf '<p><b>Lyrics Studio</b> comes with it. It fetches its own Python and models the first time it is opened, which takes a few minutes and the network, once. It runs on Apple silicon Macs.</p>' )
<p>Installing over an earlier version replaces it. Your remembered folders, caches and settings are kept — they live in your Library, not in the app.</p>
</body></html>
HTML

cat > "$RES/conclusion.html" <<'HTML'
<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,Helvetica,sans-serif;font-size:13px;line-height:1.45;margin:0 8px}</style></head><body>
<p><b>Rehearsal Tool Studio</b> is in Applications.</p>
<p>The first time it opens it asks for the folder your Ableton sets live in. Point it at the Dropbox folder the sets are in, and make that folder <b>available offline</b> in Dropbox — files kept online-only are placeholders, not audio.</p>
<p>To prepare sets for the band from this Mac, choose the band's folder under <b>Publish to</b> in Settings.</p>
<p>Don't run the studio on two Macs at once against the same sets folder: both write the library file in it, and Dropbox answers with conflicted copies.</p>
</body></html>
HTML

LYRICS_LINE=""; LYRICS_CHOICE=""
if [ -n "$LYRICS" ]; then
  LYRICS_LINE='<line choice="lyrics"/>'
  LYRICS_CHOICE="<choice id=\"lyrics\" title=\"Lyrics Studio\" description=\"Timed lyric clips from a recording. Fetches its own Python on first open; Apple silicon only.\" start_selected=\"true\">
    <pkg-ref id=\"com.pikemusicschool.rehearsaltool.lyrics\"/>
  </choice>
  <pkg-ref id=\"com.pikemusicschool.rehearsaltool.lyrics\" version=\"$LYRICS_VERSION\" onConclusion=\"none\">lyrics.pkg</pkg-ref>"
fi

cat > "$BUILD/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>$NAME</title>
  <options customize="allow" rootVolumeOnly="true" require-scripts="false" hostArchitectures="$HOST_ARCHS"/>
  <domains enable_localSystem="true"/>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <choices-outline>
    <line choice="studio"/>
    $LYRICS_LINE
  </choices-outline>
  <choice id="studio" title="$NAME" description="The studio itself: reads the Ableton sets, plays them, and prepares them for the band." enabled="false" selected="true">
    <pkg-ref id="com.pikemusicschool.rehearsaltool.studio"/>
  </choice>
  <pkg-ref id="com.pikemusicschool.rehearsaltool.studio" version="$STAMP" onConclusion="none">studio.pkg</pkg-ref>
  $LYRICS_CHOICE
</installer-gui-script>
XML

PKG="$OUT/$NAME $STAMP.pkg"
rm -f "$PKG"
productbuild --distribution "$BUILD/distribution.xml" --package-path "$PKGS" --resources "$RES" "$PKG"
echo "made $PKG  ($(du -sh "$PKG" | cut -f1), build $STAMP)"
echo "that is the file to download on another Mac — double-click it and Installer does the rest"
