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

const FILE = process.argv[2] || "styles.css";
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

if (broken.length || latent.length) {
  console.error(`  BUILD FAILED: ${FILE} has media-query rules a later base rule can beat.`);
  console.error(`  A media query adds no specificity, so an equal-specificity base rule`);
  console.error(`  further down the file wins on source order.\n`);
  for (const h of broken) {
    console.error(`  BROKEN  ${h.sel}`);
    console.error(`          media rule L${h.mediaLine}  ${h.media}`);
    console.error(`          base rule  L${h.baseLine}  <-- THIS ONE WINS`);
    console.error(`          dead properties: ${h.props.join(", ")}`);
    console.error(`          fix: qualify the media-query selector, e.g. ".hero ${h.sel}"\n`);
  }
  for (const h of latent) {
    console.error(`  LATENT  ${h.sel}`);
    console.error(`          media rule L${h.mediaLine}  ${h.media}`);
    console.error(`          base rule  L${h.baseLine}  (no shared property yet — the media rule still wins)`);
    console.error(`          breaks as soon as the base rule sets any of: ${[...rules.find(r=>r.start===h.mediaLine).decls.keys()].join(", ")}`);
    console.error(`          fix: qualify the media-query selector, e.g. ".hero ${h.sel}"\n`);
  }
  process.exit(1);
}

console.log(
  `  css order: ${rules.length} rules checked, ` +
    `${rules.length - base.length} inside media queries, no later base rule can beat them`
);
