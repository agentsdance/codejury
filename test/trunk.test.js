import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildPrompt } from '../lib/prompt.js';
import { triagePrompt } from '../lib/triage.js';
import { groupContext } from '../lib/review-group.js';
import { assertTrunk, diffCommand } from '../lib/trunk.js';
import { groupFixture } from './helpers/group-fixture.js';
const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-trunk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'master');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.com');
  await writeFile(path.join(dir, 'change.txt'), 'before\n');
  await git('add', '.'); await git('commit', '-qm', 'base');
  await git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  await git('checkout', '-qb', 'feature');
  await writeFile(path.join(dir, 'change.txt'), 'after\n');
  await git('commit', '-qam', 'change');
  return { dir, git };
}
for (const kind of ['reviewer', 'judge', 'related PR']) {
  test(`${kind} diff command shows committed changes and fails closed without its trunk`, async t => {
    const { dir, git } = await fixture(t);
    let prompt;
    if (kind === 'reviewer') prompt = await buildPrompt({ target: { branch: 'feature' }, trunk: 'master', stopToken: 'NO NEW FINDINGS' });
    else if (kind === 'judge') prompt = triagePrompt({ finding: { claim: 'example' }, trunk: 'master', stopToken: 'NO NEW FINDINGS' });
    else prompt = groupContext([{ key: 'PR1', worktree: dir, trunk: 'master' }]);
    const command = kind === 'related PR' ? prompt.match(/^Diff: (.+)$/m)?.[1] : prompt.match(/`(git diff [^`]+)`/)?.[1];
    assert.ok(command, 'prompt must give an executable diff command');
    const result = await exec('/bin/sh', ['-c', command], { cwd: dir });
    assert.match(result.stdout, /\+after/);
    await git('update-ref', '-d', 'refs/remotes/origin/master');
    await assert.rejects(exec('/bin/sh', ['-c', command], { cwd: dir }), e => e.code !== 0);
  });
}
test('invalid trunk fails before probing agents or publishing a run', async t => {
  const { dir, git } = await fixture(t);
  const marker = path.join(dir, 'agent-started');
  await writeFile(path.join(dir, 'jury.config.json'), JSON.stringify({ agents: ['judge', 'reviewer'].map(name => ({ name, role: name === 'judge' ? 'main' : 'reviewer', argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started'); console.log('NO NEW FINDINGS')`], report: 'whole' })) }));
  for (const trunk of ['missing', 'refs/remotes/origin/master', 'origin/master', 'bad..branch']) {
    await assert.rejects(exec(process.execPath, [cli, 'review', '--dir', dir, '--trunk', trunk, '--judge', 'judge', '--reviewer', 'reviewer', '--rounds', '1', '--web=false', '--push=false'], { cwd: dir }), e => e.code === 1 && /trunk/i.test(e.stderr));
    await assert.rejects(access(marker));
    await assert.rejects(access(path.join(dir, 'runs')));
  }
  // An existing remote-tracking branch with no shared history is invalid too.
  await git('checkout', '--orphan', 'unrelated');
  await git('commit', '-qm', 'unrelated base');
  await git('update-ref', 'refs/remotes/origin/unrelated', 'HEAD');
  await git('checkout', 'feature');
  await assert.rejects(exec(process.execPath, [cli, 'review', '--dir', dir, '--trunk', 'unrelated', '--judge', 'judge', '--reviewer', 'reviewer', '--web=false', '--push=false']), e => e.code === 1 && /trunk/i.test(e.stderr));
  await assert.rejects(access(marker));
});

test('invalid trunk is rejected before checking agent installation', async t => {
  const { dir } = await fixture(t);
  await writeFile(path.join(dir, 'jury.config.json'), JSON.stringify({ agents: [
    { name: 'judge', role: 'main', argv: ['jury-deliberately-missing-agent'] },
    { name: 'reviewer', role: 'reviewer', argv: [process.execPath, '-e', "console.log('NO NEW FINDINGS')"], report: 'whole' },
  ] }));
  await assert.rejects(
    exec(process.execPath, [cli, 'review', '--dir', dir, '--trunk', 'missing', '--judge', 'judge', '--reviewer', 'reviewer', '--web=false', '--push=false'], { cwd: dir }),
    error => error.code === 1 && /invalid trunk/.test(error.stderr) && !/not installed/.test(error.stderr),
  );
});

test('a related-PR invalid trunk removes its unrecorded workspace before checking agent installation', async t => {
  const fixture = await groupFixture(t);
  const primary = fixture.members[0];
  const configPath = path.join(primary.repo, 'jury.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.agents.find(agent => agent.name === 'codex').argv = ['jury-deliberately-missing-agent'];
  await writeFile(configPath, JSON.stringify(config));
  await fixture.git(primary.repo, 'commit', '-qam', 'missing judge');
  await fixture.git(primary.repo, 'push', primary.remote, primary.branch);
  primary.sha = await fixture.git(primary.repo, 'rev-parse', 'HEAD');
  await fixture.git(primary.remote, 'update-ref', 'refs/pull/7/head', primary.sha);
  fixture.members[1].base = 'missing';
  await writeFile(path.join(fixture.root, 'members.json'), JSON.stringify(fixture.members));

  const result = await fixture.review(['--push=false']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid trunk/);
  assert.doesNotMatch(result.stderr, /not installed/);
  assert.deepEqual(await readdir(path.join(fixture.state, 'checkouts')), []);
});

test('bare nested branch names are not normalized or confused with local refs', async t => {
  const { dir, git } = await fixture(t);
  for (const trunk of ['origin/topic', "topic'quote"]) {
    await git('update-ref', `refs/remotes/origin/${trunk}`, 'master');
    // The local branch must not shadow the origin tracking ref.
    await git('branch', `origin/${trunk}`, 'HEAD');
    await assertTrunk(dir, trunk);
    const result = await exec('/bin/sh', ['-c', diffCommand(trunk)], { cwd: dir });
    assert.match(result.stdout, /\+after/);
  }
});

test('a diverged trunk uses the shared merge base, not its newer tip', async t => {
  const { dir, git } = await fixture(t);
  await git('checkout', 'master');
  await writeFile(path.join(dir, 'trunk-only.txt'), 'unrelated trunk work\n');
  await git('add', '.'); await git('commit', '-qm', 'advance trunk');
  await git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  await git('checkout', 'feature');
  await assertTrunk(dir, 'master');
  const result = await exec('/bin/sh', ['-c', diffCommand('master')], { cwd: dir });
  assert.match(result.stdout, /\+after/);
  assert.doesNotMatch(result.stdout, /trunk-only|unrelated trunk work/);
});
