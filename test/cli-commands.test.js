// Behavioral command coverage: separate processes, real persisted state, isolated HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const packageRoot = path.dirname(path.dirname(cli));
const { DEFAULTS } = await import(pathToFileURL(path.join(packageRoot, 'lib/config.js')));
const { appendEvent, readEvents, writeRun, foldEvents } = await import(pathToFileURL(path.join(packageRoot, 'lib/store.js')));
const { conversation, sessionsIn } = await import(pathToFileURL(path.join(packageRoot, 'lib/loop.js')));

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
  git("update-ref", "refs/remotes/origin/master", "HEAD");
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

async function replyFixture(t, reviewer) {
  const f = await fixture(t);
  const { cwd, env } = f;
  const git = (...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'master');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base');
  const agents = [
    { name: 'good', role: 'reviewer', argv: [process.execPath, '-e', "console.log('NO NEW FINDINGS')"] },
    { name: 'other', role: 'reviewer', ...reviewer },
  ];
  await writeFile(path.join(cwd, 'jury.config.json'), JSON.stringify({ agents: [
    ...DEFAULTS.agents.map(a => ({ name: a.name, enabled: false })),
    { name: 'fixture-judge', role: 'main', argv: [process.execPath, '-e', "throw new Error('judge must not run')"] },
    ...agents,
  ] }));
  const dir = path.join(cwd, 'runs', 'reply-fixture');
  await appendEvent(dir, { t: 'target', target: { repo: 'fixture', id: '#1', judge: 'fixture-judge' } });
  for (const a of agents) {
    await appendEvent(dir, { t: 'finding.raised', id: a.name, agent: a.name, round: 1, claim: `${a.name} claim`, loc: 'file.js:1' });
    await appendEvent(dir, { t: 'finding.resolved', id: a.name, verdict: 'rejected', reason: 'Fixture checked' });
  }
  const reply = (args = [], status = 0) => f.run(['reply', '--dir', cwd, '--run', 'reply-fixture', ...args], status);
  return { ...f, dir, reply };
}

for (const [label, reviewer, diagnostic] of [
  ['nonzero exit', { argv: [process.execPath, '-e', "console.error('fixture authentication expired'); process.exitCode = 7"] }, /fixture authentication expired/],
  ['missing executable', { argv: ['jury-missing-reply-executable-fixture'] }, /ENOENT/],
  ['invalid structured result', { argv: [process.execPath, '-e', "console.log('not JSON')"], report: 'result-json' }, /Invalid agent JSON output/],
]) {
  test(`reply returns failure for ${label} after preserving every reviewer's answer`, async t => {
    const { dir, reply } = await replyFixture(t, reviewer);
    const result = reply([], 1);
    assert.match(result.stderr, /repl(?:y|ies).*failed.*other/i);
    assert.match(result.stdout, diagnostic);
    const events = await readEvents(dir);
    const answers = events.filter(e => e.t === 'reply.answered');
    assert.equal(answers.length, 2, 'a failed reply must not prevent other replies from being recorded');
    assert.equal(answers.find(e => e.agent === 'good').verdict, 'clean');
    assert.equal(answers.find(e => e.agent === 'other').verdict, 'error');
    const saved = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
    assert.equal(saved.replies.length, 2, 'folded results must be published before returning failure');
    assert.match(await readFile(path.join(dir, 'reply.good.stdout.txt'), 'utf8'), /NO NEW FINDINGS/);
    await readFile(path.join(dir, 'reply.other.stdout.txt'), 'utf8');
  });
}

test('reply succeeds when a reviewer answers with remaining findings', async t => {
  const { dir, reply } = await replyFixture(t, {
    argv: [process.execPath, '-e', "console.log('FINDING: still broken\\nWHERE: file.js:1\\n\\nPlease check again.')"],
  });
  reply();
  const answers = (await readEvents(dir)).filter(e => e.t === 'reply.answered');
  assert.equal(answers.find(e => e.agent === 'other').verdict, 'found');
});

test('reply preserves each judge prompt in the saved conversation', async t => {
  const { dir, reply } = await replyFixture(t, {
    argv: [process.execPath, '-e', "console.log('NO NEW FINDINGS')"],
  });
  reply();
  const events = await readEvents(dir);
  const sent = events.filter(e => e.t === 'reply.sent');
  assert.equal(sent.length, 2);
  const threads = conversation(events);
  for (const agent of ['good', 'other']) {
    const prompt = await readFile(path.join(dir, `reply.${agent}.md`), 'utf8');
    assert.match(prompt, new RegExp(`${agent} claim`));
    assert.doesNotMatch(prompt, new RegExp(`${agent === 'good' ? 'other' : 'good'} claim`));
    assert.equal(sent.find(e => e.agent === agent).text, prompt, 'persist the prompt actually sent to this reviewer');
    const turns = threads.find(thread => thread.agent === agent).turns;
    const replies = turns.filter(turn => turn.kind === 'reply');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].who, 'fixture-judge');
    assert.equal(replies[0].text, prompt, 'a replay must show the judge reply rather than an empty turn');
    assert.match(turns.find(turn => turn.kind === 'answer').text, /NO NEW FINDINGS/);
  }
});

test('a late standalone reply cannot replace a newer review session', async t => {
  const gate = path.join(tmpdir(), `jury-reply-gate-${process.pid}-${Date.now()}`);
  t.after(() => rm(gate, { force: true }));
  const script = `const fs=require('node:fs'); const gate=process.argv[1]; const done=()=>{if(fs.existsSync(gate)){console.log('NO NEW FINDINGS'); return true}}; if(!done()) { const timer=setInterval(()=>{if(done()) clearInterval(timer)}, 10) }`;
  const { cwd, env, dir } = await replyFixture(t, {
    argv: [process.execPath, '-e', "console.log('NO NEW FINDINGS')"],
    resume: { supported: true, argv: [process.execPath, '-e', script, gate, '{{sessionId}}'] },
  });
  await appendEvent(dir, { t: 'agent.report', agent: 'other', sessionId: 'session-a' });
  const sessionCursor = (await readEvents(dir)).length;

  const child = spawn(process.execPath, [cli, 'reply', '--dir', cwd, '--run', 'reply-fixture'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });

  let result;
  try {
    const deadline = Date.now() + 5000;
    while (!(await readEvents(dir)).some(e => e.t === 'reply.sent' && e.agent === 'other')) {
      if (Date.now() > deadline) assert.fail('standalone reply did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await appendEvent(dir, { t: 'agent.report', agent: 'other', sessionId: 'session-b' });
  } finally {
    // Release the fake reviewer even if an assertion fails before the race.
    await writeFile(gate, 'continue');
    result = await completed;
  }
  assert.equal(result.status, 0, JSON.stringify(result));

  const events = await readEvents(dir);
  assert.equal(events.find(e => e.t === 'reply.sent' && e.agent === 'other').sessionCursor, sessionCursor);
  assert.equal(sessionsIn(events).get('other'), 'session-b');
});

test('reply dry-run prepares prompts without launching a failing executable', async t => {
  const { dir, reply } = await replyFixture(t, { argv: ['jury-missing-reply-executable-fixture'] });
  reply(['--dry-run']);
  assert.ok(!(await readEvents(dir)).some(e => e.t.startsWith('reply.')));
  assert.match(await readFile(path.join(dir, 'reply.other.md'), 'utf8'), /other claim/);
});
