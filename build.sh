#!/bin/bash
# Assembles dist/ from source. Run before every deploy — dist/ is not tracked
# and goes stale the moment a source file changes.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist

# Root pages and assets
cp index.html thanks.html privacy.html roof-system.html storm-history.html styles.css script.js storm-history.js robots.txt sitemap.xml dist/
cp -R images dist/images
cp -R data dist/data

# The grid maths the frontend needs are the generator's, not a second copy.
# Derived here from tools/storm-grid.mjs so there is one file to be wrong about.
# The export list is derived from the module, not hand-maintained. Keeping it
# by hand dropped four functions once and shapeCells a second time — both
# silent until something happened to call the missing one.
# LC_ALL=C so the collation is byte order, not the machine's locale. Without it
# macOS and Netlify's Linux agreed on the same set of exports but emitted them
# in a different key order, so the generated file was not byte-reproducible
# across platforms. Harmless in an object literal, but it is the same class of
# nondeterminism that made eight archive files rewrite themselves every run.
GRID_EXPORTS=$(grep -o '^export \(function\|const\) [A-Za-z_][A-Za-z0-9_]*' tools/storm-grid.mjs \
  | awk '{print $3}' | LC_ALL=C sort -u)
{
  sed 's/^export //' tools/storm-grid.mjs
  printf 'window.StormGrid = {'
  for name in $GRID_EXPORTS; do printf ' %s: %s,' "$name" "$name"; done
  printf ' };\n'
} > storm-grid.js
cp storm-grid.js dist/storm-grid.js

# The page and the module drifted apart three times: build.sh dropped the file
# once, dropped an export once, and shipped a page calling five functions the
# module had never exported. Cross-check them here so the build fails instead
# of the page. Both lists come from the source, neither is hand-written.
GRID_USED=$(grep -o 'G\.[a-zA-Z_][a-zA-Z0-9_]*\|window\.StormGrid\.[a-zA-Z_][a-zA-Z0-9_]*' storm-history.js \
  | sed 's/.*\.//' | LC_ALL=C sort -u)
MISSING=""
for name in $GRID_USED; do
  grep -q " ${name}: ${name}," storm-grid.js || MISSING="$MISSING $name"
done
if [ -n "$MISSING" ]; then
  echo "  BUILD FAILED: storm-history.js calls StormGrid members that storm-grid.js does not expose:$MISSING" >&2
  exit 1
fi
echo "  storm-grid.js exposes all $(echo "$GRID_USED" | wc -w | tr -d ' ') members the page calls"

# A media query adds no specificity, and this stylesheet interleaves its media
# queries with its base rules rather than gathering them at the end — so an
# override written inside one can be silently beaten by a base rule further
# down. That has shipped four times. Fails the build rather than warning:
# a warning in build output is a warning nobody reads.
node tools/check-css-order.mjs styles.css || exit 1

# Inject that same list as the page's runtime contract.
GRID_API_CSV=$(echo "$GRID_USED" | tr '\n' ',' | sed 's/,$//')
sed -i '' "s|__GRID_API__|${GRID_API_CSV}|" dist/storm-history.js 2>/dev/null \
  || sed -i "s|__GRID_API__|${GRID_API_CSV}|" dist/storm-history.js
cp -R video dist/video

# City landing pages (folder-per-page gives clean URLs)
for city in roofing-tupelo-ms roofing-oxford-ms roofing-southaven-ms storm-damage; do
  cp -R "$city" "dist/$city"
done

# One shared block across five pages, assembled here rather than pasted five
# times. Runs last: every page has to be in dist/ first, including the city
# directories copied above.
node tools/inject-partials.mjs || exit 1

# The hero's proof line, written from data/storm-index.json rather than fetched
# at runtime. Runs after index.html is in dist/ and fails the build if the
# placeholder is still there afterwards — an empty or literal __STORM_PROOF__
# in the hero is worse than the line not existing.
node tools/inject-storm-proof.mjs || exit 1


# Drag-and-drop bundle
rm -f rise-roofing-site.zip
( cd dist && zip -r -X ../rise-roofing-site.zip . -x '.*' >/dev/null )

echo "dist/ built — $(find dist -type f | wc -l | tr -d ' ') files, $(du -sh dist | cut -f1)"

# The Mapbox token is injected here, never committed. Netlify supplies
# MAPBOX_TOKEN from the site's environment variables; locally, .env.local
# (gitignored) does the same so the preview works.
if [ -f .env.local ]; then . ./.env.local; fi
if [ -n "${MAPBOX_TOKEN:-}" ]; then
  for f in dist/storm-history.js dist/script.js; do
    sed -i '' "s|__MAPBOX_TOKEN__|${MAPBOX_TOKEN}|" "$f" 2>/dev/null \
      || sed -i "s|__MAPBOX_TOKEN__|${MAPBOX_TOKEN}|" "$f"
  done
  echo "  mapbox token injected into dist/storm-history.js"
else
  echo "  WARNING: MAPBOX_TOKEN unset — the storm history map will show as unconfigured"
fi

# Cache-bust every versioned asset by content hash. Runs LAST, after the token
# injection, so the hash covers the file as actually served.
#
# Without this the browser serves a stale asset after a rebuild and the page
# runs old code or old CSS with no error — a card edge and a glow were
# "verified" against a cached stylesheet this way, and getComputedStyle cannot
# detect it because it reads from the same stale sheet that is painting.
# Netlify fingerprints nothing here either, so returning visitors hit the same
# problem on a real deploy.
stamp() {
  local file="$1" pattern="$2" v
  v=$(shasum -a256 "dist/$file" | cut -c1-8)
  find dist -name '*.html' -print0 | while IFS= read -r -d '' f; do
    sed -i '' -E "s|($pattern)\"|\1?v=${v}\"|g" "$f" 2>/dev/null \
      || sed -i -E "s|($pattern)\"|\1?v=${v}\"|g" "$f"
  done
  printf '%s' "$v"
}
CSS_V=$(stamp styles.css 'href="[^"]*styles\.css')
JS_V=$(stamp script.js 'src="[^"]*script\.js')
SH_V=$(stamp storm-history.js 'src="[^"]*storm-history\.js')
GRID_V=$(stamp storm-grid.js 'src="[^"]*storm-grid\.js')
echo "  asset versions: styles ${CSS_V}, script ${JS_V}, storm-history ${SH_V}, storm-grid ${GRID_V}"
