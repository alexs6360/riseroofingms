/* Generates the card's background motif from the actual storm archive.

   The shapes are real: the fitted envelopes for one recorded hail day, from
   the same fitEnvelopes call the map and the lead notification use. It is our
   own data used as ornament rather than a stock pattern — and because it comes
   from the shipped fitter, it cannot drift into being a decorative lie about
   what our swaths look like.

   Emits a data: URI for styles.css. Re-run to regenerate; the output is
   deliberately committed rather than built on every deploy, since it is a
   fixed illustration and not live data. */
import fs from "node:fs";
import { GRID_DEG, fitEnvelopes } from "./storm-grid.mjs";

const DATE = process.argv[2] || "2025-03-23";
const cells = [];
for (const f of fs.readdirSync("data").sort())
  if (/^hail-\d{4}\.json$/.test(f)) cells.push(...JSON.parse(fs.readFileSync("data/" + f)).cells);

const day = cells.filter((c) => c[0] === DATE);
if (!day.length) throw new Error("no cells on " + DATE);

const fc = fitEnvelopes(
  day.map((c) => [c[6] * GRID_DEG, c[5] * GRID_DEG]),
  day.map((c) => c[1]),
  [1.0, 1.5, 1.75, 2.0, 2.5], 11, 4.2, 8
);

/* Keep the largest cluster's nested bands: one continuous form with its cores
   inside it, which is what a swath actually looks like. A field of unrelated
   lozenges would read as noise. */
const byArea = (r) => Math.abs(r.reduce((s, p, i) => {
  const q = r[(i + 1) % r.length];
  return s + (p[0] * q[1] - q[0] * p[1]);
}, 0) / 2);
const rings = fc.features.map((f) => f.geometry.coordinates[0]).sort((a, b) => byArea(b) - byArea(a));
const biggest = rings[0];
let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
for (const p of biggest) {
  mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]);
  mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1]);
}
/* Only rings that sit inside the biggest one's bounds — the nested cores. */
const keep = rings.filter((r) =>
  r.every((p) => p[0] >= mnx - 0.01 && p[0] <= mxx + 0.01 && p[1] >= mny - 0.01 && p[1] <= mxy + 0.01)
).slice(0, 4);

const W = 1000, H = Math.round((W * (mxy - mny)) / (mxx - mnx));
const X = (lon) => (((lon - mnx) / (mxx - mnx)) * W).toFixed(0);
const Y = (lat) => ((1 - (lat - mny) / (mxy - mny)) * H).toFixed(0);

/* Integer coordinates in a 1000-wide viewBox: at the size this renders, more
   precision is bytes nobody can see.

   The opacity ramp is deliberately near the floor — 1.2% to 4.5% white on
   navy. The first pass ran 5% to 18.5%, and four nested rings stacking at that
   strength read as a grey blob across the card rather than as texture: it drew
   attention to itself, which is the one thing this must not do. */
const paths = keep.map((r, i) => {
  let d = "", last = "";
  for (let n = 0; n < r.length; n++) {
    const pt = X(r[n]) + " " + Y(r[n][1] !== undefined ? r[n] : r[n]);
    void pt;
  }
  d = r.map((p, n) => (n ? "L" : "M") + X(p[0]) + " " + Y(p[1])).join("");
  /* Collapse repeated identical points left by rounding. */
  d = d.replace(/(L(-?\d+) (-?\d+))(?=\1)/g, "");
  void last;
  return `<path d="${d}Z" fill="#fff" fill-opacity="${(0.012 + i * 0.011).toFixed(3)}"/>`;
});

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">` +
  paths.join("") + `</svg>`;

const uri = "data:image/svg+xml," + encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
fs.writeFileSync("tools/.swath-motif.txt", uri);
console.log(`  ${DATE}: ${keep.length} nested rings, viewBox ${W}x${H}, ${(uri.length / 1024).toFixed(1)} KB`);
