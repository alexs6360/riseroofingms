/* Storm data generator for storm-history.html.

   Runs at build time or from the weekly GitHub Action, never in the request
   path. Output is committed as static JSON so the page stays on Netlify with
   no backend.

   Three sources, all free and public:

     hail cells   NCEI SWDI nx3hail — NEXRAD Level-III hail detections, which
                  carry a radar-estimated max size in inches. This is NOT MRMS
                  MESH: MESH is gridded and only distributed as GRIB2, which
                  needs a geo stack we do not have and ~125 GB of downloads for
                  ten years. Same family of radar estimate, delivered as cells.
                  Runs about four days behind.

     reports      NCEI Storm Events — the quality-controlled NWS reports. Runs
                  about four months behind, so it is the historical layer only.

     recent wind  Iowa State's NWS Local Storm Reports feed — the same spotter
                  reports Storm Events eventually publishes, available within a
                  day. Used only for dates after the newest Storm Events
                  record, so the two can never describe the same event twice.

   Units are normalised here: everything leaves this file in mph for wind and
   inches for hail. Storm Events stores knots and LSRs store mph, and having
   the browser guess which is which is exactly how a 66 mph gust becomes 76.
*/
import fs from "node:fs";
import zlib from "node:zlib";
import { GRID_DEG, cellKey, bucketOf, preferred, preferredReport } from "./storm-grid.mjs";

/* One geographic filter for every layer. A bbox rather than a list of county
   names: a homeowner two miles over the Pontotoc line should not get an empty
   result because of where a surveyor drew a boundary in 1836. */
const BBOX = { minLon: -91.0, minLat: 33.9, maxLon: -88.4, maxLat: 35.05 };
const BBOX_STR = [BBOX.minLon, BBOX.minLat, BBOX.maxLon, BBOX.maxLat].join(",");

const YEARS = Number(process.env.YEARS || 10);
const END = new Date(Number(process.env.END_MS) || Date.now());
const OUT = process.argv[2];

const BUFFER_KM = 1.5;      // stated on the page; the circle is a radar cell, not a footprint
const MIN_SIZE_IN = 1.0;    // roughly where hail starts mattering to asphalt shingles
const KT_TO_MPH = 1.15078;

const inBbox = (lon, lat) =>
  lon >= BBOX.minLon && lon <= BBOX.maxLon && lat >= BBOX.minLat && lat <= BBOX.maxLat;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (res.ok) return res;
      if (res.status === 404) return null;
    } catch (e) { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}

const MONTHS = { JAN:"01", FEB:"02", MAR:"03", APR:"04", MAY:"05", JUN:"06",
                 JUL:"07", AUG:"08", SEP:"09", OCT:"10", NOV:"11", DEC:"12" };

/* Storm Events writes BEGIN_DATE_TIME as DD-MON-YY HH:MM:SS. Slicing the first
   ten characters leaves "15-JUN-16 ", which no date parser reads and which
   string-sorts by day of month — that put 2016 above 2026 in a list whose
   whole promise is "most recent first". */
function isoDate(raw) {
  const m = /^(\d{2})-([A-Z]{3})-(\d{2})/.exec((raw || "").trim().toUpperCase());
  if (!m) return "";
  return `20${m[3]}-${MONTHS[m[2]] || "01"}-${m[1]}`;
}

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* ---- hail cells ---------------------------------------------------------- */

function monthsBack(n, end) {
  const out = [];
  const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  for (let i = 0; i < n * 12; i++) {
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
    const f = (x) => x.toISOString().slice(0, 10).replace(/-/g, "");
    out.push([f(s), f(e)]);
  }
  return out.reverse();
}

async function hail() {
  const raw = [];
  for (const [s, e] of monthsBack(YEARS, END)) {
    /* SWDI silently returns nothing for ranges over ~31 days, so this is
       chunked by month rather than pulled a year at a time. */
    const res = await get(`https://www.ncei.noaa.gov/swdiws/csv/nx3hail/${s}:${e}?bbox=${BBOX_STR}`);
    if (!res) { process.stderr.write(`  ! hail ${s} failed\n`); continue; }
    const lines = (await res.text()).split("\n");
    const h = lines.findIndex((l) => l.startsWith("ZTIME,"));
    if (h < 0) continue;
    const cols = lines[h].trim().split(",");
    for (const line of lines.slice(h + 1)) {
      if (!line.trim()) continue;
      const v = line.trim().split(",");
      const r = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
      const size = parseFloat(r.MAXSIZE), lat = parseFloat(r.LAT), lon = parseFloat(r.LON);
      if (!isFinite(size) || !isFinite(lat) || !isFinite(lon) || size < MIN_SIZE_IN) continue;
      if (!inBbox(lon, lat)) continue;
      raw.push({ t: r.ZTIME, size, lat, lon, src: r.WSR_ID });
    }
    await sleep(250);
  }

  /* Three radars see one storm, so the same cell arrives two or three times a
     minute apart. Collapse by day and ~5km, keeping the largest estimate and
     the radars that saw it — otherwise one hailstorm reads as a dozen separate
     events in a homeowner's results list. */
  const byKey = new Map();
  for (const c of raw) {
    const day = c.t.slice(0, 10);
    const key = cellKey(day, c.lat, c.lon);
    const prev = byKey.get(key);
    if (preferred(c, prev)) {
      byKey.set(key, { ...c, day, srcs: new Set([...(prev?.srcs || []), c.src]) });
    } else prev.srcs.add(c.src);
  }

  /* Fully ordered, so insertion order never leaks into the file. */
  const cells = [...byKey.values()]
    .sort((a, b) =>
      a.day !== b.day ? (a.day < b.day ? 1 : -1)
      : a.lon !== b.lon ? a.lon - b.lon
      : a.lat - b.lat)
    .map((c) => {
      /* Bucket indices travel with the cell. The stored coordinate is the
         survivor detection rounded to 3dp, so a consumer recomputing the
         bucket from it can land on the wrong side of an edge — which is
         exactly the class of bug this ends. */
      const [by, bx] = bucketOf(c.lat, c.lon);
      return [c.day, +c.size.toFixed(2), +c.lon.toFixed(3), +c.lat.toFixed(3), [...c.srcs].sort().join("/"), by, bx];
    });
  return { raw: raw.length, cells };
}

