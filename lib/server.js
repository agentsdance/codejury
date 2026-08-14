// The console server. Serves web/ and the runs found on disk.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listRuns, runsDir } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, "..", "web");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

export async function serve({ port = 3080, cwd = process.cwd(), onLog = console.log } = {}) {
  const base = runsDir(cwd);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Cache-Control", "no-store");

    try {
      if (url.pathname === "/api/run" || url.pathname === "/api/runs") {
        // Read per request. A run is written while the console is already up,
        // so anything resolved once at boot would never be picked up.
        const { runs, skipped } = await listRuns(base);
        for (const s of skipped) onLog(`skipped ${s.dir}: ${s.reason}`);
        if (runs.length === 0) return json(res, 404, { error: "no runs yet" });
        return json(res, 200, runs.length === 1 ? runs[0] : { targets: runs });
      }

      // Verbatim artifacts: the prompt a reviewer was given, the stream it
      // produced. Both names are validated against the run directory rather
      // than trusted, since they arrive from the query string.
      if (url.pathname === "/api/raw") {
        const slug = path.basename(url.searchParams.get("run") ?? "");
        const name = path.basename(url.searchParams.get("file") ?? "");
        if (!slug || !name) return json(res, 400, { error: "run and file are required" });
        const file = path.join(base, slug, name);
        if (!file.startsWith(path.join(base, slug) + path.sep)) {
          return json(res, 403, { error: "forbidden" });
        }
        const body = await readFile(file, "utf8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(body);
      }

      if (url.pathname === "/api/health") {
        const { runs, skipped } = await listRuns(base);
        // assets carries index.html's mtime so an open page can notice the page
        // itself changed and reload, instead of silently serving a stale build.
        let assets = "";
        try {
          assets = String((await stat(path.join(webRoot, "index.html"))).mtimeMs);
        } catch { /* embedded/missing is fine */ }
        return json(res, 200, {
          ok: true, runs: runs.length, skipped: skipped.length, dir: base, assets,
        });
      }

      // static
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const file = path.join(webRoot, rel);
      if (!file.startsWith(webRoot)) return json(res, 403, { error: "forbidden" });
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch (err) {
      if (err.code === "ENOENT") return json(res, 404, { error: "not found" });
      json(res, 500, { error: err.message });
    }
  });

  const bound = await listen(server, port, onLog);
  return { server, port: bound, url: `http://127.0.0.1:${bound}` };
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Walk forward rather than dying on "address already in use".
function listen(server, port, onLog) {
  return new Promise((resolve, reject) => {
    let p = port;
    const attempt = () => {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && p < port + 20) {
          onLog(`port ${p} busy, trying ${p + 1}`);
          p += 1;
          attempt();
        } else reject(err);
      });
      server.listen(p, "127.0.0.1", () => resolve(p));
    };
    attempt();
  });
}
