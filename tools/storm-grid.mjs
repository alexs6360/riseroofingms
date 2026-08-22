/* The grid maths and the tiebreak, in one place.

   Extracted so the generator and any analysis of its output share a single
   implementation. Re-deriving this in a throwaway script is how an audit ends
   up measuring its own arithmetic instead of the data — it happened twice.

   Behaviour is unchanged; this is a move, not a rewrite. */

export const GRID_DEG = 0.05;   // ~5km: three radars see one storm and report
                                // it two or three times a minute apart

/* A detection's cell is a function of its own raw coordinate and nothing else.
   Note what is NOT an input: the comparator, the arrival order, the contents
   of any other detection. */
export function cellKey(day, lat, lon) {
  const [by, bx] = bucketOf(lat, lon);
  return `${day}|${by}|${bx}`;
}

/* The bucket a coordinate falls in, as [latIndex, lonIndex].

   Emitted with every cell so the browser reads the indices instead of
   recomputing them from a 3-decimal coordinate. Reconstructing this arithmetic
   downstream produced five wrong answers in one session; the fix is to stop
   reconstructing it. */
export function bucketOf(lat, lon) {
  return [Math.round(lat / GRID_DEG), Math.round(lon / GRID_DEG)];
}

/* Which of two detections in the same cell survives. Size decides first and
   unconditionally; position and time only break exact size ties. Ties used to
   fall to arrival order, which SWDI does not keep stable, so historical files
   rewrote themselves every run. */
export function preferred(a, b) {
  if (!b) return true;
  if (a.size !== b.size) return a.size > b.size;
  if (a.lon !== b.lon) return a.lon < b.lon;
  if (a.lat !== b.lat) return a.lat < b.lat;
  return a.t < b.t;
}

/* The reports equivalent. Value is part of the dedupe key, so only position
   and source can differ between two rows that collide — same shape as the hail
   comparator, so a collision can never be decided by arrival order. */
export function preferredReport(a, b) {
  if (!b) return true;
  if (a.lon !== b.lon) return a.lon < b.lon;
  if (a.lat !== b.lat) return a.lat < b.lat;
  return a.src < b.src;
}

/* ---- swath geometry -------------------------------------------------------

   A detection is not a point: it stands for a ~5.5 x 4.6 km cell. These build
   the union of those cells as polygons, so the map can draw what the radar
   actually covered instead of a 12px dot in the middle of it.

   Lives here rather than in the page so the browser and any offline analysis
   run the same implementation. */

/* Fill single-cell gaps only.

   Two cells with one empty cell between them are almost certainly one storm
   with a sampling hole. Two empty cells means the radar saw nothing there, and
   joining across that would be drawing weather that was not observed. */
export function bridgeGaps(keys) {
  const set = new Set(keys.map(([by, bx]) => by + "," + bx));
  const added = [];
  const candidates = new Set();
  for (const k of set) {
    const [by, bx] = k.split(",").map(Number);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dy && !dx) continue;
        const n = by + dy + "," + (bx + dx);
        if (!set.has(n)) candidates.add(n);
      }
    }
  }
  for (const k of candidates) {
    const [by, bx] = k.split(",").map(Number);
    /* occupied on both sides of this gap, in any of the four axes */
    const pairs = [[[-1,0],[1,0]], [[0,-1],[0,1]], [[-1,-1],[1,1]], [[-1,1],[1,-1]]];
    const bridges = pairs.some(([a, b]) =>
      set.has(by + a[0] + "," + (bx + a[1])) && set.has(by + b[0] + "," + (bx + b[1])));
    if (bridges) added.push([by, bx]);
  }
  return { cells: [...keys, ...added], bridged: added.length };
}

/* Union of grid cells as GeoJSON rings.

   Every cell contributes four directed edges wound counter-clockwise. An edge
   shared by two occupied cells appears twice in opposite directions and
   cancels, so what remains is exactly the boundary — outer rings wound one
   way, holes the other. No geometry library, and no approximation. */
