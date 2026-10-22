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
import {fileURLToPath, pathToFileURL} from 'node:url';
import {testEnvironment} from '../scripts/test-environment.mjs';

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

for (const code of [0, 1]) test(`agent-created temporary caches are removed after exit ${code} only when tree termination is confirmed`, async t => {
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
    `, {JURY_AGENT_TEMP_ROOT: root, GOCACHE: '', GOMODCACHE: ''}), options);
    const env = JSON.parse(result.raw.split('\n')[0]);
    t.after(() => rm(env.cache, {recursive: true, force: true}));
    assert.equal(result.ok, code === 0);
    assert.equal(existsSync(env.cache), process.platform === 'win32', 'retain caches when descendant termination cannot be confirmed');
    assert.ok(env.tmp.startsWith(root + path.sep));
    assert.ok(env.build.startsWith(root + path.sep));
    assert.ok(env.modules.startsWith(root + path.sep));
    assert.equal((await readdir(root)).length, process.platform === 'win32' ? iteration + 1 : 0);
  }
});

for (const inherited of ['GOCACHE', 'GOMODCACHE', 'both']) test(`default-cache fixtures ignore inherited ${inherited}`, async t => {
  const {dir} = await fixture(t);
  const build = path.join(dir, 'external-build'), modules = path.join(dir, 'external-modules');
  await mkdir(build); await mkdir(modules);
  await writeFile(path.join(build, 'keep'), 'build');
  await writeFile(path.join(modules, 'keep'), 'modules');
  const env = {...process.env,
    GOCACHE: inherited === 'GOMODCACHE' ? '' : build,
    GOMODCACHE: inherited === 'GOCACHE' ? '' : modules};
  delete env.NODE_TEST_CONTEXT; // Run the selected fixtures in a fresh test coordinator.
  const {stdout} = await exec(process.execPath, ['--test', '--test-reporter=tap',
    '--test-name-pattern=^agent-created temporary caches', fileURLToPath(import.meta.url)], {env})
    .catch(error => assert.fail(error.stdout || error.message));
  assert.match(stdout, /# pass 2\b/);
  assert.equal(await readFile(path.join(build, 'keep'), 'utf8'), 'build');
  assert.equal(await readFile(path.join(modules, 'keep'), 'utf8'), 'modules');
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
  assert.equal((await readdir(root)).length, process.platform === 'win32' ? 1 : 0);
});

test('file-delivered prompts follow cache cleanup and failed launches add no temporary directories', async t => {
  const {root} = await fixture(t);
  const result = await runAgent({name: 'file-fixture', cwd: 'worktree', report: 'whole',
    promptDelivery: 'file', env: {JURY_AGENT_TEMP_ROOT: root},
    argv: [process.execPath, '-e', `console.log(require('node:fs').readFileSync(process.argv[1], 'utf8')); console.log('NO NEW FINDINGS')`, '{{promptFile}}'],
  }, options);
  assert.equal(result.ok, true); assert.match(result.raw, /^test\n/);
  assert.equal((await readdir(root)).length, process.platform === 'win32' ? 1 : 0);
  const failed = await runAgent({...agent('', {JURY_AGENT_TEMP_ROOT: root}), argv: ['/jury-missing-agent']}, options);
  assert.equal(failed.ok, false);
  assert.equal((await readdir(root)).length, process.platform === 'win32' ? 1 : 0);
});

test('cache initialization failures return agent errors and preserve known sessions', async t => {
  const {dir, root} = await fixture(t);
  await writeFile(root, 'not a directory');
  const launched = path.join(dir, 'launched');
  for (const sessionId of [null, 'existing-session']) {
    const result = await runAgent(agent(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'unexpected')`,
      {JURY_AGENT_TEMP_ROOT: root}), {...options, sessionId});
    assert.equal(result.agent, 'fixture');
    assert.equal(result.ok, false);
    assert.equal(result.verdict, 'error');
    assert.match(result.report, /Could not initialize temporary cache:/);
    assert.ok(result.report.includes(root));
    assert.equal(result.sessionId, sessionId);
    assert.deepEqual(result.findings, []);
    assert.equal(result.raw, '');
    assert.ok(Number.isFinite(result.seconds) && result.seconds >= 0);
    assert.equal(existsSync(launched), false);
  }
});

