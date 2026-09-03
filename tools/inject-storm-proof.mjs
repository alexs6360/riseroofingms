/* The hero's proof line, written from data/storm-index.json at build time.

   The hero asks for a home address and discloses that it will be followed up
   on. Between that claim and that ask there was nothing establishing the tool
   has any data behind it, so the most specific thing in the panel was the cost
   rather than the value. This line is the evidence.

   Build time rather than a fetch, for three reasons. The numbers would arrive
   after first paint and shift the form down, which is the one element the
   height queries in styles.css exist to keep above the fold. A fetch also puts
   the claim behind JavaScript, and the rest of the hero deliberately is not —
   the lookup is a GET form that works without it. And the file is regenerated
   by .github/workflows/refresh-storm-data.yml, whose commit triggers a Netlify
   rebuild, so a build-time read is no staler than a runtime one.

   Wording is constrained by what the data actually is. A cell is a 0.05-degree
   grid square containing a NEXRAD detection of MIN_SIZE_IN or larger, not a
   damaged roof and not a separate storm — storm-history.js is careful about
   this ("a radar hail cell is a storm-scale detection, not a damage footprint")
   and a number in the hero must not quietly claim more than the map does.

   The two layers run to different dates. The earlier of them is what gets
   printed: "current through" the later one would overstate the other. */

import fs from "node:fs";

const INDEX = "data/storm-index.json";
const PAGE = "dist/index.html";
const TOKEN = "__STORM_PROOF__";

const fail = (msg) => {
  console.error("  BUILD FAILED: " + msg);
  process.exit(1);
};

if (!fs.existsSync(INDEX)) fail(INDEX + " is missing — run tools/build-storm-data.mjs first");
if (!fs.existsSync(PAGE)) fail(PAGE + " is missing — this runs after the page is copied into dist/");

const idx = JSON.parse(fs.readFileSync(INDEX, "utf8"));
const cells = idx.hail && idx.hail.cells;
const winds = idx.wind && idx.wind.reports;
const years = idx.years || [];

/* Guarded rather than assumed. A zero or a missing key would render "0 hail
   cells", which is worse than no line at all — it would read as "we looked and
   there is nothing", the opposite of what the panel is for. */
if (!cells || !winds || !years.length) {
  fail(INDEX + " has no usable counts (cells=" + cells + ", reports=" + winds + ") — the hero proof line would understate the data");
}

/* The older of the two layer dates, so neither is overstated. */
const throughs = [idx.hail && idx.hail.through, idx.wind && idx.wind.through].filter(Boolean);
if (!throughs.length) fail(INDEX + " carries no currency date for either layer");
const through = throughs.sort()[0];

/* "Aug 2026", not "August 26, 2026". The day is noise at this size — nobody
   acts on it — and the abbreviated month is what keeps the line to one row at
   390. Every en-US short month is three characters, so there is no longest
   case to budget for. */
const monthYear = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d)) fail("unparseable date in " + INDEX + ": " + iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric", month: "short", timeZone: "UTC",
  });
};

const n = (v) => v.toLocaleString("en-US");

/* "cells" and "reports" are the source's own units, kept rather than rounded
   into "storms" or "events" — the precision is the point, and a homeowner who
   clicks through sees exactly these two layers on the map.

   Length is a hard constraint, not a matter of taste, and 390 sets it: the
   caption column is 350px there against 448 on desktop, so mobile is the only
   width that binds. Measured with white-space: nowrap at the worst case this
   can reach — six-digit counts both sides, which is 52 characters — the line
   needs 311px. That leaves 39px of margin at 390 and 137px at 1440.

   The sources are what paid for it. "NOAA and NWS, through " costs 22
   characters and pushes the worst case to 517px, which is 167px past the
   mobile column; the same line with the agencies kept and only the date
   abbreviated still lands at 352px against 350. Two of the three — unit nouns,
   sources, currency date — is all that fits, and the agencies are the part a
   homeowner can least act on. They remain on the storm page, on the map's own
   attribution, where someone checking the provenance will actually look. */
const line =
  "<strong>" + n(cells) + " hail cells</strong> · <strong>" + n(winds) +
  " wind reports</strong> · " + monthYear(through);

const html = fs.readFileSync(PAGE, "utf8");
if (!html.includes(TOKEN)) {
  fail(PAGE + " has no " + TOKEN + " placeholder — the hero proof line would ship empty");
}

fs.writeFileSync(PAGE, html.split(TOKEN).join(line));
console.log("  hero proof line: " + n(cells) + " cells, " + n(winds) + " wind reports, through " + through);
