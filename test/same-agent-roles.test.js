import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readEvents } from '../lib/store.js';
import { sessionsIn, judgeSessionIn, conversation } from '../lib/loop.js';

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
test('explicit same-agent selection isolates Codex roles, permissions, replies and persisted resume with other CLIs installed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jury-same-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), repo = path.join(root, 'repo'), home = path.join(root, 'home');
  await Promise.all([bin, repo, home].map(p => mkdir(p)));
  for (const name of ['git', 'which']) {
    const { stdout } = await exec('which', [name]);
    await symlink(stdout.trim(), path.join(bin, name));
  }
  const callsFile = path.join(root, 'calls.jsonl');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = args.at(-1);
const judging = prompt.includes('A code reviewer raised this finding');
const replying = prompt.startsWith('Thanks —');
let n = Number(fs.existsSync('.reviews') ? fs.readFileSync('.reviews', 'utf8') : 0);
if (!judging && !replying) fs.writeFileSync('.reviews', String(++n));
const session = judging ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-bbbb-bbbb-' + String(n).padStart(12, '0');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ name: require('node:path').basename(process.argv[1]), args, judging, replying, session }) + '\\n');
console.log('session id: ' + session);
if (judging) { console.log('JUDGE_PRIVATE_SESSION_CONTEXT'); console.log(JSON.stringify({ reproduced: null, verdict: 'rejected', reason: 'Public verdict only', test: null })); }
else if (replying) console.log('NO NEW FINDINGS');
else console.log('FINDING: claim ' + n + ' A\\nWHERE: a.txt:1\\nFirst concern\\n\\nFINDING: claim ' + n + ' B\\nWHERE: a.txt:2\\nSecond concern');
`;
  for (const name of ['codex', 'claude', 'grok']) await writeFile(path.join(bin, name), script, { mode: 0o755 });
  const env = { ...process.env, PATH: bin, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(root, 'absent'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => exec(path.join(bin, 'git'), ['-C', repo, ...args], { env });
  await git('init', '-q', '-b', 'master');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.com');
  await writeFile(path.join(repo, 'a.txt'), 'before\n');
  await writeFile(path.join(repo, '.gitignore'), '.reviews\nruns/\n');
  await git('add', '.'); await git('commit', '-qm', 'base'); await git('checkout', '-qb', 'feature');
  await writeFile(path.join(repo, 'a.txt'), 'after\n'); await git('commit', '-qam', 'change');
  const invoke = args => exec(process.execPath, [cli, ...args], { cwd: repo, env });
  const args = ['review', '--dir', repo, '--trunk', 'master', '--rounds', '1', '--web=false', '--push=false'];
  const roles = ['--judge', 'codex', '--reviewer', 'codex'];
  const first = await invoke([...args, ...roles]);
  assert.match(first.stdout, /codex selected as judge and reviewer in separate sessions/);
  assert.match(first.stdout, /REVIEW COMPLETE/);
  const [slug] = await readdir(path.join(repo, 'runs'));
  const dir = path.join(repo, 'runs', slug);
  let events = await readEvents(dir);
  const saved = { judge: 'codex', reviewers: ['codex'] };
  assert.deepEqual(events.find(e => e.t === 'target').target.sameAgentRoles, saved);
  const judgeId = judgeSessionIn(events, 'codex');
  const reviewerId = sessionsIn(events).get('codex');
  assert.ok(judgeId); assert.ok(reviewerId); assert.notEqual(judgeId, reviewerId);
  await invoke(['reply', '--dir', repo, '--run', slug]);
  await invoke([...args, '--resume', slug]);
  events = await readEvents(dir);
  assert.ok(events.filter(e => e.t === 'target').every(e => JSON.stringify(e.target.sameAgentRoles) === JSON.stringify(saved)));
  assert.equal(judgeSessionIn(events, 'codex'), judgeId);
  assert.notEqual(sessionsIn(events).get('codex'), reviewerId);
  const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(c => c.name === 'codex'));
  const judgments = calls.filter(c => c.judging);
  assert.equal(judgments.length, 4);
  assert.ok(!judgments[0].args.includes('resume'));
  assert.ok(judgments.slice(1).every(c => c.args.includes('resume') && c.args.includes(judgeId)));
  for (const c of calls) {
    assert.ok(c.args.includes(c.judging ? 'workspace-write' : 'read-only'));
    if (!c.judging) assert.ok(!c.args.includes(judgeId));
    if (!c.judging && !c.replying) {
      assert.ok(!c.args.includes('resume'));
      assert.ok(!c.args.at(-1).includes('A code reviewer raised this finding'));
      assert.ok(!c.args.at(-1).includes('JUDGE_PRIVATE_SESSION_CONTEXT'));
    }
  }
  const replies = calls.filter(c => c.replying);
  assert.equal(replies.length, 3);
  assert.ok(replies.slice(0, 2).every(c => c.args.includes(reviewerId)));
  assert.ok(replies[2].args.includes(sessionsIn(events).get('codex')));
  // Role attribution must survive a later reviewer rebuttal with the judge's name.
  const raised = events.find(e => e.t === 'finding.raised');
  const rebuttal = { t: 'finding.turn', id: raised.id, who: 'codex', agent: 'codex', text: 'Still incorrect' };
  const folded = conversation([...events, rebuttal]);
  assert.ok(folded.flatMap(t => t.turns).some(t => t.kind === 'rebuttal' && t.judging === false));
  // Repeating explicit role flags needs no additional opt-in.
  await invoke([...args, '--resume', slug, ...roles]);
  // A distinct configured judge still accepts Codex as reviewer.
  await writeFile(path.join(repo, 'jury.config.json'), JSON.stringify({ agents: [{ name: 'grok', role: 'main' }] }));
  const distinct = await invoke([...args, '--judge', 'grok', '--reviewer', 'codex']);
  assert.match(distinct.stdout, /judge\s+grok/);
  assert.match(distinct.stdout, /juries\s+codex/);
  assert.doesNotMatch(distinct.stdout, /selected as judge and reviewer/);
});
