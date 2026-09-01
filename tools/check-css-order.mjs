/* Media-query rules beaten by later base rules.

   A media query adds no specificity. So a rule inside `@media (min-width: X)`
   and a base rule outside it, both at one class, are a tie — and a tie is
   settled by source order. In this stylesheet the media queries are
   interleaved with the base rules rather than gathered at the end: 33 separate
   runs, every one of them with base rules after it. That means an override
   written inside a media query can silently do nothing.

   It has happened four times here — .hero-tagline-scrim stayed pinned to the
   left edge, .hero-panel-inner widened the copy column and rewrapped the H1,
   .hero-logo kept a 48px margin, and .services h2 rendered navy on navy. Each
   was caught by measuring pixels afterwards, never by reading the file.

   Two forms are reported, both fatal:

     BROKEN  the later base rule sets the same property, so the media rule is
             already dead and the page is rendering the wrong value now.
     LATENT  the selector and specificity collide but the properties do not
             overlap yet. Nothing is wrong on screen; it breaks the next time
             anyone adds that property to the base rule.

   The fix is always the same: qualify the media-query selector so it wins on
   specificity rather than position — `.hero .hero-media`, not `.hero-media`. */

import fs from "node:fs";
import path from "node:path";

const FILE = process.argv[2] || "styles.css";

/* Every class attribute in the source HTML, as one Set per element. The
   modifier check below needs to know which classes genuinely land on the same
   element — inferring it from names (".contact-alt looks like a modifier of
   .contact") would be guesswork, and would miss any pair that does not share a
   prefix. */
function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "dist" || e.name === "node_modules" || e.name.startsWith(".")) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) htmlFiles(f, out);
    else if (e.name.endsWith(".html")) out.push(f);
  }
  return out;
}
const elements = [];
for (const f of htmlFiles(".")) {
  const html = fs.readFileSync(f, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    elements.push(new Set(m[1].trim().split(/\s+/)));
  }
}
const src = fs.readFileSync(FILE, "utf8");

/* Blank comments out but keep every newline, so reported line numbers are the
   real ones in the file. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
  m.replace(/[^\n]/g, " ")
);

const rules = [];
const stack = [];
let buf = "";
let line = 1;

for (let i = 0; i < code.length; i++) {
  const ch = code[i];
  if (ch === "\n") line++;
  if (ch === "{") {
    stack.push({ head: buf.trim().replace(/\s+/g, " "), start: line, from: i + 1 });
    buf = "";
  } else if (ch === "}") {
    const frame = stack.pop();
    if (frame && !frame.head.startsWith("@")) {
      const media = stack.find((f) => f.head.startsWith("@media"));
      const decls = new Map();
      for (const part of code.slice(frame.from, i).split(";")) {
        if (part.includes("{") || part.includes("}")) continue;
        const c = part.indexOf(":");
        if (c < 0) continue;
        const prop = part.slice(0, c).trim();
        /* Custom properties cascade the same way but are rarely the trap, and
           including them buries the real hits. */
        if (!prop || prop.startsWith("--")) continue;
        decls.set(prop, part.slice(c + 1).trim().replace(/\s+/g, " "));
      }
      if (decls.size) {
        rules.push({
          start: frame.start,
          selectors: frame.head.split(",").map((s) => s.trim()).filter(Boolean),
          media: media ? media.head : null,
          decls,
        });
      }
    }
    buf = "";
  } else {
    buf += ch;
  }
}

/* Specificity as (id, class, type). Good enough for a tie test: the trap is
   always two selectors that are literally identical, so this only has to be
   consistent, not perfect on exotic selectors. */
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes =
    (sel.match(/\.[\w-]+/g) || []).length +
    (sel.match(/\[[^\]]+\]/g) || []).length +
    (sel.match(/:(?!:)[\w-]+/g) || []).length;
  const types =
    (sel.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g) || []).length +
    (sel.match(/::[\w-]+/g) || []).length;
  return `${ids},${classes},${types}`;
}

const base = rules.filter((r) => r.media === null);
const broken = [];
const latent = [];

