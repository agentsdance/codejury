import { test } from "node:test";
import assert from "node:assert/strict";
import { foldEvents } from "../lib/store.js";

const ts = seconds => new Date(Date.parse("2026-10-20T12:00:00Z") + seconds * 1000).toISOString();
const elapsed = segment => (segment.e - segment.s) * 60;

test("completed timeline spans retain second and millisecond precision from events", () => {
  for (const [start, end] of [[0, 1], [0, 2], [0, 3], [0, 20], [2.5, 3.5], [1.25, 3.875]]) {
    const run = foldEvents([
      { t: "target", ts: ts(0), target: { state: "review" } },
      { t: "round.start", n: 1, ts: ts(start) },
      { t: "agent.launch", agent: "trae", round: 1, ts: ts(start) },
      { t: "agent.report", agent: "trae", round: 1, ts: ts(end), verdict: "clean", seconds: end - start },
    ]);
    const segment = run.lanes[0].segs[0];
    assert.ok(Math.abs(elapsed(segment) - (end - start)) < 1e-9,
      `${end - start}s review became ${elapsed(segment)}s in the timeline`);
    assert.equal(segment.s, start / 60);
    assert.equal(segment.e, end / 60);
    assert.equal(run.rounds[0].startMin, start / 60);
    assert.equal(run.rounds[0].verdicts[0].atMin, end / 60);
    assert.equal(run.marks[0].at, start / 60);
  }
});

test("live and interrupted short spans retain precise endpoints", () => {
  const run = foldEvents([
    { t: "round.start", n: 1, ts: ts(0) },
    { t: "agent.launch", agent: "trae", round: 1, ts: ts(0) },
    { t: "agent.launch", agent: "peer", round: 1, ts: ts(0) },
    { t: "agent.report", agent: "peer", round: 1, ts: ts(3.5), verdict: "clean" },
    { t: "round.start", n: 2, ts: ts(10.25) },
    { t: "agent.launch", agent: "trae", round: 2, ts: ts(10.25) },
    { t: "agent.alive", agent: "trae", round: 2, ts: ts(12.75), seconds: 2.5 },
  ]);
  const [interrupted, live] = run.lanes.find(lane => lane.who === "trae").segs;
  assert.equal(interrupted.abandoned, true);
  assert.ok(Math.abs(elapsed(interrupted) - 3.5) < 1e-9);
  assert.equal(live.open, true);
  assert.ok(Math.abs(elapsed(live) - 2.5) < 1e-9);
  assert.equal(run.marks[1].at, 10.25 / 60);
});