/* ---- reports: Storm Events for history, LSRs for the recent window ------- */

async function stormEvents() {
  const idx = await get("https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/");
  const listing = idx ? await idx.text() : "";
  const out = [];
  const first = END.getUTCFullYear() - YEARS;
  for (let y = first; y <= END.getUTCFullYear(); y++) {
    /* NCEI stamps each file with a _c revision date. Taking the first match in
       HTML listing order would pin us to whichever the directory happened to
       list first — likely the older one, and liable to flip if the listing
       order ever changes.

       Lexical max works because every stamp is the same width (_cYYYYMMDD),
       so string order and date order agree. That holds across all 17 years
       listed today. If NCEI ever changes the stamp format — a different width,
       a suffix, a non-date — this silently picks the wrong file rather than
       failing, so it is worth re-checking if the archive starts looking
       stale. */
    const revisions = [
      ...listing.matchAll(new RegExp(`StormEvents_details-ftp_v1\\.0_d${y}_c\\d+\\.csv\\.gz`, "g")),
    ].map((x) => x[0]).sort();
    if (!revisions.length) continue;
    const file = revisions[revisions.length - 1];
    const res = await get(`https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/${file}`);
    if (!res) { process.stderr.write(`  ! reports ${y} (${file}) failed\n`); continue; }
    const text = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    const lines = text.split("\n");
    const cols = parseCsvLine(lines[0]);
    const at = (r, k) => r[cols.indexOf(k)];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const r = parseCsvLine(line);
      const kind = at(r, "EVENT_TYPE");
      if (kind !== "Hail" && kind !== "Thunderstorm Wind") continue;
      const lat = parseFloat(at(r, "BEGIN_LAT")), lon = parseFloat(at(r, "BEGIN_LON"));
      if (!isFinite(lat) || !isFinite(lon) || !inBbox(lon, lat)) continue;
      const mag = parseFloat(at(r, "MAGNITUDE"));
      const isHail = kind === "Hail";
      out.push({
        date: isoDate(at(r, "BEGIN_DATE_TIME")),
        kind: isHail ? "hail" : "wind",
        /* normalised here: Storm Events stores wind in knots */
        val: isFinite(mag) ? +(isHail ? mag : mag * KT_TO_MPH).toFixed(isHail ? 2 : 0) : null,
        lon: +lon.toFixed(4),
        lat: +lat.toFixed(4),
        src: "NWS Storm Events",
      });
    }
    process.stderr.write(`  storm events ${y}: ${out.length} running total\n`);
  }
  return out.filter((r) => r.date);
}

/* Local Storm Reports: the same spotter reports, a day old instead of four
   months. Only used after the newest Storm Events record, so the two can never
   hold the same event. */
async function localStormReports(afterDate) {
  const out = [];
  const start = new Date(afterDate + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() + 1);
  const chunkDays = 90;
  for (let from = new Date(start); from < END; from.setUTCDate(from.getUTCDate() + chunkDays)) {
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + chunkDays);
    const iso = (d) => d.toISOString().slice(0, 19) + "Z";
    const res = await get(
      `https://mesonet.agron.iastate.edu/geojson/lsr.php?sts=${iso(from)}&ets=${iso(to > END ? END : to)}&states=MS,TN,AR`
    );
    if (!res) { process.stderr.write(`  ! lsr ${iso(from)} failed\n`); continue; }
    let data;
    try { data = await res.json(); } catch (e) { continue; }
    for (const f of data.features || []) {
      const p = f.properties;
      const lon = parseFloat(p.lon), lat = parseFloat(p.lat);
      if (!isFinite(lon) || !isFinite(lat) || !inBbox(lon, lat)) continue;
      const type = (p.typetext || "").toUpperCase();
      const mag = parseFloat(p.magnitude);
      let kind = null, val = null;
      if (type === "HAIL") {
        kind = "hail";
        val = isFinite(mag) ? +mag.toFixed(2) : null;
      } else if (type === "TSTM WND GST") {
        kind = "wind";
        /* LSR gusts are already MPH — converting again turns 66 into 76. */
        val = isFinite(mag) ? Math.round(mag) : null;
      } else if (type === "TSTM WND DMG" || type === "NON-TSTM WND DMG") {
        /* A real event with no measured gust. Kept, with no number: dropping
           it hides a storm, and showing 0 mph invents a reading. */
        kind = "wind";
        val = null;
      } else continue;
      out.push({
        date: (p.valid || "").slice(0, 10),
        kind, val,
        lon: +lon.toFixed(4),
        lat: +lat.toFixed(4),
        src: "NWS Local Storm Report",
      });
    }
    await sleep(250);
  }
  return out.filter((r) => r.date);
}

