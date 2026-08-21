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
cp -R video dist/video

# City landing pages (folder-per-page gives clean URLs)
for city in roofing-tupelo-ms roofing-oxford-ms roofing-southaven-ms storm-damage; do
  cp -R "$city" "dist/$city"
done

# Drag-and-drop bundle
rm -f rise-roofing-site.zip
( cd dist && zip -r -X ../rise-roofing-site.zip . -x '.*' >/dev/null )

echo "dist/ built — $(find dist -type f | wc -l | tr -d ' ') files, $(du -sh dist | cut -f1)"

# The Mapbox token is injected here, never committed. Netlify supplies
# MAPBOX_TOKEN from the site's environment variables; locally, .env.local
# (gitignored) does the same so the preview works.
if [ -f .env.local ]; then . ./.env.local; fi
if [ -n "${MAPBOX_TOKEN:-}" ]; then
  sed -i '' "s|__MAPBOX_TOKEN__|${MAPBOX_TOKEN}|" dist/storm-history.js 2>/dev/null \
    || sed -i "s|__MAPBOX_TOKEN__|${MAPBOX_TOKEN}|" dist/storm-history.js
  echo "  mapbox token injected into dist/storm-history.js"
else
  echo "  WARNING: MAPBOX_TOKEN unset — the storm history map will show as unconfigured"
fi