export function cellsToRings(cells, grid) {
  const half = grid / 2;
  const corner = (by, bx, dy, dx) =>
    [((bx + dx * 0.5) * grid).toFixed(6) + "," + ((by + dy * 0.5) * grid).toFixed(6)];
  const edges = new Map();
  const addEdge = (a, b) => {
    const back = b + "|" + a;
    if (edges.has(back)) edges.delete(back);
    else edges.set(a + "|" + b, [a, b]);
  };
  for (const [by, bx] of cells) {
    const sw = corner(by, bx, -1, -1)[0], se = corner(by, bx, -1, 1)[0];
    const ne = corner(by, bx, 1, 1)[0], nw = corner(by, bx, 1, -1)[0];
    addEdge(sw, se); addEdge(se, ne); addEdge(ne, nw); addEdge(nw, sw);
  }
  const next = new Map();
  for (const [a, b] of edges.values()) {
    if (!next.has(a)) next.set(a, []);
    next.get(a).push(b);
  }
  const rings = [];
  while (next.size) {
    const start = next.keys().next().value;
    const ring = [start];
    let cur = start;
    for (;;) {
      const outs = next.get(cur);
      if (!outs || !outs.length) break;
      const nxt = outs.pop();
      if (!outs.length) next.delete(cur);
      ring.push(nxt);
      cur = nxt;
      if (cur === start) break;
    }
    if (ring.length > 3) rings.push(ring.map((p) => p.split(",").map(Number)));
  }
  return rings;
}

/* Corner cutting, capped so the outline never wanders far from the real cell
   edges. Chaikin at t=0.22 moves a vertex at most ~22% of the shorter adjacent
   edge, which on a 0.05 degree cell is under a kilometre. */
export function smoothRing(ring, iterations = 2, t = 0.22) {
  let pts = ring.slice(0, -1);
  for (let i = 0; i < iterations; i++) {
    const out = [];
    for (let j = 0; j < pts.length; j++) {
      const a = pts[j], b = pts[(j + 1) % pts.length];
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      out.push([a[0] + (b[0] - a[0]) * (1 - t), a[1] + (b[1] - a[1]) * (1 - t)]);
    }
    pts = out;
  }
  pts.push(pts[0]);
  return pts;
}

/* Signed area, for telling outer rings from holes. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

/* ---- morphological shaping -------------------------------------------------

   Unioned grid cells are rectilinear by nature: right angles, T-junctions and
   square notches where arms meet. A hail swath has none of those. Rasterising
   onto a sub-grid and applying a disc-shaped close-then-open rounds the
   outline, fills concave junctions and tapers isolated tips, all before any
   curve fitting.

   The closing radius is deliberately half a cell, so it bridges a one-cell gap
   and nothing wider — the same rule bridgeGaps applied explicitly, now implicit
   in the shape itself. */
export const SUBGRID = 6;              // sub-cells per cell edge (~0.93km each)
export const CLOSE_R = 3;              // half a cell: bridges 1-cell gaps only
export const OPEN_R = 2;               // rounds tips and trims spurs

function discOffsets(r) {
  const out = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r * r + 0.5) out.push([dy, dx]);
  return out;
}

function dilate(set, r) {
  const out = new Set();
  for (const k of set) {
    const [y, x] = k.split(",").map(Number);
    for (const [dy, dx] of discOffsets(r)) out.add(y + dy + "," + (x + dx));
  }
  return out;
}

function erode(set, r) {
  const disc = discOffsets(r);
  const out = new Set();
  for (const k of set) {
    const [y, x] = k.split(",").map(Number);
    let keep = true;
    for (const [dy, dx] of disc) {
      if (!set.has(y + dy + "," + (x + dx))) { keep = false; break; }
    }
    if (keep) out.add(k);
  }
  return out;
}

