#!/bin/sh
#
# Let go of build files nothing refers to any more — once they are a day old.
#
#     sh scripts/prune-build.sh            (run by the launcher after a build)
#
# Builds no longer empty dist/, so that a page open through a rebuild keeps
# the files it loaded and goes on fetching what it needs — the encoder's
# worker, above all. That leaves earlier builds' assets behind. Anything the
# current index.html reaches, directly or through the chunks it names (the
# workers are named inside the main chunk, not in the HTML), is kept; the rest
# goes only once it is older than a day, by which time no page can still be
# on it. Small files, short delay, no hazard.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$REPO/dist/assets"
INDEX="$REPO/dist/index.html"
[ -d "$ASSETS" ] && [ -f "$INDEX" ] || exit 0

# Everything the page reaches: what index.html names, and what those name.
keep="$(grep -o 'assets/[A-Za-z0-9._-]*' "$INDEX" | sed 's|^assets/||' | sort -u)"
for f in $keep; do
  [ -f "$ASSETS/$f" ] && keep="$keep
$(grep -oh '[A-Za-z0-9._-]*-[A-Za-z0-9_-]\{8\}\.\(js\|css\|wasm\|woff2\)' "$ASSETS/$f" 2>/dev/null | sort -u)"
done

pruned=0
for path in "$ASSETS"/*; do
  [ -f "$path" ] || continue
  name="$(basename "$path")"
  if printf '%s\n' "$keep" | grep -qx "$name"; then continue; fi
  # Unreferenced — but only let go once nobody can still be running it.
  if [ -n "$(find "$path" -mmin +1440 2>/dev/null)" ]; then
    rm -f "$path" && pruned=$((pruned + 1))
  fi
done
[ "$pruned" -gt 0 ] && echo "pruned $pruned old build file(s)"
exit 0
