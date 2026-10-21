import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
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

test("port zero is passed to the listener for OS assignment", async t => {
  const attempts = [];
  const server = new EventEmitter();
  server.listen = (port, _host, listening) => {
    attempts.push(port);
    server.boundPort = port === 0 ? 43210 : port;
    queueMicrotask(listening);
    return server;
  };
  server.address = () => ({ port: server.boundPort });
  t.mock.method(http, "createServer", () => server);

  const result = await serve({ port: 0, onLog: () => {} });
  assert.deepEqual(attempts, [0]);
  assert.equal(result.port, 43210);
  assert.equal(result.url, "http://127.0.0.1:43210");
});

for (const [name, occupiedCount] of [
  ["an available requested port is preserved", 0],
  ["an occupied port walks to the next available port", 1],
  ["consecutive occupied ports are skipped in order", 2],
]) {
test(name, async t => {
  const attempts = [];
  const server = new EventEmitter();
  server.listen = (port, _host, listening) => {
    attempts.push(port);
    if (attempts.length <= occupiedCount) {
      queueMicrotask(() => server.emit("error",
        Object.assign(new Error("occupied"), { code: "EADDRINUSE" })));
    } else {
      server.boundPort = port;
      queueMicrotask(listening);
    }
    return server;
  };
  server.address = () => ({ port: server.boundPort });
  t.mock.method(http, "createServer", () => server);

  const requested = 4100;
  const result = await serve({ port: requested, onLog: () => {} });
  assert.deepEqual(attempts, Array.from({ length: occupiedCount + 1 }, (_, i) => requested + i));
  assert.equal(result.port, requested + occupiedCount);
  assert.equal(result.url, `http://127.0.0.1:${requested + occupiedCount}`);
});
}
