// Rendering a turn in the console. Run with `node --test`.
//
// The property: no single turn can be long enough to bury the ones after it.
// A reviewer's evidence arrives verbatim from `macr finding reproduce
// --evidence` and is routinely a wall of captured command output, so every
// bubble that carries reviewer-supplied prose has to collapse past CLAMP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The console is a single self-contained page, so its render helpers are
 *  lifted out of the <script> block rather than imported. Only the pure ones
 *  come across: the rest reaches for `document` the moment it is evaluated. */
async function loadRenderer() {
  const src = await readFile(path.join(root, "web", "index.html"), "utf8");
  const script = src.slice(src.indexOf("<script>") + 8, src.lastIndexOf("</script>"));

  const fn = (name) => {
    const start = script.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `web/index.html no longer defines ${name}()`);
    let depth = 0;
    for (let i = script.indexOf("{", start); i < script.length; i++) {
      if (script[i] === "{") depth++;
      else if (script[i] === "}" && --depth === 0) return script.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}()`);
  };
  const decl = (re, what) => {
    const m = script.match(re);
    assert.ok(m, `web/index.html no longer declares ${what}`);
    return m[0];
  };

  const mod = [
    decl(/const CLAMP = \d+;/, "CLAMP"),
    decl(/const SIDE = [^\n]+/, "SIDE"),
    decl(/const VERDICT_TEXT = \{[\s\S]*?\};/, "VERDICT_TEXT"),
    "let CONVO_T0 = null, CONVO_SPREAD = 0, CONVO_PREV = null;",
    'const TZ_LABEL = "UTC";',
    'const clockFmt = new Intl.DateTimeFormat("en-GB",' +
      ' { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });',
    ...["esc", "hash", "bytes", "clamped", "bubble", "stampFor", "turnHTML"].map(fn),
    "export { turnHTML, CLAMP };",
  ].join("\n");

  return import("data:text/javascript;base64," + Buffer.from(mod).toString("base64"));
}

test("a reproduction's evidence collapses past the clamp", async () => {
  const { turnHTML, CLAMP } = await loadRenderer();

  const evidence = "reviewer captured output\n".repeat(2000);
  assert.ok(evidence.length > CLAMP * 10, "the test evidence must exceed the clamp");

  const html = turnHTML(
    { kind: "reproduced", who: "claude", claim: "the retry wait never grows", text: evidence },
    "codex");

  // The collapsed half is what keeps later turns reachable: without it the
  // whole wall of output renders inline and the conversation scrolls past it.
  assert.match(html, /class="more"/,
    "long evidence rendered without a show-all toggle");
  assert.ok(html.includes(evidence.slice(0, CLAMP)),
    "the clamped preview should still show the first CLAMP characters");

  // The claim and the "Reproduced." lead-in sit outside the collapse, so the
  // bubble still says what it answers while folded.
  assert.match(html, /the retry wait never grows/);
  assert.match(html, /Reproduced\./);
});

test("short evidence renders whole, with no toggle", async () => {
  const { turnHTML } = await loadRenderer();
  const html = turnHTML(
    { kind: "reproduced", who: "claude", claim: "c", text: "one failing assertion" },
    "codex");
  assert.ok(html.includes("one failing assertion"));
  assert.doesNotMatch(html, /class="more"/);
});
