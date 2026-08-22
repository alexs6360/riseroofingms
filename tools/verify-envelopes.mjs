/* The hard constraint, checked against the whole archive.

   When the panel says a date had hail "in your area", it means the address's
   own 0.05-degree cell recorded a detection at that size. The map must not
   contradict that: the band drawn for that size has to contain the whole of
   that cell.

   This imports the page's own fitter — not a reimplementation of it — so a
   pass here is a statement about the code that actually renders.

   The address can sit anywhere inside its cell, and where it sits decides
   which cells fall in the 25km query and therefore what gets fitted. So each
   cell is tested from five positions: its centroid and its four corners. */
import fs from "node:fs";
import { GRID_DEG, fitEnvelopes } from "./storm-grid.mjs";

const HAIL_BANDS = [1.0, 1.5, 1.75, 2.0, 2.5];
const HAIL_W = 4.2, HAIL_L = 11, HAIL_LINK_KM = 8, STORM_KM = 25;

const cells = [];
for (const f of fs.readdirSync("data").sort())
  if (/^hail-\d{4}\.json$/.test(f)) cells.push(...JSON.parse(fs.readFileSync("data/" + f)).cells);

const byDate = new Map();
for (const c of cells) {
  if (!byDate.has(c[0])) byDate.set(c[0], []);
  byDate.get(c[0]).push(c);
}

const km = (a, b, c, d) => {
  const R = 6371, dLat = ((d - b) * Math.PI) / 180, dLon = ((c - a) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos((b * Math.PI) / 180) * Math.cos((d * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

let tested = 0, violations = [], worstMargin = Infinity;
const dates = [...byDate.keys()].sort();

for (const date of dates) {
  const day = byDate.get(date);
  for (const c of day) {
    const [, size, lon, lat, , by, bx] = c;
    const clat = by * GRID_DEG, clon = bx * GRID_DEG, h = GRID_DEG / 2;
    const corners = [
      [clon - h, clat - h], [clon + h, clat - h],
      [clon + h, clat + h], [clon - h, clat + h],
    ];
    for (const q of [[lon, lat], ...corners]) {
      const near = day.filter((o) => km(q[0], q[1], o[2], o[3]) <= STORM_KM);
      const fc = fitEnvelopes(
        near.map((o) => [o[6] * GRID_DEG, o[5] * GRID_DEG]), near.map((o) => o[1]),
        HAIL_BANDS, HAIL_L, HAIL_W, HAIL_LINK_KM
      );
      for (const min of HAIL_BANDS) {
        if (size < min) continue;
        const rings = fc.features.filter((f) => f.properties.min === min)
          .map((f) => f.geometry.coordinates[0]);
        const uncovered = corners.filter((k) => !rings.some((r) => inRing(k, r)));
        tested++;
        if (uncovered.length)
          violations.push({ date, cell: [by, bx], size, band: min, uncovered: uncovered.length });
      }
    }
  }
}

console.log(`dates            : ${dates.length}`);
console.log(`cell-band checks : ${tested.toLocaleString()}`);
console.log(`violations       : ${violations.length}`);
if (violations.length) {
  console.log("\nfirst 15:");
  for (const v of violations.slice(0, 15))
    console.log(`  ${v.date} cell ${v.cell} size ${v.size}" band ${v.band}" — ${v.uncovered}/4 corners outside`);
  const byBand = {};
  for (const v of violations) byBand[v.band] = (byBand[v.band] || 0) + 1;
  console.log("\nby band:", byBand);
}
process.exit(violations.length ? 1 : 0);
