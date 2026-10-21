import { test } from "node:test";
import assert from "node:assert/strict";
import { serve } from "../lib/server.js";

test("port zero reports the actual listening port and a reachable console URL", async t => {
  const { server, port, url } = await serve({ port: 0, onLog: () => {} });
  t.after(() => new Promise(resolve => server.close(resolve)));

  assert.ok(port > 0, "the OS-assigned port must replace the requested zero");
  assert.equal(port, server.address().port);
  assert.equal(url, `http://127.0.0.1:${port}`);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^<!doctype html>/i);
});
