// Rendering a turn in the console. Run with `node --test`.
//
// Completed review output must remain directly readable in the conversation.
// Only an in-progress stream may use a compact internal scroll region.
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
    ...["esc", "hash", "bytes", "clamped", "bubble", "stampFor", "turnHTML", "reviewedCommit", "statusLabel", "timelineDuration"].map(fn),
    "export { turnHTML, reviewedCommit, statusLabel, timelineDuration, CLAMP };",
  ].join("\n");

  return import("data:text/javascript;base64," + Buffer.from(mod).toString("base64"));
}

test("long completed messages expand inline without clipping or internal scrolling", async () => {
  const { turnHTML, CLAMP } = await loadRenderer();

  const evidence = "reviewer captured output\n".repeat(2000);
  assert.ok(evidence.length > CLAMP * 10, "the test evidence must exceed the clamp");

  for (const turn of [
    { kind: "report", who: "codex", text: evidence },
    { kind: "answer", who: "codex", text: evidence },
    { kind: "reply", who: "claude", text: evidence },
    { kind: "reproduced", who: "claude", claim: "the retry wait never grows", text: evidence },
    { kind: "finding", who: "codex", claim: "many findings", body: evidence },
  ]) {
    const html = turnHTML(turn, "codex");
    assert.ok(html.includes(evidence.trim()), `${turn.kind} must contain its full text`);
    assert.doesNotMatch(html, /class="tall"/, `${turn.kind} must not scroll internally`);
    assert.doesNotMatch(html, /class="more"|…/, `${turn.kind} must not clip or truncate`);
  }
});

test("only a long in-progress stream remains compact", async () => {
  const { turnHTML, CLAMP } = await loadRenderer();
  const live = "still working\n".repeat(CLAMP);
  const long = turnHTML({ kind: "streaming", who: "codex", text: live }, "codex");
  assert.ok(long.includes(live.trim()), "the live text remains searchable and selectable");
  assert.match(long, /class="tall"/, "a live stream may remain compact");

  const html = turnHTML(
    { kind: "streaming", who: "codex", text: "one line" },
    "codex");
  assert.ok(html.includes("one line"));
  assert.doesNotMatch(html, /class="tall"/);
});

test("completed review status is plain language and labels legacy commit ids", async () => {
  const { reviewedCommit, statusLabel } = await loadRenderer();
  const current = { state: "converged", stateNote: "Review complete", reviewedCommit: "abc1234" };
  assert.equal(statusLabel(current), "Review complete");
  assert.equal(reviewedCommit(current), "abc1234");

  const legacy = { state: "converged", stateNote: "converged on DEADBEE" };
  assert.equal(statusLabel(legacy), "Review complete");
  assert.equal(reviewedCommit(legacy), "deadbee");

  assert.equal(statusLabel({ state: "merged", stateNote: "merged · converged on deadbee" }), "Merged");
  assert.equal(
    statusLabel({ state: "merged", stateNote: "Merged by release manager" }),
    "Merged by release manager",
    "descriptive merge notes are not discarded",
  );
  assert.equal(
    statusLabel({ state: "human", stateNote: "2 reviewers failed to run" }),
    "2 reviewers failed to run",
    "human-intervention states keep their actionable explanation",
  );
});


test("timeline durations round consistently across seconds, minutes and short segments", async () => {
  const { timelineDuration } = await loadRenderer();
  for (const [s, e, expected] of [
    [0, 0, "0s"], [6, 6.05, "3s"], [0, 59 / 60, "59s"],
    [0, 59.6 / 60, "1 min"], [0, 1, "1 min"], [2, 12.7, "10.7 min"],
    [0, 8.300000000000004, "8.3 min"], [2, 1, "0s"],
  ]) assert.equal(timelineDuration({ s, e }), expected);
});

test("running and interrupted timeline segments retain measured elapsed time", async () => {
  const { timelineDuration } = await loadRenderer();
  assert.equal(timelineDuration({ r: 2, s: 7, e: 10, open: true }), "3 min");
  assert.equal(timelineDuration({ r: 3, s: 11, e: 15, abandoned: true }), "4 min");
});

test("zero-width reply markers use recorded duration or a truthful sent fallback", async () => {
  const { timelineDuration } = await loadRenderer();
  assert.equal(timelineDuration({ r: "reply", s: 16, e: 16, t: "reply · 1.2s" }), "1.2s");
  assert.equal(timelineDuration({ r: "reply", s: 16, e: 16, t: "reply · 0s" }), "0s");
  assert.equal(timelineDuration({ r: "reply", s: 16, e: 16 }), "sent");
  assert.equal(timelineDuration({ r: "reply", s: 16, e: 16, t: "reply failed" }), "sent");
});
