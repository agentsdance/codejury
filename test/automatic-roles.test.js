import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { automaticRoles, automaticReviewers } from '../lib/roles.js';
import { loadConfig } from '../lib/config.js';
import { readEvents } from '../lib/store.js';

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-auto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('automatic selection includes opt-in CLIs and tests both random assignments deterministically', async t => {
  const dir = await fixture(t);
  const cfg = await loadConfig(dir, { globalFile: path.join(dir, 'global.json') });
  const check = async a => ({ ok: ['codex', 'qwen'].includes(a.name) });
  for (const [random, judge, reviewer] of [[0, 'codex', 'qwen'], [0.999, 'qwen', 'codex']]) {
    const roles = await automaticRoles(cfg, { check, random: () => random });
    assert.deepEqual(roles, { judge, reviewers: [reviewer] });
    assert.equal(automaticReviewers(cfg, roles)[0].name, reviewer);
  }
  assert.deepEqual(await automaticRoles(cfg, { check: async a => ({ ok: a.name === 'qwen' }) }),
    { judge: 'qwen', reviewers: ['qwen'] });
  for (const ok of [false, true]) assert.equal(await automaticRoles(cfg, { check: async () => ({ ok }) }), null);
  for (const options of [{ judge: 'codex' }, { reviewers: ['claude'] }, { reviewers: [] }]) {
    assert.equal(await automaticRoles(cfg, { ...options, check: () => assert.fail('must not probe') }), null);
  }
  for (const agents of [[{ name: 'claude', role: 'main' }], [{ name: 'codex', enabled: false }]]) {
    await writeFile(path.join(dir, 'jury.config.json'), JSON.stringify({ agents }));
    assert.equal(await automaticRoles(await loadConfig(dir, { globalFile: path.join(dir, 'global.json') }), { check }), null);
  }
  await rm(path.join(dir, 'jury.config.json'));
  await writeFile(path.join(dir, 'global.json'), JSON.stringify({ judge: 'qwen' }));
  assert.equal(await automaticRoles(await loadConfig(dir, { globalFile: path.join(dir, 'global.json') }), { check }), null);
  const previous = { automaticRoles: { judge: 'qwen', reviewers: ['qwen'] } };
  assert.deepEqual(await automaticRoles(cfg, { previous, check: () => assert.fail('must not probe') }), previous.automaticRoles);
  assert.equal(await automaticRoles(cfg, { previous: { judge: 'codex' }, check }), null);
});

