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

for (const [name, requested, occupiedCount, expected] of [
  ["an available maximum port is preserved", 65535, 0, [65535]],
  ["fallback can reach the maximum port", 65534, 1, [65534, 65535]],
  ["an occupied maximum port rejects without exceeding the valid range", 65535, Infinity, [65535]],
  ["fallback stops at the maximum port when the remaining ports are occupied", 65534, Infinity, [65534, 65535]],
  ["ordinary fallback stops after twenty additional ports", 4100, Infinity, Array.from({ length: 21 }, (_, i) => 4100 + i)],
]) {
test(name, async t => {
  const attempts = [], logs = [];
  const server = new EventEmitter();
  let lastError;
  server.listen = (port, _host, listening) => {
    attempts.push(port);
    if (port > 65535 || attempts.length <= occupiedCount) {
      lastError = Object.assign(new Error("occupied"), {
        code: port > 65535 ? "ERR_SOCKET_BAD_PORT" : "EADDRINUSE", port,
      });
      queueMicrotask(() => server.emit("error", lastError));
    } else {
      server.boundPort = port;
      queueMicrotask(listening);
    }
    return server;
  };
  server.address = () => ({ port: server.boundPort });
  t.mock.method(http, "createServer", () => server);

  const result = serve({ port: requested, onLog: message => logs.push(message) });
  if (occupiedCount === Infinity) {
    await assert.rejects(result, error => error === lastError && error.code === "EADDRINUSE");
  } else {
    const { port, url } = await result;
    assert.equal(port, expected.at(-1));
    assert.equal(url, `http://127.0.0.1:${port}`);
  }
  assert.deepEqual(attempts, expected);
  assert.deepEqual(logs, expected.slice(1).map((port, i) => `port ${expected[i]} busy, trying ${port}`));
});
}

test("non-collision listen errors reject without fallback", async t => {
  const server = new EventEmitter(), attempts = [];
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  server.listen = port => {
    attempts.push(port);
    queueMicrotask(() => server.emit("error", denied));
    return server;
  };
  t.mock.method(http, "createServer", () => server);
  await assert.rejects(serve({ port: 4100, onLog: () => assert.fail("must not retry") }), error => error === denied);
  assert.deepEqual(attempts, [4100]);
});