/* Cells -> sub-grid keys, shaped. */
export function shapeCells(cells) {
  let set = new Set();
  for (const [by, bx] of cells) {
    const y0 = by * SUBGRID, x0 = bx * SUBGRID;
    for (let dy = -Math.floor(SUBGRID / 2); dy <= Math.floor(SUBGRID / 2); dy++)
      for (let dx = -Math.floor(SUBGRID / 2); dx <= Math.floor(SUBGRID / 2); dx++)
        set.add(y0 + dy + "," + (x0 + dx));
  }
  const before = set.size;
  set = erode(dilate(set, CLOSE_R), CLOSE_R);   // close: fill notches, bridge one-cell gaps
  set = dilate(erode(set, OPEN_R), OPEN_R);     // open: round tips, taper extremities
  return {
    keys: [...set].map((k) => k.split(",").map(Number)),
    grid: GRID_DEG / SUBGRID,
    grew: set.size - before,
  };
}

/* ---------------------------------------------------------------------------
   Fitted envelopes.

   The cell-union renderer drew exactly what the grid held: axis-aligned
   rectangles welded together, with notches, T-junctions and right-angle spurs.
   Smoothing that outline only rounded the staircase; it still read as plumbing.

   These functions fit an interpreted shape instead — an elongated swath along
   the storm's principal axis, tapering to points at both ends. It is a
   depiction, not a measurement, and it is only ever used for the map. The
   panel's in-cell determination still comes from the exact bucket indices and
   is untouched by anything below.
   ------------------------------------------------------------------------- */

/* Local equirectangular frame, kilometres, centred on (lon0, lat0). Over a
   25km query radius the distortion is far below the width of a drawn edge. */
export function kmFrame(lon0, lat0) {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.574;
  return {
    fwd: (p) => [(p[0] - lon0) * kx, (p[1] - lat0) * ky],
    inv: (q) => [lon0 + q[0] / kx, lat0 + q[1] / ky],
  };
}

/* Single-linkage clustering. Two points join when they are within linkKm of
   each other, transitively — so a chain of cells stays one storm, and a
   detection 40km away becomes its own. */
export function cluster(pts, linkKm) {
  const parent = pts.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
      if (Math.hypot(dx, dy) <= linkKm) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
  }
  const groups = new Map();
  for (let i = 0; i < pts.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  /* Sorted so output order never depends on Map insertion order. */
  return [...groups.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
}

/* Principal axis of a point set, as a unit vector. Two points define a line;
   one point has no axis of its own and inherits the caller's fallback. */
export function principalAxis(pts, fallback) {
  if (pts.length < 2) return fallback || [1, 0];
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p[0] - mx, dy = p[1] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  /* Largest-eigenvalue eigenvector of the 2x2 covariance. */
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let vx, vy;
  if (Math.abs(sxy) > 1e-12) { vx = l1 - syy; vy = sxy; }
  else if (sxx >= syy) { vx = 1; vy = 0; }
  else { vx = 0; vy = 1; }
  const m = Math.hypot(vx, vy) || 1;
  if (Math.abs(m) < 1e-12) return fallback || [1, 0];
  return [vx / m, vy / m];
}

export const ENV_SAMPLES = 160;   // profile samples along the axis
export const DENSITY_BONUS = 0.25; // widest where the cells are densest

/* Fit nested envelopes for one cluster.

   `pts` are [u,v] already projected into the cluster's axis frame; `vals` is
   the parallel array of sizes; `bands` the thresholds, ascending.

   Each point contributes an elliptical cap of along-axis reach L and
   perpendicular half-reach W, offset by that point's own perpendicular
   position. The band profile is the upper envelope of those caps, so it is
   widest where points sit far off-axis or crowd together, and falls to zero a
   distance L past the last point — the taper.

   Returns one profile per band, on a shared sample grid, already forced to
   nest. */
export function fitProfiles(pts, vals, bands, L, W) {
  let uMin = Infinity, uMax = -Infinity;
  for (const p of pts) { if (p[0] < uMin) uMin = p[0]; if (p[0] > uMax) uMax = p[0]; }
  const lo = uMin - L, hi = uMax + L;
  const us = [];
  for (let i = 0; i < ENV_SAMPLES; i++) us.push(lo + ((hi - lo) * i) / (ENV_SAMPLES - 1));

  const raw = [];
  /* Each band is hulled over its own support, never the cluster's. A band
     with one cell has a narrow bump sitting in a profile that is zero out at
     the cluster's extremes; hulling that across the full range turns the bump
     into a triangle spanning the whole storm, and every band ends up the same
     size. Bounding the hull is what makes the nesting visible. */
  const supports = bands.map((min) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (vals[i] < min) continue;
      if (pts[i][0] < lo) lo = pts[i][0];
      if (pts[i][0] > hi) hi = pts[i][0];
    }
    return lo === Infinity ? null : [lo - L, hi + L];
  });

  const profiles = bands.map((min) => {
    const idx = [];
    for (let i = 0; i < pts.length; i++) if (vals[i] >= min) idx.push(i);
    if (!idx.length) return null;
    /* Density is counted per sample against this band's own peak, so the
       bonus is a shape cue, never an unbounded inflation. */
    const counts = us.map((u) => idx.reduce((n, i) => n + (Math.abs(u - pts[i][0]) < L / 2 ? 1 : 0), 0));
    const peak = Math.max(...counts, 1);
    return us.map((u, s) => {
      let w = 0;
      for (const i of idx) {
        const d = (u - pts[i][0]) / L;
        if (Math.abs(d) >= 1) continue;
        const cap = Math.sqrt(1 - d * d) * (Math.abs(pts[i][1]) + W);
        if (cap > w) w = cap;
      }
      return w * (1 + DENSITY_BONUS * (counts[s] / peak));
    });
  });
  profiles.forEach((p) => raw.push(p ? p.slice() : null));

  /* Two guarantees, in one pass from the top band down.

     Concavity: the region {|v| <= w(u)} is convex exactly when w is concave,
     so taking the profile's upper concave hull is what makes each band a
     single smooth lens — no concave junction, no branch, nothing to read as a
     grid artefact. The hull only ever raises w, so containment survives it.

     Nesting: higher-threshold point sets are subsets, so their caps are
     already bounded by the lower band's — but the density bonus is computed
     per band and can invert that. Taking the running maximum before hulling
     makes containment of the inner band structural rather than assumed. */
  for (let b = bands.length - 1; b >= 0; b--) {
    if (!profiles[b]) continue;
    const inner = profiles[b + 1];
    if (inner) for (let s = 0; s < ENV_SAMPLES; s++) {
      if (inner[s] > profiles[b][s]) profiles[b][s] = inner[s];
    }
    profiles[b] = roundProfile(us, concaveProfile(us, profiles[b], supports[b]), supports[b]);
  }
  return { us, profiles, raw: raw };
}

