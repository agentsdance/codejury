// Behavioral command coverage: separate processes, real persisted state, isolated HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const packageRoot = path.dirname(path.dirname(cli));
const { DEFAULTS } = await import(pathToFileURL(path.join(packageRoot, 'lib/config.js')));
const { appendEvent, readEvents, writeRun, foldEvents } = await import(pathToFileURL(path.join(packageRoot, 'lib/store.js')));

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'jury-commands-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'repo'); await mkdir(cwd);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const run = (args, status = 0, at = cwd) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: at, env, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    assert.equal(result.status, status, JSON.stringify({ args, stdout: result.stdout, stderr: result.stderr }));
    return result;
  };
  return { home, cwd, env, run };
}

test('help and version: every topic, alias, empty invocation, and invalid command', async t => {
  const { run } = await fixture(t);
  const version = JSON.parse(await readFile(path.join(packageRoot, 'package.json'))).version;
  for (const cmd of ['version', '-v', '--version']) assert.equal(run([cmd]).stdout.trim(), `jury ${version}`);
  const short = run([]).stdout;
  assert.match(short, /jury review/);
  for (const cmd of ['help', '-h', '--help']) assert.equal(run([cmd]).stdout, short);
  const full = run(['help', '--all']).stdout;
  assert.match(full, /finding reproduce/);
  for (const flag of ['-a', 'all']) assert.equal(run(['help', flag]).stdout, full);
  for (const topic of ['review', 'agent', 'finding', 'findings', 'reply', 'runs', 'agents', 'version', 'help']) {
    const output = run(['help', topic]).stdout;
    assert.match(output, /jury/);
    for (const flag of ['--help', '-h']) assert.equal(run([topic, flag]).stdout, output);
  }
  assert.match(run(['unknown-command'], 2).stderr, /unknown command/);
  assert.match(run(['help', 'unknown-topic'], 2).stderr, /unknown help topic/);
});

test('agents judge: every built-in survives set/get in another directory, listing, and reset', async t => {
  const { home, cwd, run } = await fixture(t);
  const second = path.join(home, 'other'); await mkdir(second);
  // Stub executable discovery only. No provider is launched by these commands.
  await writeFile(path.join(cwd, 'jury.config.json'), JSON.stringify({ agents: DEFAULTS.agents.map(a => ({ name: a.name, argv: [process.execPath] })) }));
  assert.match(run(['agents', 'judge']).stdout, /Global judge: not set/);
  for (const { name } of DEFAULTS.agents) {
    assert.match(run(['agents', 'judge', name]).stdout, new RegExp(`Global judge: ${name} \\(`));
    assert.equal(run(['agents', 'judge'], 0, second).stdout.trim(), `Global judge: ${name}`);
    assert.match(run(['agents']).stdout, new RegExp(`ok\\s+${name}\\s+main\\s`));
    assert.match(run(['agents', 'judge', '--reset']).stdout, /Global judge reset/);
    assert.match(run(['agents', 'judge'], 0, second).stdout, /Global judge: not set/);
  }
  run(['agents', 'judge', 'claude']);
  assert.match(run(['agents', 'judge', 'nonexistent'], 1).stderr, /Unknown or disabled judge/);
  assert.equal(run(['agents', 'judge']).stdout.trim(), 'Global judge: claude');
  for (const args of [['agents', 'unknown'], ['agents', 'judge', 'claude', 'extra']]) assert.match(run(args, 1).stderr, /Usage:/);
  for (const flag of ['--help', '-h']) assert.match(run(['agents', 'judge', flag]).stdout, /set the global default/);
  await writeFile(path.join(cwd, 'jury.config.json'), JSON.stringify({ agents: DEFAULTS.agents.map(a => ({ name: a.name, enabled: a.name === 'codex', argv: ['jury-nonexistent-command-fixture'] })) }));
  assert.match(run(['agents'], 1).stdout, /MISSING\s+codex/);
});

