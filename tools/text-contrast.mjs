#!/usr/bin/env node
/* Contrast of text that sits on a photograph.
 *
 * The usual contrast check compares a colour against the nearest opaque
 * background-color. Over an image there is no such colour — the ground changes
 * under every glyph — so that check either skips the element or reports the
 * fallback and calls it a pass. This one samples the actual backing pixels.
 *
 * Two statistics, because they disagree and the disagreement is the useful part:
 *
 *   worst  the single brightest pixel behind the glyph run. Strict, and easily
 *          dominated by one street lamp or window highlight that no reader
 *          would notice.
 *   p90    the 90th-percentile pixel. What the eye actually reads against.
 *
 * A line failing `worst` but comfortable on `p90` usually needs nothing. A line
 * failing `p90` is genuinely hard to read. Reporting only one of them hides a
 * real problem or invents a fake one — on this site the Southaven hero read
 * 2.79 on `worst` and 1.08 on `p90`, and only the second was the truth.
 *
 * Sampling happens in the page via canvas, so any format the browser can decode
 * works and no image decoder is needed here.
 *
 * Overlays: a ::before/::after scrim over the image is composited in. Solid
 * rgba() and two-stop horizontal/vertical linear-gradient() are understood.
 * Anything else is REPORTED AS UNMODELLED rather than ignored — an unmodelled
 * scrim makes every number too pessimistic, and silence about it is how a
 * measurement turns into a wrong fact.
 *
 * Usage:
 *   node tools/text-contrast.mjs <url> <selector> [--widths=1440,390] [--port=9222]
 *
 * Example:
 *   node tools/text-contrast.mjs http://127.0.0.1:8744/roofing-southaven-ms/ \
 *     '.city-hero-content h1 span'
 *
 * Exit code 1 if any line is under its WCAG floor on p90.
 */
import { spawn } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = process.argv.slice(2);
const url = args[0];
const selector = args[1];
if (!url || !selector) {
  console.error("usage: node tools/text-contrast.mjs <url> <selector> [--widths=1440,390]");
  process.exit(2);
}
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const widths = opt("widths", "1440,390").split(",").map(Number);
const port = Number(opt("port", "9455"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_FN = String.raw`(selector) => {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const rgba = (s) => { const n = (s.match(/[\d.]+/g) || []).map(Number);
    return n.length >= 3 ? { c: [n[0], n[1], n[2]], a: n.length > 3 ? n[3] : 1 } : null; };
  const over = (f, b, a) => f.map((v, i) => v * a + b[i] * (1 - a));

  // --- overlay: solid rgba, or a two-stop linear-gradient along one axis.
  // Anything else is handed back unparsed so the caller can say so out loud.
  function overlayOf(el, w, h) {
    for (const pseudo of ["::after", "::before"]) {
      const s = getComputedStyle(el, pseudo);
      if (s.content === "none") continue;
      const img = s.backgroundImage;
      const solid = rgba(s.backgroundColor);
      if (img && img !== "none") {
        const m = img.match(/linear-gradient\(([^]*)\)$/);
        if (!m) return { unmodelled: img.slice(0, 60) };
        const body = m[1];
        const dir = /to right/.test(body) ? "x" : /to bottom/.test(body) ? "y" : null;
        const stops = [...body.matchAll(/rgba?\(([^)]*)\)\s*([\d.]+)%/g)].map((s2) => ({
          c: rgba("rgba(" + s2[1] + ")"), p: parseFloat(s2[2]) / 100 }));
        if (!dir || stops.length !== 2 || stops.some((s2) => !s2.c)) return { unmodelled: img.slice(0, 60) };
        return { dir, stops };
      }
      if (solid && solid.a > 0) return { dir: "flat", stops: [{ c: solid, p: 0 }, { c: solid, p: 1 }] };
    }
    return null;
  }
  const overlayAt = (ov, fx, fy) => {
    if (!ov || ov.unmodelled) return null;
    if (ov.dir === "flat") return ov.stops[0].c;
    const t = ov.dir === "x" ? fx : fy;
    const [a, b] = ov.stops;
    const k = t <= a.p ? 0 : t >= b.p ? 1 : (t - a.p) / (b.p - a.p);
    return { c: a.c.c, a: a.c.a + (b.c.a - a.c.a) * k };
  };

  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;

    // the backing image: nearest ancestor that contains one
    let host = el, img = null;
    while (host && !img) { img = host.querySelector && host.querySelector("img"); host = host.parentElement; }
    if (!img || !img.complete || !img.naturalWidth) { out.push({ err: "no backing <img>", el: el.textContent.trim().slice(0, 24) }); continue; }

    const ir = img.getBoundingClientRect();
    const is = getComputedStyle(img);
    const iw = img.naturalWidth, ih = img.naturalHeight, W = ir.width, H = ir.height;
    let sc;
    if (is.objectFit === "cover") sc = Math.max(W / iw, H / ih);
    else if (is.objectFit === "contain") sc = Math.min(W / iw, H / ih);
    else sc = null;                                   // fill: axes scale independently
    const posM = is.objectPosition.match(/([\d.]+)%\s+([\d.]+)%/);
    const px = posM ? +posM[1] / 100 : 0.5, py = posM ? +posM[2] / 100 : 0.5;
    const ox = sc === null ? 0 : px * (W - iw * sc);
    const oy = sc === null ? 0 : py * (H - ih * sc);

    const cv = document.createElement("canvas");
    cv.width = iw; cv.height = ih;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    let data;
    try { data = ctx.getImageData(0, 0, iw, ih).data; }
    catch (e) { out.push({ err: "canvas tainted (cross-origin image)", el: el.textContent.trim().slice(0, 24) }); continue; }

    const ov = overlayOf(img.parentElement, W, H);

    const fg = rgba(cs.color).c;
    const fs = parseFloat(cs.fontSize), fw = parseInt(cs.fontWeight) || 400;
    const floor = fs >= 24 || (fs >= 18.66 && fw >= 700) ? 3 : 4.5;

    const rg = document.createRange(); rg.selectNodeContents(el);
    for (const b of rg.getClientRects()) {
      if (b.width < 2 || b.height < 2) continue;
      const grounds = [];
      for (let y = Math.ceil(b.top - ir.top); y < b.bottom - ir.top; y++) {
        for (let x = Math.ceil(b.left - ir.left); x < b.right - ir.left; x++) {
          const sx = sc === null ? Math.round(x * iw / W) : Math.round((x - ox) / sc);
          const sy = sc === null ? Math.round(y * ih / H) : Math.round((y - oy) / sc);
          if (sx < 0 || sy < 0 || sx >= iw || sy >= ih) continue;
          const i = (sy * iw + sx) * 4;
          let g = [data[i], data[i + 1], data[i + 2]];
          const o = overlayAt(ov, x / W, y / H);
          if (o) g = over(o.c, g, o.a);
          grounds.push(g);
        }
      }
      if (!grounds.length) continue;
      grounds.sort((p, q) => L(q) - L(p));
      out.push({
        el: el.textContent.trim().slice(0, 28),
        color: cs.color, fs, fw, floor,
        worst: +ratio(fg, grounds[0]).toFixed(2),
        p90: +ratio(fg, grounds[Math.floor(grounds.length * 0.1)]).toFixed(2),
        unmodelled: ov && ov.unmodelled ? ov.unmodelled : null,
      });
    }
  }
  return out;
}`;

const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run",
   "--no-default-browser-check", "--disable-gpu", "about:blank"],
  { stdio: "ignore" }
);
const cleanup = () => { try { chrome.kill(); } catch {} };
process.on("exit", cleanup);