/* Upper concave hull of a width profile, by monotone chain. */
export function concaveProfile(us, w, support) {
  const lo = support ? support[0] : -Infinity;
  const hi = support ? support[1] : Infinity;
  const hull = [];
  for (let i = 0; i < us.length; i++) {
    if (us[i] < lo || us[i] > hi) continue;
    const p = [us[i], w[i]];
    while (hull.length >= 2) {
      const a = hull[hull.length - 2], b = hull[hull.length - 1];
      const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (cross >= 0) hull.pop(); else break;
    }
    hull.push(p);
  }
  const out = new Array(us.length);
  let h = 0;
  for (let i = 0; i < us.length; i++) {
    if (us[i] < lo || us[i] > hi || hull.length < 2) { out[i] = 0; continue; }
    while (h + 2 < hull.length && hull[h + 1][0] < us[i]) h++;
    const a = hull[h], b = hull[h + 1] || a;
    const t = b[0] === a[0] ? 0 : (us[i] - a[0]) / (b[0] - a[0]);
    out[i] = Math.max(0, a[1] + (b[1] - a[1]) * t);
  }
  return out;
}

/* Where a cluster's profile has a deep interior valley, it wants to be two
   lozenges rather than one fat lens. Returns the along-axis position to cut
   at, or null. The caller re-fits each side from scratch, axis included. */
export const VALLEY_FRAC = 0.55;
export function valleyCut(us, w) {
  let peak = 0;
  for (const v of w) if (v > peak) peak = v;
  if (peak <= 0) return null;
  let best = null;
  for (let i = 1; i < w.length - 1; i++) {
    if (w[i] > w[i - 1] || w[i] > w[i + 1]) continue;
    let l = 0, r = 0;
    for (let j = 0; j < i; j++) if (w[j] > l) l = w[j];
    for (let j = i + 1; j < w.length; j++) if (w[j] > r) r = w[j];
    const shoulder = Math.min(l, r);
    if (shoulder <= 0 || w[i] > VALLEY_FRAC * shoulder) continue;
    const depth = shoulder - w[i];
    if (!best || depth > best.depth) best = { depth: depth, u: us[i] };
  }
  return best ? best.u : null;
}