for (const rule of rules) {
  if (!rule.media) continue;
  for (const sel of rule.selectors) {
    const spec = specificity(sel);
    for (const other of base) {
      if (other.start <= rule.start) continue;
      if (!other.selectors.includes(sel)) continue;
      if (specificity(sel) !== spec) continue;
      const clashing = [...rule.decls.keys()].filter((p) => other.decls.has(p));
      const hit = {
        sel,
        mediaLine: rule.start,
        media: rule.media,
        baseLine: other.start,
        props: clashing,
      };
      if (clashing.length) broken.push(hit);
      else latent.push(hit);
    }
  }
}

/* ---- second form: a narrow modifier beaten by a broader base rule --------
   .contact-alt at L2438 and .contact at L2440 are both one class, so they tie
   on specificity and the later one wins. The homepage section carries both, so
   the modifier silently did nothing and the section stayed white.

   Detected without reading names: a rule is at risk when the set of real
   elements it matches is a STRICT SUBSET of a later rule's, at equal
   specificity. The narrow rule is then always overridable by the broad one,
   which is the wrong way round — a modifier exists precisely to win. Compound
   selectors like `.contact.contact-alt` raise specificity and drop out of the
   comparison, which is why qualifying is the fix. */
function compound(sel) {
  /* only single compound selectors — no descendants, no combinators. The trap
     lives here and anything looser produces noise. */
  if (/[ >+~]/.test(sel.trim())) return null;
  const classes = [...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (!classes.length) return null;
  if (/[#\[:]/.test(sel)) return null;
  return classes;
}
const matchSets = new Map();
for (const rule of base) {
  for (const sel of rule.selectors) {
    const cls = compound(sel);
    if (!cls) continue;
    const hits = new Set();
    elements.forEach((set, i) => {
      if (cls.every((c) => set.has(c))) hits.add(i);
    });
    if (hits.size) matchSets.set(rule.start + "|" + sel, { rule, sel, hits });
  }
}
const entries = [...matchSets.values()];
for (const a of entries) {
  for (const b of entries) {
    if (b.rule.start <= a.rule.start) continue;
    if (specificity(a.sel) !== specificity(b.sel)) continue;
    if (a.hits.size >= b.hits.size) continue;
    let subset = true;
    for (const h of a.hits) if (!b.hits.has(h)) { subset = false; break; }
    if (!subset) continue;
    const clashing = [...a.rule.decls.keys()].filter((p) => b.rule.decls.has(p));
    const hit = { sel: a.sel, mediaLine: a.rule.start, media: `beaten by the broader ${b.sel}`,
                  baseLine: b.rule.start, props: clashing, modifier: true, broader: b.sel };
    if (clashing.length) broken.push(hit); else latent.push(hit);
  }
}

if (broken.length || latent.length) {
  console.error(`  BUILD FAILED: ${FILE} has rules a later rule can beat on source order.`);
  console.error(`  Two forms: a media-query rule (a media query adds no specificity), and a`);
  console.error(`  narrow modifier class matched by a broader base rule at equal specificity.\n`);
  for (const h of broken) {
    console.error(`  BROKEN  ${h.sel}`);
    console.error(`          ${h.modifier ? "modifier " : "media rule"} L${h.mediaLine}  ${h.media}`);
    console.error(`          base rule  L${h.baseLine}  <-- THIS ONE WINS`);
    console.error(`          dead properties: ${h.props.join(", ")}`);
    console.error(`          fix: ${h.modifier ? `qualify it, e.g. "${h.broader}${h.sel}"` : `qualify the media-query selector, e.g. ".hero ${h.sel}"`}\n`);
  }
  for (const h of latent) {
    console.error(`  LATENT  ${h.sel}`);
    console.error(`          ${h.modifier ? "modifier " : "media rule"} L${h.mediaLine}  ${h.media}`);
    console.error(`          base rule  L${h.baseLine}  (no shared property yet — the media rule still wins)`);
    console.error(`          breaks as soon as the base rule sets any of: ${[...rules.find(r=>r.start===h.mediaLine).decls.keys()].join(", ")}`);
    console.error(`          fix: ${h.modifier ? `qualify it, e.g. "${h.broader}${h.sel}"` : `qualify the media-query selector, e.g. ".hero ${h.sel}"`}\n`);
  }
  process.exit(1);
}

console.log(
  `  css order: ${rules.length} rules checked, ` +
    `${rules.length - base.length} inside media queries, no later base rule can beat them`
);