async function cdpJson(path) {
  for (let i = 0; i < 80; i++) {
    try { return await (await fetch(`http://127.0.0.1:${port}${path}`)).json(); }
    catch { await sleep(250); }
  }
  throw new Error("could not reach headless Chrome");
}

const target = (await cdpJson("/json/list")).find((t) => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = (expr) =>
  send("Runtime.evaluate", { returnByValue: true, expression: expr, awaitPromise: true })
    .then((r) => r.result?.result?.value);

await send("Page.enable");
let failures = 0, unmodelledSeen = null;

for (const w of widths) {
  await send("Emulation.setDeviceMetricsOverride",
    { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 800 });
  await send("Page.navigate", { url });
  await sleep(3200);
  const rows = await evaluate(`(${PAGE_FN})(${JSON.stringify(selector)})`);
  console.log(`\n===== ${w}px  ${url}  ${selector}`);
  if (!rows || !rows.length) { console.log("  no matching text found"); continue; }
  console.log("  line                          size  floor    worst      p90   verdict");
  for (const r of rows) {
    if (r.err) { console.log(`  ${r.el.padEnd(30)}  ${r.err}`); failures++; continue; }
    if (r.unmodelled) unmodelledSeen = r.unmodelled;
    const bad = r.p90 < r.floor;
    if (bad) failures++;
    console.log(
      `  ${r.el.padEnd(30)}${String(r.fs).padStart(4)}px${String(r.floor).padStart(6)}` +
      `${String(r.worst).padStart(9)}${String(r.p90).padStart(9)}   ${bad ? "FAIL on p90" : "ok"}`
    );
  }
}
if (unmodelledSeen) {
  console.log(`\n  WARNING: an overlay could not be modelled and was NOT composited in:`);
  console.log(`           ${unmodelledSeen}`);
  console.log(`           Every number above is therefore more pessimistic than the render.`);
}
console.log(`\n${failures ? failures + " line(s) below floor on p90" : "all lines clear their floor on p90"}`);
ws.close(); cleanup();
process.exit(failures ? 1 : 0);