/* A profile becomes a closed ring: out along the +v side, back along -v.
   Zero-width samples at the ends collapse to the single taper point. */
export function profileToRing(us, w) {
  const top = [], bot = [];
  for (let i = 0; i < us.length; i++) {
    if (w[i] <= 0) continue;
    top.push([us[i], w[i]]);
    bot.push([us[i], -w[i]]);
  }
  if (top.length < 2) return null;
  const ring = [];
  const first = top[0][0], last = top[top.length - 1][0];
  ring.push([first - 0.001, 0]);          // leading point
  for (const p of top) ring.push(p);
  ring.push([last + 0.001, 0]);           // trailing point
  for (let i = bot.length - 1; i >= 0; i--) ring.push(bot[i]);
  ring.push(ring[0].slice());
  return ring;
}

/* The page and the verifier must fit identical shapes, so the fitter lives
   here and neither owns a copy. */
export const ENV_SMOOTH = 2;
export const MAX_SPLIT_DEPTH = 2;

/* Fit one tapering envelope per cluster per band.

   `pts` are [lon, lat]; `vals` the value each point is thresholded on. The
   shape is an interpretation of where the storm was, not a measurement of
   it — the exact grid is still what the panel answers from.

   Bands are emitted lowest-first across all clusters, so a neighbouring
   cluster's core can never paint under its own outer band. */
export function fitEnvelopes(pts, vals, bands, L, W, linkKm) {
    if (!pts.length) return { type: "FeatureCollection", features: [] };

  var lon0 = 0, lat0 = 0;
  pts.forEach(function (p) { lon0 += p[0]; lat0 += p[1]; });
  var frame = kmFrame(lon0 / pts.length, lat0 / pts.length);
  var xy = pts.map(frame.fwd);

  var fits = [];
  cluster(xy, linkKm).forEach(function (idx) { fitGroup(idx, 0); });

  /* One lens per group. Where the profile has a deep interior valley the
     group wants to be two lozenges instead of one fat lens, so it is cut
     and each half re-fitted from scratch — its own axis, its own taper.
     That is what keeps a branch from ever being drawn: the shape is convex
     by construction, and anything that would have branched is split. */
  function fitGroup(idx, depth) {
    var cpts = idx.map(function (i) { return xy[i]; });
    var cvals = idx.map(function (i) { return vals[i]; });
    /* One point has no axis of its own. East-west is the honest default:
       storms here track roughly with the westerlies, and it keeps a lone
       detection a lozenge rather than a circle. */
    var axis = principalAxis(cpts, [1, 0]);
    var cx = 0, cy = 0;
    cpts.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= cpts.length; cy /= cpts.length;
    var uv = cpts.map(function (p) {
      var dx = p[0] - cx, dy = p[1] - cy;
      return [dx * axis[0] + dy * axis[1], -dx * axis[1] + dy * axis[0]];
    });
    var fit = fitProfiles(uv, cvals, bands, L, W);

    if (depth < MAX_SPLIT_DEPTH) {
      var lowest = null;
      for (var b = 0; b < bands.length && !lowest; b++) lowest = fit.raw[b];
      var cut = lowest ? valleyCut(fit.us, lowest) : null;
      if (cut !== null) {
        var left = [], right = [];
        idx.forEach(function (i, k) { (uv[k][0] < cut ? left : right).push(i); });
        if (left.length && right.length) {
          fitGroup(left, depth + 1);
          fitGroup(right, depth + 1);
          return;
        }
      }
    }

    fit.toLngLat = function (q) {
      return frame.inv([
        cx + q[0] * axis[0] - q[1] * axis[1],
        cy + q[0] * axis[1] + q[1] * axis[0],
      ]);
    };
    fits.push(fit);
  }

  var feats = [];
  bands.forEach(function (min, bi) {
    fits.forEach(function (fit) {
      var prof = fit.profiles[bi];
      if (!prof) return;
      var ring = profileToRing(fit.us, prof);
      if (!ring) return;
      const smoothed = smoothRing(ring, ENV_SMOOTH, 0.25).map(fit.toLngLat);
      feats.push({
        type: "Feature",
        properties: { min: min },
        geometry: {
          type: "Polygon",
          /* Simplified here, once, so the page and the email render identical
             geometry. See SIMPLIFY_M. */
          coordinates: [simplifyRing(smoothed, SIMPLIFY_M, smoothed[0][1])],
        },
      });
    });
  });
  return { type: "FeatureCollection", features: feats };
}


