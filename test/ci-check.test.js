import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { runCheck } from '../scripts/ci-check.mjs';

const options = { skip: process.platform === 'win32', timeout: 20000 };
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jury-ci-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = [];
  return { directory, log: line => output.push(line), output };
}

test('CI diagnostics preserve failures without recording arguments or environment values', options, async t => {
  const config = await fixture(t);
  const code = await runCheck(process.execPath, ['-e', 'process.exit(7)', 'private-argument-sentinel'], {
    ...config, env: { ...process.env, PRIVATE_SENTINEL: 'private-environment-sentinel' },
  });
  assert.equal(code, 7);
  const trace = await readFile(path.join(config.directory, 'processes.ndjson'), 'utf8');
  assert.match(trace, /"event":"start"/);
  assert.match(trace, /"event":"end","code":7/);
  const evidence = trace + config.output.join('\n');
  assert.doesNotMatch(evidence, /private-argument-sentinel|private-environment-sentinel|PRIVATE_SENTINEL/);
});

test('CI watchdog diagnoses a blocked sync child and kills its TERM-resistant group only', options, async t => {
  const config = await fixture(t);
  const unrelated = spawn(process.execPath, ['-e', `
    process.on('message', message => { if (message === 'ping') process.send('pong'); });
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const unrelatedExit = once(unrelated, 'exit');
  t.after(async () => { unrelated.kill('SIGKILL'); await unrelatedExit; });
  const receipt = path.join(config.directory, 'child.json');
  const childCode = `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid: process.pid}));
    setInterval(() => {}, 1000);
  `;
  const code = await runCheck(process.execPath, ['-e', `
    require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'ignore'});
  `], { ...config, timeoutMs: 8000, graceMs: 100, intervalMs: 1000 });
  assert.equal(code, 124, 'a watchdog timeout must never become a passing check');
  const { pid } = JSON.parse(await readFile(receipt, 'utf8'));
  const response = await new Promise((resolve, reject) => {
    const cleanup = () => {
      unrelated.off('message', onMessage);
      unrelated.off('exit', onExit);
      unrelated.off('error', onError);
    };
    const onMessage = message => { cleanup(); resolve(message); };
    const onExit = (exitCode, signalCode) => {
      cleanup();
      reject(new Error(`unrelated process exited before handshake: code=${exitCode} signal=${signalCode}`));
    };
    const onError = error => { cleanup(); reject(error); };
    unrelated.once('message', onMessage);
    unrelated.once('exit', onExit);
    unrelated.once('error', onError);
    unrelated.send('ping', error => { if (error) onError(error); });
  });
  assert.equal(response, 'pong', 'unrelated process responds after watchdog cleanup');
  const records = (await readFile(path.join(config.directory, 'watchdog.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.some(row => row.event === 'timeout'));
  const snapshots = records.filter(row => row.event === 'snapshot').flatMap(row => row.processes);
  assert.ok(snapshots.some(row => row.pid === pid), 'snapshot identifies the blocked descendant');
  assert.ok(!snapshots.some(row => row.pid === unrelated.pid), 'unrelated processes are excluded');
  let state = '';
  try { state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); }
  catch (error) { assert.equal(error.status, 1); }
  assert.ok(!state || state.startsWith('Z'), `TERM-resistant descendant must be dead, got ${state}`);
});

test('CI watchdog reports a missing executable as failure without waiting for its deadline', options, async t => {
  const config = await fixture(t);
  const code = await runCheck(path.join(config.directory, 'missing-executable'), [], config);
  assert.equal(code, 1);
  assert.match(config.output.join('\n'), /"error":"ENOENT"/);
});

test('CI trace distinguishes the test coordinator from the individual test worker', options, async t => {
  const config = await fixture(t);
  await mkdir(path.join(config.directory, 'test'));
  const file = path.join(config.directory, 'test', 'sample.test.js');
  await writeFile(file, "require('node:test')('fixture', () => {});\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This fixture is a new coordinator, not our worker.
  assert.equal(await runCheck(process.execPath, ['--test', file], { ...config, env }), 0);
  const records = (await readFile(path.join(config.directory, 'processes.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = records.filter(row => row.event === 'start');
  const coordinators = starts.filter(row => row.role === 'test-runner');
  const workers = starts.filter(row => row.role === 'sample.test.js');
  assert.equal(coordinators.length, 1);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].ppid, coordinators[0].pid, 'test worker is a child of the test coordinator');
});
