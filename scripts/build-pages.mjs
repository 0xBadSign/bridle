// Assemble the static site for GitHub Pages: web/ plus the two browser-safe agent modules the
// dashboard imports (../agent/planner.mjs, ../agent/keeper-core.mjs), kept at the same relative
// paths, and a root page that redirects to web/. Output: _site/ (gitignored by the workflow).
//   node scripts/build-pages.mjs [outdir]
import fs from "fs";
import path from "path";

const out = process.argv[2] || "_site";
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync("web", path.join(out, "web"), { recursive: true });
fs.mkdirSync(path.join(out, "agent"), { recursive: true });
for (const f of ["planner.mjs", "keeper-core.mjs"]) fs.copyFileSync(path.join("agent", f), path.join(out, "agent", f));
fs.writeFileSync(path.join(out, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=web/"><a href="web/">Bridle dashboard</a>\n');
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`site written to ${out}/`);
