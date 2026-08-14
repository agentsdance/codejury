// Lift the run embedded in web/index.html into runs/<slug>/run.json.
//
// The page carries a default run so it renders standalone; this exports that
// same object as a file the CLI's console can serve. One-off bootstrap — real
// runs are written by `macr review`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const html = readFileSync("web/index.html", "utf8");
const start = html.indexOf("{", html.indexOf("let RUN = {"));

let depth = 0;
let end = -1;
let quote = null;
for (let i = start; i < html.length; i++) {
  const c = html[i];
  const prev = html[i - 1];
  if (quote) {
    if (c === quote && prev !== "\\") quote = null;
    continue;
  }
  if (c === '"' || c === "'" || c === "`") {
    quote = c;
    continue;
  }
  if (c === "{") depth++;
  else if (c === "}") {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
if (end < 0) throw new Error("could not find the end of the RUN object");

const run = eval("(" + html.slice(start, end) + ")");
run.target.state = "merged";
run.target.stateNote = "merged · converged on ae473ab";

const slug = `${run.target.repo.replace(/[^\w.-]+/g, "-")}-${run.target.id.replace(/[^\w.-]+/g, "")}`;
const dir = path.join("runs", slug);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");

console.log(`wrote ${dir}/run.json`);
console.log(`  ${run.target.repo} ${run.target.id} · ${run.target.state}`);
console.log(`  ${run.rounds.length} rounds · ${run.exchanges.length} exchanges`);
