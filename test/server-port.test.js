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

test("an occupied port walks to the next available port", async t => {
  const createServer = http.createServer;
  const attempts = [];
  const server = new EventEmitter();
  server.listen = (port, _host, listening) => {
    attempts.push(port);
    if (attempts.length === 1) {
      queueMicrotask(() => server.emit("error",
        Object.assign(new Error("occupied"), { code: "EADDRINUSE" })));
    } else {
      server.boundPort = port;
      queueMicrotask(listening);
    }
    return server;
  };
  server.address = () => ({ port: server.boundPort });
  http.createServer = () => server;
  t.after(() => { http.createServer = createServer; });

  const requested = 4100;
  const result = await serve({ port: requested, onLog: () => {} });
  assert.deepEqual(attempts, [requested, requested + 1]);
  assert.equal(result.port, requested + 1);
  assert.equal(result.url, `http://127.0.0.1:${requested + 1}`);
});
