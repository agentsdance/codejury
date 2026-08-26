// The console server. Serves web/ and the runs found on disk.
import http from "node:http";
import { readFile, stat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listRuns, runsDir, readEvents, foldEvents } from "./store.js";
import { conversation } from "./loop.js";
import { watch } from "node:fs";

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
  // dir -> the reason last reported for it. Keyed by reason so a run that
  // fails a NEW way still says so, and a fixed one that breaks again re-warns.
  const warned = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Cache-Control", "no-store");

    try {
      if (url.pathname === "/api/run" || url.pathname === "/api/runs") {
        // Read per request. A run is written while the console is already up,
        // so anything resolved once at boot would never be picked up.
        const { runs, skipped } = await listRuns(base);
        // Once per directory, not once per request. The console polls every
        // three seconds, so a single unreadable run scrolled the same line
        // past the review it was meant to be reporting on.
        const bad = new Set(skipped.map((s) => s.dir));
        for (const dir of warned.keys()) if (!bad.has(dir)) warned.delete(dir);
        for (const s of skipped) {
          if (warned.get(s.dir) === s.reason) continue;
          warned.set(s.dir, s.reason);
          onLog(`skipped ${s.dir}: ${s.reason}`);
        }
        if (runs.length === 0) return json(res, 404, { error: "no runs yet" });
        return json(res, 200, runs.length === 1 ? runs[0] : { targets: runs });
      }

      // The conversation, folded per reviewer. Same event log the timeline
      // reads — a thread is derived, never stored, so a replayed run shows the
      // exact exchange that happened rather than a summary written afterwards.
      if (url.pathname === "/api/conversation") {
        const slug = path.basename(url.searchParams.get("run") ?? "");
        if (!slug) return json(res, 400, { error: "run is required" });
        const events = await readEvents(path.join(base, slug));
        return json(res, 200, { slug, threads: conversation(events) });
      }

      // Live stream. Polling was fine for a finished run and useless for a
      // live one: a reviewer talks for twenty minutes and the console has
      // nothing to show until it exits. Here every appended event is pushed as
      // it lands, so the conversation appears at the speed it is spoken.
      if (url.pathname === "/api/stream") {
        const slug = path.basename(url.searchParams.get("run") ?? "");
        if (!slug) return json(res, 400, { error: "run is required" });
        return stream(res, path.join(base, slug), slug, onLog);
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

/**
 * Server-sent events over the run's append-only log.
 *
 * The log is the transport. Nothing here holds run state: on connect the whole
 * file is replayed so a page opened mid-run catches up, then fs.watch drives
 * incremental reads from the last byte offset. Because the log only ever grows,
 * "what is new" is a file length comparison rather than a diff.
 */
async function stream(res, dir, slug, onLog) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // The console is same-origin, but a proxy that buffers would defeat the
    // entire point of streaming.
    "X-Accel-Buffering": "no",
  });

  const file = path.join(dir, "events.ndjson");
  let offset = 0;
  let closed = false;
  let reading = false;
  let again = false;

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Reads are serialised: fs.watch fires several times for one append, and two
  // concurrent readers would both start from the same offset and emit the same
  // lines twice.
  const pump = async () => {
    if (closed) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      const { size } = await stat(file).catch(() => ({ size: 0 }));
      if (size > offset) {
        const fh = await open(file, "r");
        try {
          const len = size - offset;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, offset);
          const text = buf.toString("utf8");
          // A partial final line means an append landed mid-write. Leave it in
          // the stream and pick it up on the next pump rather than emitting
          // half an event.
          const cut = text.lastIndexOf("\n");
          if (cut >= 0) {
            offset += Buffer.byteLength(text.slice(0, cut + 1), "utf8");
            for (const line of text.slice(0, cut).split("\n")) {
              if (!line.trim()) continue;
              try { send("event", JSON.parse(line)); } catch { /* torn line */ }
            }
          }
        } finally {
          await fh.close().catch(() => {});
        }
      } else if (size < offset) {
        // Truncated or replaced underneath us — restart rather than serve
        // nonsense from a stale offset.
        offset = 0;
        again = true;
      }
    } catch (err) {
      onLog?.(`stream ${slug}: ${err.message}`);
    } finally {
      reading = false;
      if (again && !closed) { again = false; await pump(); }
    }
  };

  await pump();
  send("ready", { slug });

  let watcher = null;
  try {
    watcher = watch(dir, () => { pump(); });
  } catch { /* fall back to the interval alone */ }
  // fs.watch is unreliable on some filesystems (and silent on network mounts),
  // so a slow poll backs it up. It is a safety net, not the mechanism.
  const poll = setInterval(pump, 1000);
  // Comment frames keep intermediaries from reaping an idle connection during
  // a long agent turn.
  const beat = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, 15000);

  const done = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(beat);
    watcher?.close();
    res.end();
  };
  res.on("close", done);
  res.on("error", done);
}
