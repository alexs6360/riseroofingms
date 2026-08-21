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
  return `${day}|${Math.round(lat / GRID_DEG)}|${Math.round(lon / GRID_DEG)}`;
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
