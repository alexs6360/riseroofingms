/* Incremental and full builds must agree byte for byte.

   If they diverge, every full rebuild rewrites what the incremental runs
   wrote, and the archive churns — a commit and a Netlify deploy each time,
   with no storm behind it. That is the same class of bug as the
   nondeterministic dedupe that used to rewrite eight files every run.

   Runs the full build, snapshots it, restores the pre-existing archive, runs
   an incremental build over it, and diffs. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const OUT = "data";
const SNAP = "/tmp/verify-inc";
const snapshot = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(OUT)) fs.copyFileSync(`${OUT}/${f}`, `${dir}/${f}`);
};
const restore = (dir) => {
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(`${dir}/${f}`, `${OUT}/${f}`);
};

/* Start from the committed archive, not from whatever a previous run left in
   data/. Verifying against a contaminated starting point is how a merge bug
   hides: the run under test inherits the previous run's duplicates. */
console.log("  resetting data/ to the committed state…");
execFileSync("git", ["checkout", "--", OUT], { stdio: "ignore" });
snapshot(`${SNAP}/before`);

console.log("  full build…");
execFileSync("node", ["tools/build-storm-data.mjs", OUT], { stdio: "ignore" });
snapshot(`${SNAP}/full`);

console.log("  restoring, then incremental build…");
restore(`${SNAP}/before`);
execFileSync("node", ["tools/build-storm-data.mjs", OUT], {
  stdio: "ignore",
  env: { ...process.env, WINDOW_MONTHS: process.env.WINDOW_MONTHS || "2" },
});

let same = 0, diff = [];
for (const f of fs.readdirSync(`${SNAP}/full`)) {
  const a = fs.readFileSync(`${SNAP}/full/${f}`);
  const b = fs.existsSync(`${OUT}/${f}`) ? fs.readFileSync(`${OUT}/${f}`) : Buffer.alloc(0);
  if (a.equals(b)) same++;
  else diff.push(f);
}

console.log(`\n  identical: ${same} files`);
if (diff.length) {
  console.log(`  DIVERGED : ${diff.join(", ")}`);
  for (const f of diff.slice(0, 2)) {
    const a = JSON.parse(fs.readFileSync(`${SNAP}/full/${f}`, "utf8"));
    const b = JSON.parse(fs.readFileSync(`${OUT}/${f}`, "utf8"));
    const ka = a.cells || a.reports || [], kb = b.cells || b.reports || [];
    console.log(`    ${f}: full has ${ka.length} rows, incremental has ${kb.length}`);
  }
  process.exit(1);
}
console.log("  incremental output is byte-identical to a full rebuild");
