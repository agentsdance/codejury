import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, symlink, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn, execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const packageRoot = path.dirname(path.dirname(cli));
const {runAgent} = await import(pathToFileURL(path.join(packageRoot, 'lib/agents.js')));
const {agentTemps, createAgentTemp} = await import(pathToFileURL(path.join(packageRoot, 'lib/agent-temp.js')));
const exec = promisify(execFile);
const options = {worktree: process.cwd(), prompt: 'test', stopToken: 'NO NEW FINDINGS'};
const agent = (script, env = {}) => ({name: 'fixture', cwd: 'worktree', env,
  argv: [process.execPath, '-e', script], report: 'whole'});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-agent-temp-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, root: path.join(dir, 'managed')};
}

for (const code of [0, 1]) test(`agent-created temporary caches are removed after exit ${code}`, async t => {
  const {root} = await fixture(t);
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = await runAgent(agent(`
      const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
      const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'jury-owned-go-cache-'));
      fs.writeFileSync(path.join(cache, 'compiled'), 'cache content');
      console.log(JSON.stringify({cache, tmp: os.tmpdir(), build: process.env.GOCACHE,
        modules: process.env.GOMODCACHE}));
      console.log('NO NEW FINDINGS');
      process.exitCode = ${code};
    `, {JURY_AGENT_TEMP_ROOT: root}), options);
    const env = JSON.parse(result.raw.split('\n')[0]);
    t.after(() => rm(env.cache, {recursive: true, force: true}));
    assert.equal(result.ok, code === 0);
    assert.equal(existsSync(env.cache), false, 'a completed agent must not leave its temporary cache behind');
    assert.ok(env.tmp.startsWith(root + path.sep));
    assert.ok(env.build.startsWith(root + path.sep));
    assert.ok(env.modules.startsWith(root + path.sep));
    assert.deepEqual(await readdir(root), [], 'repeated invocations must not accumulate temporary directories');
  }
});

test('explicit Go caches survive cleanup, including read-only module directories', async t => {
  const {dir, root} = await fixture(t);
  const build = path.join(dir, 'shared-build'), modules = path.join(dir, 'shared-modules');
  await mkdir(build); await mkdir(modules);
  const result = await runAgent(agent(`
    const fs = require('node:fs'), path = require('node:path');
    for (const key of ['GOCACHE', 'GOMODCACHE']) fs.writeFileSync(path.join(process.env[key], 'keep'), key);
    const local = path.join(process.env.TMPDIR, 'readonly');
    fs.mkdirSync(local); fs.writeFileSync(path.join(local, 'module'), 'data'); fs.chmodSync(local, 0o555);
    fs.symlinkSync(process.env.GOMODCACHE, path.join(process.env.TMPDIR, 'outside'), 'dir');
    console.log('NO NEW FINDINGS');
  `, {JURY_AGENT_TEMP_ROOT: root, GOCACHE: build, GOMODCACHE: modules}), options);
  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(build, 'keep'), 'utf8'), 'GOCACHE');
  assert.equal(await readFile(path.join(modules, 'keep'), 'utf8'), 'GOMODCACHE');
  assert.deepEqual(await readdir(root), []);
});

test('file-delivered prompts and failed launches leave no temporary directories', async t => {
  const {root} = await fixture(t);
  const result = await runAgent({name: 'file-fixture', cwd: 'worktree', report: 'whole',
    promptDelivery: 'file', env: {JURY_AGENT_TEMP_ROOT: root},
    argv: [process.execPath, '-e', `console.log(require('node:fs').readFileSync(process.argv[1], 'utf8')); console.log('NO NEW FINDINGS')`, '{{promptFile}}'],
  }, options);
  assert.equal(result.ok, true); assert.match(result.raw, /^test\n/);
  assert.deepEqual(await readdir(root), []);
  const failed = await runAgent({...agent('', {JURY_AGENT_TEMP_ROOT: root}), argv: ['/jury-missing-agent']}, options);
  assert.equal(failed.ok, false);
  assert.deepEqual(await readdir(root), []);
});

test('timed-out agents release their caches after process termination', {skip: process.platform === 'win32'}, async t => {
  const {root} = await fixture(t);
  const result = await runAgent(agent(`console.log(process.env.TMPDIR); setInterval(() => {}, 1000)`,
    {JURY_AGENT_TEMP_ROOT: root}), {...options, timeoutSeconds: 0.3});
  assert.equal(result.timedOut, true);
  assert.deepEqual(await readdir(root), []);
});

async function waitFor(predicate) {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await delay(10); }
  assert.fail('fixture did not reach expected process state');
}

