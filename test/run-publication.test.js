// Hold an actual CLI publisher just before its atomic rename, then let a second
// process publish newer events. IPC gates the ordering; no timing race is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const root = path.dirname(path.dirname(cli));
const { DEFAULTS } = await import(pathToFileURL(path.join(root, 'lib/config.js')));
const { appendEvent, readEvents, publishEvents, readRun } = await import(pathToFileURL(path.join(root, 'lib/store.js')));

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'jury-publication-'));
  const cwd = path.join(home, 'repo');
  await mkdir(cwd);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const children = [];
  t.after(async () => {
    try {
      await Promise.all(children.map(async ({ child, done }) => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await done;
      }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  const git = (...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'master');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base');
  const agents = ['first', 'second'].map(name => ({ name, role: 'reviewer', argv: [process.execPath, '-e', "console.log('NO NEW FINDINGS')"] }));
  await writeFile(path.join(cwd, 'jury.config.json'), JSON.stringify({ agents: [
    ...DEFAULTS.agents.map(a => ({ name: a.name, enabled: false })),
    { name: 'fixture-judge', role: 'main', argv: [process.execPath, '-e', "throw Error('judge must not run')"] }, ...agents,
  ] }));
  const dir = path.join(cwd, 'runs', 'shared');
  await appendEvent(dir, { t: 'target', target: { repo: 'fixture', id: '#1', judge: 'fixture-judge' } });
  for (const agent of agents) {
    await appendEvent(dir, { t: 'finding.raised', id: agent.name, agent: agent.name, round: 1, claim: `${agent.name} claim` });
    await appendEvent(dir, { t: 'finding.resolved', id: agent.name, verdict: 'rejected', reason: 'Checked' });
  }
  const hook = path.join(home, 'pause-publication.cjs');
  await writeFile(hook, `
    const fs = require('node:fs/promises');
    const rename = fs.rename;
    let held = false;
    fs.rename = async (from, to) => {
      if (!held && to === ${JSON.stringify(path.join(dir, 'run.json'))}) {
        held = true;
        await new Promise(resolve => {
          process.once('message', resolve);
          process.send('snapshot-ready');
        });
        process.disconnect();
      }
      return rename(from, to);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  function start(args, paused = false) {
    const child = fork(cli, [...args, '--dir', cwd, '--run', 'shared'], {
      cwd, env, execArgv: paused ? ['--require', hook] : [], silent: true, timeout: 15000,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise(resolve => {
      child.on('error', error => { stderr += error.message; });
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const ready = paused ? Promise.race([
      new Promise(resolve => child.once('message', resolve)),
      done.then(result => { throw new Error(`Publisher exited before gate: ${JSON.stringify(result)}`); }),
    ]) : null;
    children.push({ child, done });
    return { child, done, ready };
  }
  return { dir, start };
}

test('a late reply publisher preserves another process\'s newer answer', { timeout: 20000 }, async t => {
  const { dir, start } = await fixture(t);
  const first = start(['reply', '--reviewer', 'first'], true);
  assert.equal(await first.ready, 'snapshot-ready');
  const second = await start(['reply', '--reviewer', 'second']).done;
  assert.equal(second.code, 0, JSON.stringify(second));
  const newest = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(newest.replies.map(r => r.agent).sort(), ['first', 'second']);
  first.child.send('publish');
  const result = await first.done;
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal((await readEvents(dir)).filter(e => e.t === 'reply.answered').length, 2);
  const saved = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(saved.replies.map(r => r.agent).sort(), ['first', 'second'], 'the last rename must not erase a completed answer');
});

test('a late finding publisher preserves another process\'s newer reproduction', { timeout: 20000 }, async t => {
  const { dir, start } = await fixture(t);
  const first = start(['finding', 'resolve', 'first', '--verdict', 'deferred', '--reason', 'Deferred'], true);
  assert.equal(await first.ready, 'snapshot-ready');
  const second = await start(['finding', 'reproduce', 'second', '--evidence', 'Reproduced concurrently']).done;
  assert.equal(second.code, 0, JSON.stringify(second));
  first.child.send('publish');
  const result = await first.done;
  assert.equal(result.code, 0, JSON.stringify(result));
  const saved = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
  assert.equal(saved.exchanges.find(f => f.id === 'first').res, 'deferred');
  assert.equal(saved.exchanges.find(f => f.id === 'second').reproduced, 'Reproduced concurrently');
});

test('event publication preserves seed fields, UTF-8 and torn-line recovery', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-publish-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await publishEvents(dir, { target: { repo: 'fixture' }, foot: 'seed footer' });
  assert.equal((await readRun(dir)).target.repo, 'fixture', 'a missing log still publishes a seeded run');
  await writeFile(path.join(dir, 'events.ndjson'), 'torn line\n' + JSON.stringify({ t: 'target', target: { title: '审查 🧪', state: 'converged' } }) + '\n');
  await publishEvents(dir, { target: { repo: 'fixture', state: 'review' }, foot: 'seed footer' });
  const run = await readRun(dir);
  assert.deepEqual(run.target, { repo: 'fixture', title: '审查 🧪', state: 'converged' });
  assert.equal(run.foot, 'seed footer');
  assert.equal((await readEvents(dir)).length, 1);
});

test('event publication reports write and read errors without leaving temporary snapshots', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-publish-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await appendEvent(dir, { t: 'target', target: { id: '#1' } });
  await mkdir(path.join(dir, 'run.json'));
  await assert.rejects(publishEvents(dir), error => ['EISDIR', 'EPERM', 'EEXIST'].includes(error.code));
  assert.deepEqual((await readdir(dir)).sort(), ['events.ndjson', 'run.json']);
  await rm(path.join(dir, 'events.ndjson'));
  await mkdir(path.join(dir, 'events.ndjson'));
  await assert.rejects(publishEvents(dir), { code: 'EISDIR' });
});
