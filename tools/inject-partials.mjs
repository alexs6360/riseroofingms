/* Build-time partial injection.

   The storm history lookup is the site's strongest lead generator, and it now
   appears on four pages. Four copies of the markup would drift the first time
   one of them was edited — the quote form drifted across six pages twice in a
   day and cost every storm lead its address. So the markup lives in
   partials/, the per-page copy lives here, and pages carry only a marker.

   Runs against dist/, never the source tree: the sources keep the marker so
   the single source stays obvious to whoever edits next. */
import fs from "node:fs";
import path from "node:path";

const MARKER = "<!-- lookup-cta -->";
const partial = fs.readFileSync("partials/lookup-cta.html", "utf8").replace(/\n$/, "");

/* One line of copy per page. City pages name their city: this tool is locally
   specific in a way a generic inspection CTA is not, and that is the whole
   reason it belongs on high-intent local traffic.

   The homepage is deliberately absent. The lookup is its hero now, so a second
   copy of the same control further down the page would compete with it. The
   other four pages are unaffected — this map is what decides, and the build
   fails if a page listed here has lost its marker. */
const LEAD = {
  "storm-damage/index.html":
    "If a storm came through, start by seeing what was actually recorded near " +
    "your address — ten years of hail and wind, before anyone gets on the roof.",
  "roofing-tupelo-ms/index.html":
    "Type a Tupelo address and we'll show you the hail and wind events recorded " +
    "near it over the last ten years.",
  "roofing-oxford-ms/index.html":
    "Type an Oxford address and we'll show you the hail and wind events recorded " +
    "near it over the last ten years.",
  "roofing-southaven-ms/index.html":
    "Type a Southaven address and we'll show you the hail and wind events " +
    "recorded near it over the last ten years.",
};

let injected = 0;
const missing = [];
for (const [rel, lead] of Object.entries(LEAD)) {
  const file = path.join("dist", rel);
  if (!fs.existsSync(file)) { missing.push(rel + " (not in dist)"); continue; }
  const html = fs.readFileSync(file, "utf8");
  if (!html.includes(MARKER)) { missing.push(rel + " (no marker)"); continue; }
  fs.writeFileSync(file, html.replace(MARKER, partial.replace("{{LEAD}}", lead)));
  injected++;
}

if (missing.length) {
  console.error("  BUILD FAILED: lookup-cta could not be injected into:\n    " + missing.join("\n    "));
  process.exit(1);
}
console.log(`  lookup-cta injected into ${injected} pages`);
