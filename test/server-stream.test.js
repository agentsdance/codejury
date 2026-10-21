import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const serverModule = new URL("../lib/server.js", import.meta.url).href;

for (const disconnect of ["during initial read", "after ready"]) {
  test(`an event stream releases its resources when disconnected ${disconnect}`, { timeout: 15000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "jury-stream-close-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = `
      import fs from "node:fs/promises";
      import http from "node:http";
      import path from "node:path";
      import { syncBuiltinESMExports } from "node:module";

      const root = ${JSON.stringify(root)};
      const early = ${disconnect === "during initial read"};
      const dir = path.join(root, "runs", "review");
      const events = path.join(dir, "events.ndjson");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(events, JSON.stringify({ t: "target", target: { state: "review" } }) + "\\n");

      let entered, release;
      const reading = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const stat = fs.stat;
      fs.stat = async (...args) => {
        if (early && args[0] === events) {
          entered();
          await gate;
        }
        return stat(...args);
      };
      syncBuiltinESMExports();
      const { serve } = await import(${JSON.stringify(serverModule)});
      const { server } = await serve({ cwd: root, port: 0, onLog: () => {} });
      let disconnected;
      const closed = new Promise(resolve => { disconnected = resolve; });
      server.on("request", (_request, response) => response.once("close", disconnected));

      const request = http.get({
        hostname: "127.0.0.1", port: server.address().port,
        path: "/api/stream?run=review", agent: false,
      });
      request.on("error", () => {});
      if (early) {
        await reading;
        request.destroy();
        await closed;
        release();
      } else {
        const ready = new Promise(resolve => {
          request.on("response", response => {
            let body = "";
            response.on("data", chunk => {
              body += chunk;
              if (body.includes("event: ready\\n")) resolve();
            });
          });
        });
        await ready;
        request.destroy();
        await closed;
      }
      await new Promise(resolve => server.close(resolve));
      console.log("HTTP server closed");
      // Natural process exit proves the closed stream left no watcher or timer
      // keeping the server alive. Do not call process.exit() here.
    `;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], { timeout: 10000 });
    assert.match(stdout, /HTTP server closed/);
  });
}
