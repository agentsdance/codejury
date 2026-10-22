// Only directories created here, with a stopped owner and process group, may
// be reclaimed. Never infer ownership from a Go/cache-like name in /tmp.
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function agentTempRoot(env = process.env) {
  return path.resolve(env.JURY_AGENT_TEMP_ROOT || path.join(homedir(), ".jury", "tmp", "agents"));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function childAlive(owner) {
  return owner.childPid && alive(owner.processGroup ? -owner.childPid : owner.childPid);
}

function validOwner(owner) {
  return owner?.version === 1 && owner.kind === "codejury-agent-temp"
    && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && ["prepared", "launching", "running"].includes(owner.phase)
    && typeof owner.processGroup === "boolean"
    && (owner.phase === "running"
      ? Number.isSafeInteger(owner.childPid) && owner.childPid > 0
      : owner.childPid === null);
}

async function checkRoot(root, create = false) {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = await lstat(root); }
  catch (error) { if (error.code === "ENOENT" && !create) return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`Agent temporary root must be an owned directory, not a symlink: ${root}`);
  }
  return true;
}

// Go module caches contain read-only directories. Make owned directories
// removable, without following symlinks or changing external cache permissions.
async function removeOwned(dir) {
  async function writable(entry) {
    let stat;
    try { stat = await lstat(entry); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await chmod(entry, stat.mode | 0o700);
    for (const name of await readdir(entry)) await writable(path.join(entry, name));
  }
  await writable(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Inventory or reclaim interrupted invocations; unknown and active entries stay. */
export async function agentTemps({ root = agentTempRoot(), clean = false } = {}) {
  root = path.resolve(root);
  if (!await checkRoot(root)) return [];
  const entries = [];
  for (const name of await readdir(root)) {
    const dir = path.join(root, name);
    let status = "unrecognized";
    try {
      const stat = await lstat(dir);
      if (/^agent-/.test(name) && stat.isDirectory() && !stat.isSymbolicLink()
        && (!process.getuid || stat.uid === process.getuid())) {
        const marker = path.join(dir, "owner.json");
        const markerStat = await lstat(marker);
        const owner = markerStat.isFile() && !markerStat.isSymbolicLink()
          ? JSON.parse(await readFile(marker, "utf8")) : null;
        if (validOwner(owner)) {
          status = alive(owner.pid) || childAlive(owner) ? "active"
            : owner.phase === "launching" ? "uncertain" : "stale";
          if (clean && status === "stale") {
            await removeOwned(dir);
            status = "removed";
          }
        }
      }
    } catch (error) {
      // A missing marker is an unknown entry; a missing directory was already
      // reclaimed by another cleanup. Do not hide unmarked cache directories.
      if (error.code === "ENOENT") {
        if (!await lstat(dir).catch(() => null)) continue;
      } else if (!(error instanceof SyntaxError)) status = `retained: ${error.message}`;
    }
    entries.push({ path: dir, status });
  }
  return entries;
}

export async function createAgentTemp(env = process.env) {
  const root = agentTempRoot(env);
  await checkRoot(root, true);
  await agentTemps({ root, clean: true });
  const dir = await mkdtemp(path.join(root, "agent-"));
  const temporary = path.join(dir, "tmp");
  const owner = { version: 1, kind: "codejury-agent-temp", pid: process.pid,
    childPid: null, processGroup: process.platform !== "win32", phase: "prepared" };
  const save = () => {
    writeFileSync(path.join(dir, "owner.next"), JSON.stringify(owner), { mode: 0o600 });
    renameSync(path.join(dir, "owner.next"), path.join(dir, "owner.json"));
  };
  try {
    save();
    await mkdir(temporary, { mode: 0o700 });
    for (const name of ["go-build", "go-mod"]) await mkdir(path.join(temporary, name));
  } catch (error) {
    await removeOwned(dir);
    throw error;
  }
  return {
    directory: temporary,
    env: { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      GOCACHE: env.GOCACHE || path.join(temporary, "go-build"),
      GOMODCACHE: env.GOMODCACHE || path.join(temporary, "go-mod") },
    launching() { owner.phase = "launching"; save(); },
    spawned(pid) {
      owner.childPid = pid || null;
      owner.phase = pid ? "running" : "prepared";
      save();
    },
    async dispose() {
      // Group termination happens in agents.js. OS reaping may lag its result.
      for (let n = 0; childAlive(owner) && n < 40; n++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (childAlive(owner)) return false;
      await removeOwned(dir);
      return true;
    },
  };
}