test('cache initialization failure records an error while a running peer finishes', {
  skip: process.platform === 'win32' || process.getuid?.() === 0, timeout: 20000,
}, async t => {
  const {dir, root} = await fixture(t);
  const repo = path.join(dir, 'repo'), denied = path.join(dir, 'denied');
  const ready = path.join(dir, 'peer-ready'), finished = path.join(dir, 'peer-finished');
  const launched = path.join(dir, 'blocked-launched');
  await mkdir(repo); await mkdir(denied); await chmod(denied, 0o555);
  const isolated = testEnvironment();
  t.after(() => isolated.dispose());
  try {
    const git = (...args) => exec('git', args, {cwd: repo, env: isolated.env});
    await git('init', '-q', '-b', 'master');
    await git('commit', '--allow-empty', '-qm', 'base');
    await git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    await writeFile(path.join(repo, 'jury.config.json'), JSON.stringify({agents: [
      {...agent(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'unexpected')`,
        {JURY_AGENT_TEMP_ROOT: denied}), name: 'blocked', role: 'reviewer'},
      {...agent(`
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        setTimeout(() => {
          fs.writeFileSync(${JSON.stringify(finished)}, 'complete');
          console.log('NO NEW FINDINGS');
        }, 300);
      `, {JURY_AGENT_TEMP_ROOT: root}), name: 'peer', role: 'reviewer'},
      {...agent(`throw Error('judge must not run')`), name: 'fixture-judge', role: 'main'},
    ]}));
    const gate = path.join(dir, 'wait-for-peer.mjs');
    await writeFile(gate, `
      import fs from 'node:fs/promises';
      import {existsSync} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {setTimeout as delay} from 'node:timers/promises';
      const mkdtemp = fs.mkdtemp;
      fs.mkdtemp = async (...args) => {
        if (String(args[0]) === ${JSON.stringify(path.join(denied, 'agent-'))}) {
          const deadline = Date.now() + 10000;
          while (!existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) await delay(10);
        }
        return mkdtemp(...args); // The real filesystem rejects the unwritable root.
      };
      syncBuiltinESMExports();
    `);
    const result = await exec(process.execPath, ['--import', pathToFileURL(gate).href, cli, 'review',
      '--dir', repo, '--trunk', 'master', '--agents', 'blocked,peer', '--judge', 'fixture-judge',
      '--rounds', '1', '--web=false', '--push=false'], {cwd: repo, env: isolated.env, timeout: 15000})
      .catch(error => { if (error.killed) throw error; return error; });
    assert.equal(result.code, 1, 'an incomplete review must still exit unsuccessfully');
    assert.equal(existsSync(ready), true, `the peer must be running before initialization fails\n${result.stdout}\n${result.stderr}`);
    const [slug] = await readdir(path.join(repo, 'runs'));
    const runDir = path.join(repo, 'runs', slug);
    const saved = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(saved.target.state, 'human', result.stderr);
    assert.match(saved.target.stateNote, /reviewers failed: blocked/);
    assert.equal(existsSync(finished), true, 'the healthy peer must finish its work');
    assert.equal(existsSync(launched), false, 'the reviewer with no cache must not launch');
    const events = (await readFile(path.join(runDir, 'events.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    const reports = events.filter(event => event.t === 'agent.report');
    assert.equal(reports.length, 2);
    assert.equal(reports.find(report => report.agent === 'peer').verdict, 'clean');
    const failed = reports.find(report => report.agent === 'blocked');
    assert.equal(failed.verdict, 'error');
    assert.match(failed.report, /EACCES/);
    assert.ok(events.some(event => event.t === 'round.end'));
  } finally { await chmod(denied, 0o755); }
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

for (const recovery of ['cache clean', 'startup']) test(`interrupted cache deletion remains reclaimable by ${recovery}`, async t => {
  const {dir, root} = await fixture(t);
  const paused = path.join(dir, 'paused.json');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    import {createAgentTemp} from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'lib/agent-temp.js')).href)};
    const temp = await createAgentTemp({JURY_AGENT_TEMP_ROOT: ${JSON.stringify(root)}});
    const owned = path.dirname(temp.directory);
    const marker = path.join(owned, 'owner.json');
    const cache = path.join(temp.directory, 'go-build', 'compiled');
    fs.writeFileSync(cache, 'unfinished cache deletion');

    // Hold one real unlink while the other recursive-rm operations complete.
    // If rm includes the container, wait for its real marker unlink before
    // reporting the interruption point; content-only deletion keeps the marker.
    let removingContainer = false, markerRemoved = false, blocked = false;
    const report = () => {
      if (blocked && (!removingContainer || markerRemoved)) {
        fs.writeFileSync(${JSON.stringify(paused + '.next')}, JSON.stringify({owned, cache}));
        fs.renameSync(${JSON.stringify(paused + '.next')}, ${JSON.stringify(paused)});
      }
    };
    const rmdir = fs.rmdir, unlink = fs.unlink;
    fs.rmdir = (target, ...args) => {
      if (String(target) === owned) removingContainer = true;
      return rmdir(target, ...args);
    };
    fs.unlink = (target, callback) => {
      if (String(target) === cache) { blocked = true; report(); return; }
      return unlink(target, error => {
        if (!error && String(target) === marker) { markerRemoved = true; report(); }
        callback(error);
      });
    };
    setInterval(() => {}, 1000);
    await temp.dispose();
  `], {stdio: ['ignore', 'ignore', 'pipe']});
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await waitFor(() => existsSync(paused) || child.exitCode !== null);
    assert.equal(existsSync(paused), true, stderr || 'cleanup must reach the interrupted unlink');
    child.kill('SIGKILL'); await exited;
    const {owned, cache} = JSON.parse(await readFile(paused, 'utf8'));
    assert.equal(await readFile(cache, 'utf8'), 'unfinished cache deletion');
    assert.equal((await agentTemps({root}))[0].status, 'stale', 'interruption must not orphan the remaining cache as unrecognized');
    assert.equal(existsSync(path.join(owned, 'owner.json')), true, 'ownership must survive until cache deletion completes');
    if (recovery === 'cache clean') {
      const result = await exec(process.execPath, [cli, 'cache', 'clean'], {env: {...process.env, JURY_AGENT_TEMP_ROOT: root}});
      assert.match(result.stdout, /removed/);
    } else {
      const next = await createAgentTemp({JURY_AGENT_TEMP_ROOT: root});
      await next.dispose();
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    child.kill('SIGKILL'); await exited;
  }
});

for (const code of [0, 1]) test(`Windows cleanup retains caches used by descendants after reviewer exit ${code}`, async t => {
  const {dir, root} = await fixture(t);
  const ready = path.join(dir, 'ready.json'), release = path.join(dir, 'release');
  const outcome = path.join(dir, 'outcome');
  const background = `
    const fs = require('node:fs'), path = require('node:path');
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid: process.pid, cache: process.env.GOCACHE}));
    process.send('ready');
    const poll = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(poll);
      let result = 'compiled';
      try { fs.writeFileSync(path.join(process.env.GOCACHE, 'compiled'), 'cache content'); }
      catch (error) { result = error.code; }
      fs.writeFileSync(${JSON.stringify(outcome + '.next')}, result);
      fs.renameSync(${JSON.stringify(outcome + '.next')}, ${JSON.stringify(outcome)});
    }, 10);
    setTimeout(() => process.exit(), 30000);
  `;
  const definition = agent(`
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(background)}],
      {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    child.once('message', () => {
      console.log('pid=' + process.pid);
      console.log('NO NEW FINDINGS');
      child.disconnect(); child.unref(); process.exitCode = ${code};
    });
  `, {JURY_AGENT_TEMP_ROOT: root, GOCACHE: '', GOMODCACHE: ''});
  try {
    const {stdout} = await exec(process.execPath, ['--input-type=module', '-e', `
      // Select the Windows lifecycle on POSIX hosts, keeping real processes and IO.
      Object.defineProperty(process, 'platform', {value: 'win32'});
      const {runAgent} = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'lib/agents.js')).href)});
      const logs = [];
      const result = await runAgent(${JSON.stringify(definition)},
        {...${JSON.stringify(options)}, onLog: message => logs.push(message)});
      console.log(JSON.stringify({result, logs}));
    `], {timeout: 10000});
    const {result, logs} = JSON.parse(stdout);
    const {pid, cache} = JSON.parse(await readFile(ready, 'utf8'));
    assert.equal(result.ok, code === 0);
    assert.equal(result.timedOut, undefined);
    assert.equal(running(Number(result.raw.match(/pid=(\d+)/)[1])), false, 'the reviewer has exited');
    assert.equal(running(pid), true, 'its ordinary background descendant is still running');
    await writeFile(release, '');
    await waitFor(() => existsSync(outcome));
    assert.equal(await readFile(outcome, 'utf8'), 'compiled', 'cleanup must not break a live descendant\'s cache writes');
    assert.equal(await readFile(path.join(cache, 'compiled'), 'utf8'), 'cache content');
    assert.ok(logs.some(message => message.includes('Temporary cache retained')));

    const clean = await exec(process.execPath, [cli, 'cache', 'clean'], {env: {...process.env, JURY_AGENT_TEMP_ROOT: root}});
    assert.match(clean.stdout, /uncertain/);
    const next = await createAgentTemp({JURY_AGENT_TEMP_ROOT: root});
    await next.dispose();
    assert.equal(existsSync(cache), true, 'explicit and startup cleanup must also retain an unverified Windows tree');
  } finally {
    if (existsSync(ready)) {
      const {pid} = JSON.parse(await readFile(ready, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitFor(() => !running(pid));
    }
  }
});

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
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(ready + '.next')}, process.env.TMPDIR);
    fs.renameSync(${JSON.stringify(ready + '.next')}, ${JSON.stringify(ready)});
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('NO NEW FINDINGS'); } }, 10);
  `, {JURY_AGENT_TEMP_ROOT: root}), {...options, timeoutSeconds: 10});
  try {
    await waitFor(() => existsSync(ready));
    const active = await readFile(ready, 'utf8');
    await runAgent(agent(`console.log('NO NEW FINDINGS')`, {JURY_AGENT_TEMP_ROOT: root}), options);
    assert.equal(existsSync(active), true);
    assert.equal((await agentTemps({root, clean: true}))[0].status, 'active');
  } finally { await writeFile(release, ''); await pending; }
  assert.equal((await readdir(root)).length, process.platform === 'win32' ? 2 : 0);
});

for (const [signal, pattern, count] of [
  ['ready', '^concurrent agents keep their own caches', 1],
  ['outcome', '^Windows cleanup retains caches used by descendants', 2],
]) test(`cache fixtures publish ${signal} only after writing completes`, async t => {
  const {dir} = await fixture(t);
  const preload = path.join(dir, 'pause-signal-write.cjs'), observed = path.join(dir, 'observed');
  await writeFile(preload, `
    const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path');
    const write = fs.writeFileSync, exists = fs.existsSync, read = fsp.readFile;
    const signal = file => typeof file === 'string' && path.basename(file) === ${JSON.stringify(signal)};
    const wait = file => {
      const deadline = Date.now() + 5000;
      while (!exists(file)) {
        if (Date.now() >= deadline) throw Error('Signal handshake timed out: ' + file);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    };
    const release = file => {
      if (!exists(file + '.observed')) {
        fs.appendFileSync(${JSON.stringify(observed)}, 'observed\\n');
        write(file + '.observed', '');
      }
    };
    // Pause after the real open creates an empty file, before any data is written.
    // Exercise both direct writes and writes staged for an atomic rename.
    fs.writeFileSync = (file, ...args) => {
      const published = typeof file === 'string' ? file.replace(/\\.next$/, '') : file;
      if (!signal(published)) return write(file, ...args);
      const fd = fs.openSync(file, 'w');
      try {
        write(published + '.opened', '');
        wait(published + '.observed');
        return write(fd, ...args);
      } finally { fs.closeSync(fd); }
    };
    fs.existsSync = file => {
      const writing = signal(file) && exists(file + '.opened');
      const found = exists(file);
      if (writing && !found) release(file);
      return found;
    };
    fsp.readFile = async (file, ...args) => {
      const contents = await read(file, ...args);
      if (signal(file)) { wait(file + '.opened'); release(file); }
      return contents;
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const env = {...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`};
  delete env.NODE_TEST_CONTEXT;
  const {stdout} = await exec(process.execPath, ['--test', '--test-reporter=tap',
    '--test-name-pattern=' + pattern, fileURLToPath(import.meta.url)], {env, timeout: 20000})
    .catch(error => assert.fail(error.stdout || error.message));
  assert.match(stdout, new RegExp('# pass ' + count + '\\b'));
  assert.equal((await readFile(observed, 'utf8')).trim().split('\n').length, count,
    'each fixture must probe its signal while the writer is paused');
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
