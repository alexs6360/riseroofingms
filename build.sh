#!/bin/bash
# Assembles dist/ from source. Run before every deploy — dist/ is not tracked
# and goes stale the moment a source file changes.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist

# Root pages and assets
cp index.html thanks.html styles.css script.js robots.txt sitemap.xml dist/
cp -R images dist/images
cp -R video dist/video

# City landing pages (folder-per-page gives clean URLs)
for city in roofing-tupelo-ms roofing-oxford-ms roofing-southaven-ms storm-damage; do
  cp -R "$city" "dist/$city"
done

# Drag-and-drop bundle
rm -f rise-roofing-site.zip
( cd dist && zip -r -X ../rise-roofing-site.zip . -x '.*' >/dev/null )

echo "dist/ built — $(find dist -type f | wc -l | tr -d ' ') files, $(du -sh dist | cut -f1)"
