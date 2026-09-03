/* Storm-history lead notification.

   Netlify's built-in form notification stays enabled and is deliberately not
   replaced by this. It sends a plain email listing the submitted fields, and
   it is the floor: if this function is broken, unbundled, out of API credit,
   or never fires at all, David still learns about every lead. This adds a
   second, better email on top. Two emails beats zero.

   The second rule follows from the first: nothing in here may abort the send.
   The geocode can fail, the archive fetch can 404, Mapbox can rate-limit,
   the PNG can come back as an error page — every one of those degrades to
   "send the email without the picture". The image is the nice-to-have. The
   lead is the point. */

import { GRID_DEG, fitEnvelopes } from "../../tools/storm-grid.mjs";

const HAIL_BANDS = [1.0, 1.5, 1.75, 2.0, 2.5];
const HAIL_W = 4.2, HAIL_L = 11, HAIL_LINK_KM = 8, STORM_KM = 25;
const AREA = { minLon: -91.0, minLat: 33.9, maxLon: -88.4, maxLat: 35.05 };
const TUPELO = [-88.7034, 34.2576];

/* Same ramp as the map, so the picture in the inbox matches the page. */
const BAND_FILL = {
  1.0: "cdb6ee", 1.5: "b189e6", 1.75: "9a63dd", 2.0: "8340d2", 2.5: "6b21c0",
};

const log = (stage, detail) =>
  console.log(JSON.stringify({ fn: "submission-created", stage, ...detail }));
const warn = (stage, err, detail = {}) =>
  console.warn(JSON.stringify({
    fn: "submission-created", stage, degraded: true,
    error: err && err.message ? err.message : String(err), ...detail,
  }));

function distanceKm(aLon, aLat, bLon, bLat) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Exported for testing: the visual check must exercise the shipped path,
   not a copy of it that can drift.

   Google encoded polyline, precision 5. The Static Images API caps the whole
   request at 8,192 characters; the same rings as GeoJSON run to six figures. */
export function encodePolyline(pts) {
  let out = "", plat = 0, plon = 0;
  const chunk = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of pts) {
    const la = Math.round(p[1] * 1e5), lo = Math.round(p[0] * 1e5);
    out += chunk(la - plat) + chunk(lo - plon);
    plat = la; plon = lo;
  }
  return out;
}

export async function geocode(address, token) {
  const url = "https://api.mapbox.com/search/geocode/v6/forward?q=" +
    encodeURIComponent(address) +
    "&country=us&types=address&limit=1&autocomplete=false" +
    "&proximity=" + TUPELO.join(",") +
    "&access_token=" + token;
  const r = await fetch(url);
  if (!r.ok) throw new Error("geocode HTTP " + r.status);
  const f = (await r.json())?.features?.[0];
  if (!f) throw new Error("address did not resolve");
  const c = f.properties.coordinates;
  return { lon: c.longitude, lat: c.latitude };
}