for (const [installed, random, expectedJudge, expectedReviewer] of [
  [['claude'], 0, 'claude', 'claude'],
  [['codex'], 0, 'codex', 'codex'],
  [['codex', 'claude'], 0, 'codex', 'claude'],
  [['codex', 'claude'], 0.999, 'claude', 'codex'],
]) test(`CLI workflow ${installed.join('+')} random=${random}: judge, reply, resume`, async t => {
  const dir = await fixture(t);
  const bin = path.join(dir, 'bin');
  const repo = path.join(dir, 'repo');
  await mkdir(bin); await mkdir(repo); await mkdir(path.join(dir, 'home'));
  for (const name of ['git', 'which']) {
    const { stdout } = await exec('which', [name]);
    await symlink(stdout.trim(), path.join(bin, name));
  }
  // Only these supported CLIs exist on PATH. Every call is a real subprocess,
  // including writable judging and the follow-up reviewer conversation.
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ name: require('node:path').basename(process.argv[1]), args }) + '\\n');
const prompt = args.find(a => a.includes('A code reviewer raised this finding'));
if (prompt) console.log(JSON.stringify({ reproduced: null, verdict: 'rejected', reason: 'fixture disproved', test: null }));
else if (!fs.existsSync('.reviewed')) { fs.writeFileSync('.reviewed', 'yes'); console.log('FINDING: fixture claim\\nWHERE: a.txt:1\\nNeeds checking'); }
else console.log('NO NEW FINDINGS');
`;
  for (const name of installed) await writeFile(path.join(bin, name), script, { mode: 0o755 });
  const preload = path.join(dir, 'random.mjs');
  await writeFile(preload, `Math.random = () => ${random};`);
  const env = { ...process.env, PATH: bin, HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), GIT_CONFIG_GLOBAL: path.join(dir, 'absent'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => exec(path.join(bin, 'git'), ['-C', repo, ...args], { env });
  await git('init', '-q', '-b', 'master');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.com');
  await writeFile(path.join(repo, 'a.txt'), 'before\n');
  await writeFile(path.join(repo, '.gitignore'), '.reviewed\nruns/\n');
  await git('add', '.'); await git('commit', '-qm', 'base'); await git('checkout', '-qb', 'feature');
  await writeFile(path.join(repo, 'a.txt'), 'after\n'); await git('commit', '-qam', 'change');
  const invoke = args => exec(process.execPath, ['--import', preload, cli, ...args], { cwd: repo, env });
  const args = ['review', '--dir', repo, '--trunk', 'master', '--rounds', '2', '--web=false', '--push=false'];
  const review = await invoke(args);
  assert.match(review.stdout, /REVIEW COMPLETE/);
  const announcement = installed.length === 1
    ? `Found 1 code agent: ${expectedJudge}.\n${expectedJudge} will work as both judge and jury.`
    : `Found 2 code agents: ${installed.join(', ')}.\n${expectedJudge} will work as judge, and ${expectedReviewer} will work as jury.`;
  assert.ok(review.stdout.includes(announcement), review.stdout);
  // Anchored on the first round header, which prints before any agent launches:
  // ordering against REVIEW COMPLETE alone also passes if the roles are
  // announced after the agents have already run, which is too late to be useful.
  const firstRound = review.stdout.search(/round 1\b/);
  assert.ok(firstRound > 0, review.stdout);
  assert.ok(review.stdout.indexOf(announcement) < firstRound, review.stdout);

  assert.match(review.stdout, new RegExp(`judge\\s+${expectedJudge}`));
  assert.match(review.stdout, new RegExp(`juries\\s+${expectedReviewer}`));
  const [slug] = await readdir(path.join(repo, 'runs'));
  const runDir = path.join(repo, 'runs', slug);
  let events = await readEvents(runDir);
  assert.ok(events.some(e => e.t === 'finding.resolved' && e.who === expectedJudge));
  assert.ok(events.some(e => e.t === 'reply.answered' && e.agent === expectedReviewer));
  const calls = (await readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const judging = calls.filter(c => c.args.some(a => a.includes('A code reviewer raised this finding')));
  assert.ok(judging.length > 0);
  assert.ok(judging.every(c => c.name === expectedJudge && c.args.includes(expectedJudge === 'codex' ? 'workspace-write' : 'acceptEdits')));
  const reviewing = calls.filter(c => !c.args.some(a => a.includes('A code reviewer raised this finding')));
  assert.ok(reviewing.every(c => c.name === expectedReviewer && c.args.includes(expectedReviewer === 'codex' ? 'read-only' : 'plan')));
  const roles = { judge: expectedJudge, reviewers: [expectedReviewer] };
  assert.deepEqual(events.find(e => e.t === 'target').target.automaticRoles, roles);
  // Change both the random draw and installed CLIs. Neither may reassign a run.
  await writeFile(preload, `Math.random = () => ${random === 0 ? 0.999 : 0};`);
  await writeFile(path.join(bin, 'qwen'), script, { mode: 0o755 });
  // Count events first: asserting over the whole history would be satisfied by
  // the initial review's reply, so a standalone `reply` that answered nobody
  // would still pass.
  const beforeReply = events.length;
  await invoke(['reply', '--dir', repo, '--run', slug]);
  const replied = (await readEvents(runDir)).slice(beforeReply);
  assert.ok(replied.some(e => e.t === 'reply.answered' && e.agent === expectedReviewer),
    JSON.stringify(replied));
  await invoke([...args, '--resume', slug]);
  events = await readEvents(runDir);
  assert.ok(events.filter(e => e.t === 'target').every(e => JSON.stringify(e.target.automaticRoles) === JSON.stringify(roles)));
  assert.ok(events.filter(e => e.t === 'agent.launch' || e.t === 'reply.answered').every(e => e.agent === expectedReviewer));
  if (installed.length === 2) {
    const explicit = await invoke([...args, '--judge', 'codex', '--reviewer', 'claude']);
    assert.match(explicit.stdout, /judge\s+codex/);
    assert.match(explicit.stdout, /juries\s+claude/);
  }
  // A missing saved participant must fail without launching a replacement.
  await rm(path.join(bin, expectedReviewer));
  const beforeMissing = await readFile(path.join(dir, 'calls.jsonl'), 'utf8');
  await assert.rejects(invoke([...args, '--resume', slug]), /not installed/);
  assert.equal(await readFile(path.join(dir, 'calls.jsonl'), 'utf8'), beforeMissing);
  await writeFile(path.join(bin, expectedReviewer), script, { mode: 0o755 });
  // Explicit self-review is still refused outside the automatic fallback.
  await assert.rejects(invoke([...args, '--judge', expectedJudge, '--reviewer', expectedJudge]), /cannot review its own work/);
});
