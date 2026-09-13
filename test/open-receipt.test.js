import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForOpenReceipt } from "./helpers/open-receipt.js";

test("web opener polling tolerates startup beyond six seconds", async () => {
  let elapsed = 0;
  const receipt = { url: "http://127.0.0.1:3081/?run=current" };
  const opened = await waitForOpenReceipt("opened.json", {
    now: () => elapsed,
    sleep: async ms => { elapsed += ms; },
    read: async () => {
      if (elapsed < 7000) throw Object.assign(new Error("not yet"), { code: "ENOENT" });
      return JSON.stringify(receipt);
    },
  });
  assert.deepEqual(opened, receipt);
});

test("web opener polling stops before the enclosing test timeout", async () => {
  let elapsed = 0;
  const opened = await waitForOpenReceipt("opened.json", {
    now: () => elapsed,
    sleep: async ms => { elapsed += ms; },
    read: async () => { throw Object.assign(new Error("not yet"), { code: "ENOENT" }); },
  });
  assert.equal(opened, undefined);
  assert.equal(elapsed, 25000);
});