/* Belt and braces. Splitting by date should make overlap impossible, but if
   Storm Events ever backfills past its own newest record this stops the same
   storm being listed twice. ~1km, same day, same kind, same value. */
function dedupe(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = [
      r.date, r.kind,
      Math.round(r.lat / 0.01), Math.round(r.lon / 0.01),
      r.val === null ? "null" : r.val,
    ].join("|");
    /* Not first-wins. Nothing collides in the current archive — 1,446 rows,
       1,446 distinct keys — but first-wins is the exact defect that made the
       hail files rewrite themselves every week, and it would wake up the first
       time two spotters report one storm from adjacent addresses. */
    if (preferredReport(r, byKey.get(key))) byKey.set(key, r);
  }
  return [...byKey.values()];
}

/* ---- write, split by year ------------------------------------------------ */

const h = await hail();
const se = await stormEvents();
const seThrough = se.length ? se.map((r) => r.date).sort().pop() : "1970-01-01";
const lsr = await localStormReports(seThrough);
const reports = dedupe([...se, ...lsr]).sort((a, b) =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1)
  : a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1)
  : a.lon !== b.lon ? a.lon - b.lon
  : a.lat !== b.lat ? a.lat - b.lat
  : (a.val || 0) - (b.val || 0));

fs.mkdirSync(OUT, { recursive: true });
const years = new Set();
const byYear = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const y = key(r).slice(0, 4);
    years.add(y);
    if (!m.has(y)) m.set(y, []);
    m.get(y).push(r);
  }
  return m;
};

const hailYears = byYear(h.cells, (c) => c[0]);
const repYears = byYear(reports, (r) => r.date);

let totalRaw = 0, totalGz = 0;
const write = (name, obj) => {
  const s = JSON.stringify(obj);
  fs.writeFileSync(`${OUT}/${name}`, s);
  totalRaw += s.length;
  totalGz += zlib.gzipSync(Buffer.from(s)).length;
};

for (const y of [...years].sort()) {
  write(`hail-${y}.json`, { fields: ["date", "in", "lon", "lat", "radar", "by", "bx"], cells: hailYears.get(y) || [] });
  write(`reports-${y}.json`, { fields: ["date", "kind", "val", "lon", "lat", "src"],
    reports: (repYears.get(y) || []).map((r) => [r.date, r.kind, r.val, r.lon, r.lat, r.src]) });
}

/* Currency is per layer and computed from the data, not from the clock: a
   homeowner should never read "no wind" when the truth is "no wind data that
   recent". */
const hailThrough = h.cells.length ? h.cells[0][0] : null;
const windRows = reports.filter((r) => r.kind === "wind");
const windThrough = windRows.length ? windRows[0].date : null;

/* No build timestamp here. It changed on every run whether or not any storm
   data did, which defeated the workflow's "commit only if something changed"
   guard and produced a commit every week regardless. Currency comes from the
   newest record in each layer instead — which is what a reader actually wants
   to know. */
write("storm-index.json", {
  years: [...years].sort(),
  buffer_km: BUFFER_KM,
  min_size_in: MIN_SIZE_IN,
  grid_deg: GRID_DEG,
  bbox: BBOX,
  hail: { through: hailThrough, source: "NOAA NCEI SWDI (NEXRAD Level-III)", cells: h.cells.length },
  wind: {
    through: windThrough,
    source: "NWS Storm Events and Local Storm Reports",
    storm_events_through: seThrough,
    reports: windRows.length,
  },
});

console.log(`\n  hail:    ${h.raw} raw detections >= ${MIN_SIZE_IN}in -> ${h.cells.length} cells, through ${hailThrough}`);
console.log(`  reports: ${se.length} Storm Events (through ${seThrough}) + ${lsr.length} LSRs -> ${reports.length} after dedupe`);
console.log(`  wind current through ${windThrough}`);
console.log(`  ${[...years].length * 2 + 1} files, ${(totalRaw / 1024).toFixed(0)} KB raw, ${(totalGz / 1024).toFixed(0)} KB gzipped`);
