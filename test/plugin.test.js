import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = file => JSON.parse(readFileSync(path.join(root, file), "utf8"));

test("the marketplace lists the plugin under the same name as its manifest", () => {
  const market = json(".claude-plugin/marketplace.json");
  assert.equal(market.name, "codejury");
  assert.ok(market.owner?.name);
  const [entry] = market.plugins;
  assert.equal(market.plugins.length, 1);
  assert.match(entry.source, /^\.\/[^.]/);
  const manifest = json(path.join(entry.source, ".claude-plugin/plugin.json"));
  assert.equal(entry.name, manifest.name);
  assert.equal(manifest.license, json("package.json").license);
  // Unpinned on purpose: installs follow the repository instead of a version to keep in sync.
  assert.equal(manifest.version, undefined);
  // A plugin bin/ goes on PATH and blocks claude.ai installs; the repository's bin/ must stay outside.
  assert.ok(!existsSync(path.join(root, entry.source, "bin")));
});

test("every plugin skill has a name and description, and the review skill uses real flags", () => {
  const skills = path.join(root, "plugin/skills");
  const names = readdirSync(skills).sort();
  assert.deepEqual(names, ["multi-agent-code-review", "review"]);
  for (const name of names) {
    const text = readFileSync(path.join(skills, name, "SKILL.md"), "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(front, `${name}: frontmatter`);
    assert.match(front, new RegExp(`^name: ${name}$`, "m"));
    assert.match(front, /^description: \S/m);
    // Installed plugins are copied without the rest of the repository.
    assert.doesNotMatch(text, /`(DESIGN\.md|config\.example\.yaml|prompts\/[\w-]+\.md)`/, `${name}: repository-relative path`);
  }
  const review = readFileSync(path.join(skills, "review/SKILL.md"), "utf8");
  assert.match(review, /^disable-model-invocation: true$/m);
  const help = execFileSync(process.execPath, [path.join(root, "bin/jury.js"), "help", "review"], { encoding: "utf8" });
  for (const flag of review.match(/--[a-z][\w-]*/g)) assert.ok(help.includes(`${flag} `), `jury review has no ${flag}`);
  assert.equal(json("package.json").name, "@agentsdance/codejury");
  assert.match(review, /npx -y @agentsdance\/codejury/);
});