export async function stormImage({ lon, lat, date, token, siteUrl }) {
  const year = date.slice(0, 4);
  const r = await fetch(`${siteUrl}/data/hail-${year}.json`);
  if (!r.ok) throw new Error(`archive HTTP ${r.status} for ${year}`);
  const cells = (await r.json()).cells.filter(
    (c) => c[0] === date && distanceKm(lon, lat, c[2], c[3]) <= STORM_KM
  );
  if (!cells.length) throw new Error("no cells on " + date);

  /* Cell centres and the shared fitter — identical geometry to the page,
     simplification included. */
  const fc = fitEnvelopes(
    cells.map((c) => [c[6] * GRID_DEG, c[5] * GRID_DEG]),
    cells.map((c) => c[1]),
    HAIL_BANDS, HAIL_L, HAIL_W, HAIL_LINK_KM
  );

  /* Lowest band first so the deeper cores paint over it, matching the map. */
  const paths = fc.features
    .map((f) => {
      const fill = BAND_FILL[f.properties.min] || "8340d2";
      return `path-2+ffffff-0.9+${fill}-0.45(${encodeURIComponent(
        encodePolyline(f.geometry.coordinates[0])
      )})`;
    })
    .join(",");
  const pin = `pin-s+ffffff(${lon.toFixed(5)},${lat.toFixed(5)})`;
  /* satellite-streets-v12, not the standard-satellite the page uses. The
     Static Images API renders classic styles; asked for standard-satellite it
     returns the overlay on a black field with no imagery at all, because the
     v3 basemap does not render in that pipeline.

     This is a difference of basemap, not of geometry. The rings come from the
     same fitEnvelopes call with the same 40m simplification, so the swath in
     David's inbox is the swath on the homeowner's screen; only the imagery
     underneath is drawn by a different renderer. */
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/` +
    `${paths},${pin}/auto/640x420@2x?padding=40&access_token=${token}`;

  if (url.length > 8192) throw new Error(`overlay URL ${url.length} chars, over the 8192 cap`);

  const img = await fetch(url);
  if (!img.ok) throw new Error("static image HTTP " + img.status);
  const type = img.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error("static image returned " + type);
  const buf = Buffer.from(await img.arrayBuffer());
  return { buf, bands: fc.features.length, urlLen: url.length };
}

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function sendEmail({ data, image, note }) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_EMAIL_TO;
  const from = process.env.LEAD_EMAIL_FROM;
  if (!key || !to || !from) throw new Error("RESEND_API_KEY, LEAD_EMAIL_TO or LEAD_EMAIL_FROM not set");

  const rows = [
    ["Address", data.address],
    ["Name", data.name],
    ["Phone", data.phone],
    ["Email", data.email],
    ["Page", data.page],
    ["Notes", data.message],
  ].filter(([, v]) => v);

  const html =
    `<h2 style="font:600 18px system-ui;margin:0 0 12px">New storm history lead</h2>` +
    `<table style="font:14px system-ui;border-collapse:collapse">` +
    rows.map(([k, v]) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#5b6b7f">${esc(k)}</td>` +
      `<td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`).join("") +
    `</table>` +
    (image
      ? `<p style="font:14px system-ui;margin:16px 0 4px">Hail on ${esc(data.storm_date)} — attached.</p>`
      : `<p style="font:14px system-ui;margin:16px 0 4px;color:#8a5a00">` +
        `No storm image on this one${note ? ` (${esc(note)})` : ""}. ` +
        `Open the storm history page for the full picture.</p>`);

  const body = {
    from, to: [to], subject: `Storm lead — ${data.address || "no address"}`, html,
  };
  if (image) {
    body.attachments = [{
      filename: `storm-${data.storm_date}.png`,
      content: image.buf.toString("base64"),
    }];
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`resend HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json())?.id;
}

/* Legacy filename dispatch: Netlify subscribes this function to the event by
   matching the file name, so it MUST stay `submission-created`.

   The typed-handler form — any filename, `export default { formSubmitted }` —
   is what the current docs recommend, and it deployed cleanly and was never
   invoked once. Netlify's own blog says "simply by naming your function file
   submission-created.js", and @netlify/build still carries 'submission-created'
   in its set of event-triggered function names on main today. `form-submitted`
   exists in no doc, blog or source file; it was an inference from kebab-casing
   the handler name, and acting on it would have failed exactly as silently.

   Only one convention may be live at a time. If this file also exported a
   formSubmitted handler and both dispatchers worked, David would get three
   emails per lead — this one twice, plus the built-in notification. */
export default async (req) => {
  let data = {};
  try {
    const body = await req.json();
    data = body?.payload?.data || {};
  } catch (err) {
    console.error(JSON.stringify({
      fn: "submission-created", stage: "parse", failed: true,
      error: err && err.message ? err.message : String(err),
    }));
    return;
  }
  await handleSubmission(data);
};

async function handleSubmission(data) {
  /* Only storm-history leads carry an address worth drawing. Everything else
     is already covered by the built-in notification, so stay out of its way
     rather than sending a second, emptier copy. */
  if (!data.address) { log("skipped", { reason: "no address field" }); return; }

  const token = process.env.MAPBOX_TOKEN;
  /* Netlify sets URL in the function runtime, so the fallback is only reached
     if that is somehow unset. It still has to be the real domain — the map
     image and the follow-up link in the notification are built from it. */
  const siteUrl = process.env.URL || "https://riseroofingms.com";

  let image = null, note = "";
  try {
    if (!token) throw new Error("MAPBOX_TOKEN not set");
    if (!data.storm_date) throw new Error("no storm_date on submission");
    const { lon, lat } = await geocode(data.address, token);
    if (lon < AREA.minLon || lon > AREA.maxLon || lat < AREA.minLat || lat > AREA.maxLat) {
      throw new Error("address outside the archive bbox");
    }
    image = await stormImage({ lon, lat, date: data.storm_date, token, siteUrl });
    log("image-built", { date: data.storm_date, bands: image.bands, urlLen: image.urlLen });
  } catch (err) {
    /* Degraded, not failed. The email still goes. */
    note = err && err.message ? err.message : String(err);
    warn("image", err, { address: data.address, date: data.storm_date });
  }

  try {
    const id = await sendEmail({ data, image, note });
    log("sent", { id, withImage: !!image, address: data.address });
  } catch (err) {
    /* Last line of defence. Netlify ignores the return value of an event
       function and does not retry, so throwing here would lose the richer
       email silently — the built-in notification is what still saves the
       lead. Logged loudly so it shows up in a log drain. */
    console.error(JSON.stringify({
      fn: "submission-created", stage: "send", failed: true,
      error: err && err.message ? err.message : String(err),
      address: data.address,
    }));
  }
}
