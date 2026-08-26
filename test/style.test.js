// The CLI's own output. Run with `node --test`.
//
// The property that matters most here is the absence of colour: `macr … > log`
// and `| grep` have to stay readable, and a terminal that asked for no colour
// has to get none.
import { test } from "node:test";
import assert from "node:assert/strict";

const ESC = "\x1b";

/** style.js decides once at import, so each case needs its own module instance. */
async function styleWith({ tty, noColor, term }) {
  const wasTTY = process.stdout.isTTY;
  const wasNo = process.env.NO_COLOR;
  const wasTerm = process.env.TERM;
  process.stdout.isTTY = tty;
  if (noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor;
  if (term === undefined) delete process.env.TERM;
  else process.env.TERM = term;
  try {
    // A query string defeats the module cache, so ON is recomputed.
    return await import(`../lib/style.js?t=${tty}&n=${noColor}&e=${term}`);
  } finally {
    process.stdout.isTTY = wasTTY;
    if (wasNo === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = wasNo;
    if (wasTerm === undefined) delete process.env.TERM; else process.env.TERM = wasTerm;
  }
}

test("a pipe gets no escape codes, so redirected output stays greppable", async () => {
  const st = await styleWith({ tty: false, term: "xterm-256color" });
  assert.equal(st.verdict("accepted"), "ACCEPTED");
  assert.equal(st.agent("codex"), "codex");
  assert.ok(!st.rule("round 1").includes(ESC));
});

test("NO_COLOR is honoured for any value, including the empty string", async () => {
  for (const v of ["1", "", "0", "no"]) {
    const st = await styleWith({ tty: true, noColor: v, term: "xterm-256color" });
    assert.ok(!st.verdict("rejected").includes(ESC), `NO_COLOR=${JSON.stringify(v)} still coloured`);
  }
});

test("a dumb terminal gets no colour either", async () => {
  const st = await styleWith({ tty: true, term: "dumb" });
  assert.equal(st.agent("codex"), "codex");
});

test("on a real terminal each verdict gets its own colour", async () => {
  const st = await styleWith({ tty: true, term: "xterm-256color" });
  const [a, r, d] = ["accepted", "rejected", "deferred"].map((v) => st.verdict(v));
  for (const s of [a, r, d]) assert.ok(s.includes(ESC), "expected colour on a TTY");
  assert.equal(new Set([a, r, d]).size, 3, "accepted, rejected and deferred must differ");
  assert.match(a, /ACCEPTED/);
});

test("an agent with no assigned hue still gets a stable one of its own", async () => {
  const st = await styleWith({ tty: true, term: "xterm-256color" });
  assert.equal(st.agent("someone-new"), st.agent("someone-new"), "must not vary between calls");
  assert.notEqual(st.agent("someone-new"), st.agent("other-one"));
  // The ends of the 256-colour cube vanish into one background or the other.
  const n = Number(st.agent("someone-new").match(/38;5;(\d+)/)[1]);
  assert.ok(n >= 22 && n <= 219, `hue ${n} is too close to black or white`);
});

test("counts are pluralised, not left as the '(s)' placeholder", async () => {
  const st = await styleWith({ tty: false });
  assert.equal(st.count(1, "finding"), "1 finding");
  assert.equal(st.count(2, "finding"), "2 findings");
  assert.equal(st.count(0, "finding"), "0 findings");
  assert.equal(st.count(1, "reviewer"), "1 reviewer");
  assert.equal(st.count(3, "round"), "3 rounds");
});

test("an indented report cannot be mistaken for the loop's own voice", async () => {
  const st = await styleWith({ tty: false });
  const out = st.indent("FINDING: x\nWHERE: a.js:1");
  assert.equal(out, "  FINDING: x\n  WHERE: a.js:1");
});
