// Rendering a turn in the console. Run with `node --test`.
//
// The property: no single turn can be long enough to bury the ones after it.
// A reviewer's evidence arrives verbatim from `jury finding reproduce
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

  // Both shapes are in use: `function bubble(...) {}` and `const esc = s => ...`.
  // Matching only the first silently lost esc() and bytes() the moment either
  // was written as an arrow, which is a test that breaks on a refactor rather
  // than on a regression.
  const fn = (name) => {
    const start = script.indexOf(`function ${name}(`);
    if (start >= 0) {
      let depth = 0;
      for (let i = script.indexOf("{", start); i < script.length; i++) {
        if (script[i] === "{") depth++;
        else if (script[i] === "}" && --depth === 0) return script.slice(start, i + 1);
      }
      throw new Error(`unbalanced braces in ${name}()`);
    }
    // A single-line arrow const, terminated by the newline rather than a brace.
    const arrow = script.match(new RegExp(`^const ${name} = [^\\n]+$`, "m"));
    assert.ok(arrow, `web/index.html no longer defines ${name}()`);
    return arrow[0];
  };
  const decl = (re, what) => {
    const m = script.match(re);
    assert.ok(m, `web/index.html no longer declares ${what}`);
    return m[0];
  };

  const mod = [
    decl(/const CLAMP = \d+;/, "CLAMP"),
    'const judgeName = () => "claude";',
    decl(/const SIDE = [^\n]+/, "SIDE"),
    decl(/const VERDICT_TEXT = \{[\s\S]*?\};/, "VERDICT_TEXT"),
    "let CONVO_T0 = null, CONVO_SPREAD = 0, CONVO_PREV = null;",
    // Presentational only, and each reaches for the DOM or a colour table that
    // has nothing to do with clamping. Stubbed rather than lifted so this test
    // fails when the clamp regresses, not when an icon is redrawn.
    'const icon = () => "";',
    'const hueFor = () => "#000";',
    'const hms = (n) => String(n ?? 0);',
    'const TZ_LABEL = "UTC";',
    'const clockFmt = new Intl.DateTimeFormat("en-GB",' +
      ' { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });',
    ...["esc", "hash", "bytes", "clamped", "bubble", "stampFor", "turnHTML"].map(fn),
    "export { turnHTML, CLAMP };",
  ].join("\n");

  return import("data:text/javascript;base64," + Buffer.from(mod).toString("base64"));
}

test("long evidence is shown whole, and scrolls rather than truncating", async () => {
  const { turnHTML, CLAMP } = await loadRenderer();

  const evidence = "reviewer captured output\n".repeat(2000);
  assert.ok(evidence.length > CLAMP * 10, "the test evidence must exceed the clamp");

  const html = turnHTML(
    { kind: "reproduced", who: "claude", claim: "the retry wait never grows", text: evidence },
    "codex");

  // Every message in full: reading a review must not mean clicking through it.
  // The whole text is in the DOM, so browser find and select-all reach it.
  assert.ok(html.includes(evidence.trim()), "the full evidence must be present");
  assert.doesNotMatch(html, /class="more"/, "nothing hides behind a button");
  assert.doesNotMatch(html, /…/, "nothing is truncated with an ellipsis");

  // But it gives up height rather than content, or one wall of captured output
  // buries every turn after it.
  assert.match(html, /class="tall"/, "a long message must scroll within itself");

  assert.match(html, /the retry wait never grows/);
  assert.match(html, /Reproduced\./);
});

test("a short message is not wrapped in a scroll box it does not need", async () => {
  const { turnHTML } = await loadRenderer();
  const html = turnHTML(
    { kind: "reproduced", who: "claude", claim: "c", text: "one failing assertion" },
    "codex");
  assert.ok(html.includes("one failing assertion"));
  assert.doesNotMatch(html, /class="tall"/);
  assert.doesNotMatch(html, /class="more"/);
});