test('finding lifecycle and runs: outputs reflect persisted mutations and rejected operations do not mutate', async t => {
  const { cwd, run } = await fixture(t);
  assert.match(run(['runs', '--dir', cwd]).stdout, /no runs yet/);
  const dir = path.join(cwd, 'runs', 'example-1');
  await appendEvent(dir, { t: 'target', target: { repo: 'example', id: '#1', title: 'Command coverage', judge: 'codex' } });
  await writeRun(dir, foldEvents(await readEvents(dir), { target: { repo: 'example', id: '#1', title: 'Command coverage', judge: 'codex' } }));
  const finding = (args, status = 0, command = 'finding') => run([command, ...args, '--dir', cwd, '--run', 'example-1'], status);
  assert.match(finding(['list']).stdout, /no findings/);
  assert.match(finding(['settled']).stdout, /nothing settled/);
  for (const verdict of ['accepted', 'deferred', 'rejected', 'superseded']) {
    await appendEvent(dir, { t: 'finding.raised', id: verdict, agent: 'claude', round: 1, claim: `Claim ${verdict}`, loc: 'file.js:1' });
  }
  assert.match(finding(['list']).stdout, /accepted\s+open\s+unverified\s+claude\s+Claim accepted/);
  assert.equal(finding(['list'], 0, 'findings').stdout, finding(['list']).stdout);
  const before = await readFile(path.join(dir, 'events.ndjson'), 'utf8');
  for (const args of [['reproduce'], ['reproduce', 'missing', '--evidence', 'proof'], ['reproduce', 'accepted'], ['resolve'], ['resolve', 'missing', '--verdict', 'rejected'], ['resolve', 'accepted', '--verdict', 'invalid'], ['resolve', 'accepted', '--verdict', 'accepted'], ['unknown']]) finding(args, 1);
  assert.equal(await readFile(path.join(dir, 'events.ndjson'), 'utf8'), before);
  assert.match(finding(['reproduce', 'accepted', '--evidence', 'Observed failing assertion']).stdout, /accepted: reproduction recorded/);
  assert.match(finding(['resolve', 'accepted', '--verdict', 'accepted'], 1).stderr, /needs --test/);
  assert.match(finding(['list']).stdout, /accepted\s+open\s+reproduced/);
  for (const verdict of ['accepted', 'deferred', 'rejected', 'superseded']) {
    assert.match(finding(['resolve', verdict, '--verdict', verdict, '--reason', `Reason ${verdict}`, ...(verdict === 'accepted' ? ['--test', 'Fails before fix, passes after'] : [])]).stdout, new RegExp(`${verdict}: ${verdict}`));
    assert.match(finding(['list']).stdout, new RegExp(`${verdict}\\s+${verdict}\\s`));
  }
  const settled = finding(['settled']).stdout;
  assert.match(settled, /Claim accepted/);
  assert.equal(await readFile(path.join(dir, 'settled.md'), 'utf8'), settled);
  const events = await readEvents(dir);
  assert.equal(events.filter(e => e.t === 'finding.resolved').length, 4);
  assert.equal(events.find(e => e.t === 'finding.reproduced').evidence, 'Observed failing assertion');
  const runs = run(['runs', '--dir', cwd]).stdout;
  assert.match(runs, /example-1/); assert.match(runs, /4 finding\(s\)/); assert.match(runs, /Command coverage/);
});

test('review and agent/bare-flag aliases run subprocess reviewers and persist completed runs', async t => {
  const { cwd, env, run } = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'master');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  await writeFile(path.join(cwd, 'jury.config.json'), JSON.stringify({ agents: [
    ...DEFAULTS.agents.map(a => ({ name: a.name, enabled: false })),
    { name: 'fixture-judge', role: 'main', argv: [process.execPath, '-e', "console.log('NO NEW FINDINGS')"] },
    { name: 'fixture-reviewer', role: 'reviewer', argv: [process.execPath, '-e', "console.log('NO NEW FINDINGS')"] },
  ] }));
  for (const prefix of [['review'], ['agent'], []]) {
    await rm(path.join(cwd, 'runs'), { recursive: true, force: true });
    assert.match(run([...prefix, '--dir', cwd, '--trunk', 'master', '--web=false', '--push=false', '--rounds', '1']).stdout, /REVIEW COMPLETE/);
  }
  assert.match(run(['runs', '--dir', cwd]).stdout, /1 round\(s\)/);
  assert.match(run(['reply', '--dir', cwd], 1).stderr, /nothing to reply about/);
});