/* The concave hull is piecewise linear, so a band resting on two hull vertices
   is drawn with a dead-straight side — visible on any band fitted to few
   cells, and the one thing a "smooth lens" must not have.

   Averaging does not fix this. Convolution preserves linear functions, so
   smoothing a piecewise-linear hull rounds its corners and leaves the long
   sides exactly as straight as they were; it also sagged the taper tips into
   reflex vertices. Curvature has to come from a curved function, so the hull
   is blended with the ellipse spanning the same support.

   Both are concave, so any convex combination is concave and the lens stays
   convex. The ellipse is curved everywhere, so nothing in the result is
   straight. */
export const ELLIPSE_BLEND = 0.55;
export function roundProfile(us, w, support) {
  if (!support) return w;
  const [lo, hi] = support;
  const uc = (lo + hi) / 2, H = (hi - lo) / 2;
  if (H <= 0) return w;
  let peak = 0;
  for (const v of w) if (v > peak) peak = v;
  const out = new Array(us.length).fill(0);
  for (let i = 0; i < us.length; i++) {
    if (us[i] < lo || us[i] > hi) continue;
    const t = (us[i] - uc) / H;
    const ell = peak * Math.sqrt(Math.max(0, 1 - t * t));
    out[i] = (1 - ELLIPSE_BLEND) * w[i] + ELLIPSE_BLEND * ell;
  }
  return out;
}

/* Douglas-Peucker, tolerance in metres.

   Chaikin generates far more vertices than the curve needs — a lens carries
   ~1,300 where ~110 describe it to within a metre. That redundancy is free on
   the page and fatal in a URL: the Static Images API caps the request at 8,192
   characters, and the full-resolution overlay for one day runs to 306,000 as
   GeoJSON or 44,000 as an encoded polyline.

   Applied here, inside fitEnvelopes, so the page and the notification function
   render the same shape from the same call. Simplifying only for the email
   would put a different swath in David's inbox than the homeowner saw, which
   is worse than sending no picture at all.

   40m is chosen against the archive's worst day, not against a convenient one:
   at 10m Tupelo fits comfortably and the worst day needs 11,618 characters,
   and 20m misses the cap by 13. At 40m the worst day is 6,357 with 1,835 to
   spare. The cost is 0.32px of deviation at zoom 10 and 0.63px at zoom 11,
   which is the page's clamped maximum — sub-pixel everywhere it can be seen. */
export const SIMPLIFY_M = 40;

export function simplifyRing(ring, tolM, lat) {
  if (ring.length < 4) return ring;
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110574;
  const P = ring.map((p) => [p[0] * kx, p[1] * ky]);
  const keep = new Array(P.length).fill(false);
  keep[0] = keep[P.length - 1] = true;

  /* Iterative, not recursive: a 1,300-vertex ring at a small tolerance can
     nest deeply enough to matter, and this runs inside a lead pipeline. */
  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e <= s + 1) continue;
    const a = P[s], b = P[e];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    let max = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const q = P[i];
      const d = L < 1e-9
        ? Math.hypot(q[0] - a[0], q[1] - a[1])
        : Math.abs(dx * (a[1] - q[1]) - (a[0] - q[0]) * dy) / L;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tolM && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  /* A ring that collapses below a triangle is not a shape any more. */
  return out.length >= 4 ? out : ring;
}
