// A separate process can report progress even when a test blocks in spawnSync.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const probe = fileURLToPath(new URL('ci-process-trace.cjs', import.meta.url));

// Read only numeric IDs globally; inspect executable names only for our group
// and descendants. Never collect command arguments or environment values.
export function processSnapshot(group) {
  const options = { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 };
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], options).trim().split('\n')
    .map(line => line.trim().split(/\s+/).map(Number));
  const ids = new Set([group]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid, pgid] of rows) {
      if (!ids.has(pid) && (pgid === group || ids.has(ppid))) { ids.add(pid); changed = true; }
    }
  }
  const alive = rows.filter(([pid]) => ids.has(pid)).map(([pid]) => pid);
  if (!alive.length) return [];
  return execFileSync('ps', ['-p', alive.join(','), '-o', 'pid=,ppid=,etime=,stat=,comm='], options)
    .trim().split('\n').map(line => {
      const [, pid, ppid, elapsed, state, executable] = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/) || [];
      return { pid: Number(pid), ppid: Number(ppid), elapsed, state, executable: path.basename(executable || '') };
    });
}

export async function runCheck(command, args, { directory, env = process.env,
  timeoutMs = 180000, intervalMs = 10000, graceMs = 2000,
  log = line => process.stderr.write(line + '\n'),
} = {}) {
  if (process.platform === 'win32') throw new Error('CI diagnostics require the Linux/macOS process-group CI environment');
  mkdirSync(directory, { recursive: true });
  const trace = path.join(directory, 'processes.ndjson');
  writeFileSync(trace, '');
  const report = (event, extra = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...extra });
    appendFileSync(path.join(directory, 'watchdog.ndjson'), line + '\n');
    log(`[ci-check] ${line}`);
  };
  let offset = 0;
  const flush = () => {
    const text = readFileSync(trace, 'utf8');
    const complete = text.lastIndexOf('\n') + 1;
    for (const line of text.slice(offset, complete).split('\n').filter(Boolean)) log(`[ci-process] ${line}`);
    offset = complete;
  };
  const child = spawn(command, args, { detached: true, stdio: 'inherit', env: {
    ...env, JURY_CI_TRACE: trace,
    NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --require=${JSON.stringify(probe)}`.trim(),
  } });
  report('start', { pid: child.pid, timeoutMs });
  const snapshot = () => {
    flush();
    try { report('snapshot', { processes: processSnapshot(child.pid) }); }
    catch (error) { report('snapshot-unavailable', { code: error.code || 'unknown' }); }
  };
  const signalGroup = signal => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') report('signal-error', { signal, code: error.code }); }
  };
  let termination;
  let failureCode;
  const stop = (code, reason) => {
    if (termination) return;
    failureCode = code;
    report(reason);
    snapshot();
    signalGroup('SIGTERM');
    // Keep the grace period even if the leader exits: descendants may ignore TERM.
    termination = delay(graceMs).then(() => { signalGroup('SIGKILL'); });
  };
  const interrupted = () => stop(130, 'interrupted');
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  const deadline = setTimeout(() => stop(124, 'timeout'), timeoutMs);
  const heartbeat = setInterval(snapshot, intervalMs);
  try {
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ code: 1, error: error.code }));
      child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
    });
    clearTimeout(deadline);
    clearInterval(heartbeat);
    await termination;
    flush();
    const code = failureCode ?? result.code;
    report('end', { ...result, code });
    return code;
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const task = process.argv[2];
  if (!['test', 'test:package'].includes(task)) throw new Error('Usage: node scripts/ci-check.mjs test|test:package');
  const base = path.join(process.env.RUNNER_TEMP || tmpdir(), 'codejury-ci');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, task.replace(':', '-') + '-'));
  console.error(`[ci-check] ${task}; diagnostics: ${directory}`);
  process.exitCode = await runCheck('npm', ['run', task], { directory });
}
