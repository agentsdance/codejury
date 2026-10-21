import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'jury-run-attempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home');
  await mkdir(repo); await mkdir(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, 'absent'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => exec('git', args, { cwd: repo, env });
  await git('init', '-q', '-b', 'master');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.com');
  await writeFile(path.join(repo, 'change.txt'), 'base\n');
  await writeFile(path.join(repo, '.gitignore'), 'runs/\n');
  await writeFile(path.join(repo, 'jury.config.json'), JSON.stringify({ agents: ['judge', 'reviewer'].map(name => ({
    name, role: name === 'judge' ? 'main' : 'reviewer',
    argv: [process.execPath, '-e', "console.log('NO NEW FINDINGS')"], report: 'whole',
  })) }));
  await git('add', '.'); await git('commit', '-qm', 'base');
  await git('update-ref', 'refs/remotes/origin/master', 'HEAD'); await git('checkout', '-qb', 'feature');
  await writeFile(path.join(repo, 'change.txt'), 'change\n'); await git('commit', '-qam', 'change');
  // Freeze only zero-argument Date construction, including across CLI processes.
  // Date.now and timers remain real; no wall-clock boundary or sleep is involved.
  const clock = path.join(root, 'clock.cjs');
  await writeFile(clock, "const RealDate=Date; global.Date=class extends RealDate { constructor(...args){ super(...(args.length ? args : ['2026-10-21T19:30:00.123Z'])); } };\n");
  const review = (summary, extra = []) => exec(process.execPath, ['--require', clock, cli,
    'review', '--dir', repo, '--trunk', 'master', '--judge', 'judge', '--reviewer', 'reviewer',
    '--rounds', '1', '--web=false', '--push=false', '--summary', summary, ...extra], { cwd: repo, env });
  const runs = path.join(repo, 'runs');
  const events = async slug => (await readFile(path.join(runs, slug, 'events.ndjson'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  return { repo, runs, review, events };
}

test('fresh reviews at the same instant keep separate histories and legacy explicit resume still works', async t => {
  const f = await fixture(t);
  await f.review('first independent invocation');
  const [first] = await readdir(f.runs);
  const firstLog = await readFile(path.join(f.runs, first, 'events.ndjson'), 'utf8');
  await f.review('second independent invocation');
  const slugs = await readdir(f.runs);
  assert.equal(slugs.length, 2, 'a fresh invocation must create its own run even at the same timestamp');
  const second = slugs.find(s => s !== first);
  assert.equal(await readFile(path.join(f.runs, first, 'events.ndjson'), 'utf8'), firstLog);
  for (const [slug, summary, other] of [[first, 'first', 'second'], [second, 'second', 'first']]) {
    const rounds = (await f.events(slug)).filter(e => e.t === 'round.start');
    assert.deepEqual(rounds.map(e => e.n), [1]);
    assert.match(rounds[0].prompt, new RegExp(summary + ' independent invocation'));
    assert.doesNotMatch(rounds[0].prompt, new RegExp(other + ' independent invocation'));
  }
  // --resume is an explicit directory selection, including old minute-only names.
  const legacy = 'repo-feature-20261022-0330';
  await rename(path.join(f.runs, first), path.join(f.runs, legacy));
  const secondLog = await readFile(path.join(f.runs, second, 'events.ndjson'), 'utf8');
  await f.review('explicit continuation', ['--resume', legacy]);
  assert.equal((await readdir(f.runs)).length, 2);
  assert.deepEqual((await f.events(legacy)).filter(e => e.t === 'round.start').map(e => e.n), [1, 2]);
  assert.equal(await readFile(path.join(f.runs, second, 'events.ndjson'), 'utf8'), secondLog);
});

test('concurrent fresh CLI processes at the same instant cannot share run artifacts', async t => {
  const f = await fixture(t);
  await Promise.all([f.review('concurrent one'), f.review('concurrent two')]);
  const slugs = await readdir(f.runs);
  assert.equal(slugs.length, 2, 'separate processes need independent run identities');
  const summaries = [];
  for (const slug of slugs) {
    const events = await f.events(slug);
    const rounds = events.filter(e => e.t === 'round.start');
    assert.deepEqual(rounds.map(e => e.n), [1]);
    assert.equal(events.filter(e => e.t === 'agent.report').length, 1);
    summaries.push(rounds[0].prompt.match(/concurrent (one|two)/)?.[1]);
    assert.equal(await readFile(path.join(f.runs, slug, rounds[0].promptFile), 'utf8'), rounds[0].prompt);
  }
  assert.deepEqual(summaries.sort(), ['one', 'two']);
});