function running(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const signal of ['SIGINT', 'SIGKILL']) test(`cleanup reclaims interrupted ${signal} runs only after their process groups stop`,
  {skip: process.platform === 'win32'}, async t => {
    const {root} = await fixture(t);
    const definition = agent(`console.log('ready=' + process.pid); setInterval(() => {}, 1000)`, {JURY_AGENT_TEMP_ROOT: root});
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'lib/agents.js')).href)};
      await runAgent(${JSON.stringify(definition)}, {...${JSON.stringify(options)}, onChunk: s => process.stdout.write(s)});
    `], {stdio: ['ignore', 'pipe', 'pipe']});
    let text = '', pid;
    child.stdout.on('data', chunk => { text += chunk; pid = Number(text.match(/ready=(\d+)/)?.[1]); });
    t.after(() => { child.kill('SIGKILL'); if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } });
    await waitFor(() => pid);
    assert.equal((await agentTemps({root, clean: true}))[0].status, 'active');
    const exited = once(child, 'exit');
    child.kill(signal); await exited;
    if (signal === 'SIGKILL') {
      assert.equal((await agentTemps({root, clean: true}))[0].status, 'active', 'orphaned running group must retain its cache');
      process.kill(-pid, 'SIGKILL');
    }
    await waitFor(() => !running(-pid));
    const listed = await exec(process.execPath, [cli, 'cache'], {env: {...process.env, JURY_AGENT_TEMP_ROOT: root}});
    assert.match(listed.stdout, /stale/);
    assert.equal((await readdir(root)).length, 1, 'listing never deletes');
    if (signal === 'SIGINT') {
      const clean = await exec(process.execPath, [cli, 'cache', 'clean'], {env: {...process.env, JURY_AGENT_TEMP_ROOT: root}});
      assert.match(clean.stdout, /removed/);
    } else {
      await runAgent(agent(`console.log('NO NEW FINDINGS')`, {JURY_AGENT_TEMP_ROOT: root}), options);
    }
    assert.deepEqual(await readdir(root), []);
  });

test('concurrent agents keep their own caches while a peer completes', async t => {
  const {dir, root} = await fixture(t);
  const ready = path.join(dir, 'ready'), release = path.join(dir, 'release');
  const pending = runAgent(agent(`
    const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, process.env.TMPDIR);
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('NO NEW FINDINGS'); } }, 10);
  `, {JURY_AGENT_TEMP_ROOT: root}), {...options, timeoutSeconds: 10});
  try {
    await waitFor(() => existsSync(ready));
    const active = await readFile(ready, 'utf8');
    await runAgent(agent(`console.log('NO NEW FINDINGS')`, {JURY_AGENT_TEMP_ROOT: root}), options);
    assert.equal(existsSync(active), true);
    assert.equal((await agentTemps({root, clean: true}))[0].status, 'active');
  } finally { await writeFile(release, ''); await pending; }
  assert.deepEqual(await readdir(root), []);
});

test('cleanup retains unrecognized entries and uncertain launches and never follows symlinks', async t => {
  const {dir, root} = await fixture(t);
  const temp = await createAgentTemp({JURY_AGENT_TEMP_ROOT: root});
  const owned = path.dirname(temp.directory);
  const marker = JSON.parse(await readFile(path.join(owned, 'owner.json'), 'utf8'));
  const child = spawn(process.execPath, ['-e', '']); const pid = child.pid; await once(child, 'exit');
  await writeFile(path.join(owned, 'owner.json'), JSON.stringify({...marker, pid, phase: 'launching'}));
  const outside = path.join(dir, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'untouched'); await chmod(outside, 0o555);
  await symlink(outside, path.join(root, 'agent-link'), 'dir');
  await mkdir(path.join(root, 'agent-unknown'));
  await mkdir(path.join(root, 'agent-bad-marker'));
  await writeFile(path.join(root, 'agent-bad-marker', 'owner.json'), '{broken');
  const entries = await agentTemps({root, clean: true});
  assert.equal(entries.find(e => e.path === owned).status, 'uncertain');
  assert.equal(entries.filter(e => e.status === 'unrecognized').length, 3);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'untouched');
  if (process.platform !== 'win32') assert.equal((await stat(outside)).mode & 0o777, 0o555);
  await chmod(outside, 0o755);
  await temp.dispose();
});

test('temporary roots cannot be symlinks', async t => {
  const {dir, root} = await fixture(t);
  const outside = path.join(dir, 'outside'); await mkdir(outside); await symlink(outside, root, 'dir');
  await assert.rejects(() => createAgentTemp({JURY_AGENT_TEMP_ROOT: root}), /not a symlink/);
  await assert.rejects(() => agentTemps({root, clean: true}), /not a symlink/);
});
