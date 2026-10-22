import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testEnvironment } from '../scripts/test-environment.mjs';
import { readEvents, publishEvents } from '../lib/store.js';

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;

async function singlePrFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'jury-single-pr-push-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolated = testEnvironment();
  t.after(() => isolated.dispose());
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  await mkdir(repo);
  const git = async (cwd, ...args) => (await exec('git', args, { cwd, env: isolated.env })).stdout.trim();
  const agent = path.join(root, 'agent.cjs');
  await writeFile(agent, `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    const file = 'fix-' + process.env.JURY_FIXTURE_ROUND + '.txt';
    if (process.argv[2] === 'judge') {
      assert.equal(fs.existsSync(file), false);
      fs.writeFileSync(file, 'fixed');
      assert.equal(fs.readFileSync(file, 'utf8'), 'fixed');
      console.log(JSON.stringify({ verdict: 'accepted', reproduced: file + ' was absent',
        test: 'file assertion fails before creation and passes after', reason: 'created ' + file }));
    } else if (fs.existsSync(file)) console.log('NO NEW FINDINGS');
    else console.log('FINDING: Missing ' + file + '\\nWHERE: ' + file + ':1\\nThe required file is absent.');
  `);
  await git(repo, 'init', '-q', '-b', 'master');
  await writeFile(path.join(repo, '.gitignore'), 'runs/\n');
  await writeFile(path.join(repo, 'jury.config.json'), JSON.stringify({ agents: [
    { name: 'fixture-reviewer', role: 'reviewer', cwd: 'worktree', argv: [process.execPath, agent, 'reviewer', '{{promptText}}'], report: 'whole', resume: { supported: false } },
    { name: 'fixture-judge', role: 'main', cwd: 'worktree', argv: [process.execPath, agent, 'judge', '{{promptText}}'], report: 'whole', resume: { supported: false } },
  ] }));
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'base');
  await git(repo, 'checkout', '-qb', 'feature');
  await git(repo, 'commit', '--allow-empty', '-qm', 'feature');
  await git(root, 'clone', '--bare', '-q', repo, remote);
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'fetch', '-q', 'origin');
  const remoteHead = () => git(remote, 'rev-parse', 'feature');
  const head = () => git(repo, 'rev-parse', 'HEAD');
  const before = await remoteHead();
  let round = 0;
  const review = async (args = []) => {
    const result = await exec(process.execPath, [cli, 'review', '--dir', repo, '--trunk', 'master',
      '--title', 'https://github.com/fixture/repo/pull/1', '--judge', 'fixture-judge',
      '--reviewer', 'fixture-reviewer', '--rounds', '1', '--web=false', ...args],
    { cwd: repo, env: { ...isolated.env, JURY_FIXTURE_ROUND: String(++round) }, timeout: 15000 });
    assert.match(result.stdout, /REVIEW COMPLETE/);
    const [slug] = await readdir(path.join(repo, 'runs'));
    const dir = path.join(repo, 'runs', slug);
    return { slug, dir, run: JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')) };
  };
  return { repo, remote, git, head, remoteHead, before, review };
}

for (const push of [false, true]) {
  test(`single-PR fixes persist push=${push}, inherit it on resume, and honor explicit overrides`, { timeout: 60000 }, async t => {
    const f = await singlePrFixture(t);
    // New reviews still push by default; local-only reviews opt out explicitly.
    let saved = await f.review(push ? [] : ['--push=false']);
    assert.equal(saved.run.target.pushEnabled, push);
    const firstHead = await f.head();
    assert.equal(await f.remoteHead(), push ? firstHead : f.before);

    saved = await f.review(['--resume', saved.slug]);
    const secondHead = await f.head();
    assert.notEqual(secondHead, firstHead, 'the resumed judge must make another fix');
    assert.equal(await f.remoteHead(), push ? secondHead : f.before, 'resume must preserve the saved push preference');
    assert.equal(saved.run.target.pushEnabled, push);

    saved = await f.review(['--resume', saved.slug, `--push=${!push}`]);
    const thirdHead = await f.head();
    assert.notEqual(thirdHead, secondHead);
    assert.equal(await f.remoteHead(), push ? secondHead : thirdHead, 'an explicit push preference must override the saved value');
    assert.equal(saved.run.target.pushEnabled, !push);
    if (!push) assert.equal(await f.git(f.remote, 'show', 'feature:fix-1.txt'), 'fixed', 'explicitly enabling pushes also publishes the earlier local fix');
  });
}

test('single-PR resume keeps earlier and new fixes local when an older run has no push setting', { timeout: 60000 }, async t => {
  const f = await singlePrFixture(t);
  let saved = await f.review(['--push=false']);
  const firstHead = await f.head();
  assert.notEqual(firstHead, f.before);
  assert.equal(await f.remoteHead(), f.before);
  // Older single-PR runs omitted this setting from every persisted target.
  const events = await readEvents(saved.dir);
  for (const event of events) if (event.t === 'target') delete event.target.pushEnabled;
  await writeFile(path.join(saved.dir, 'events.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await publishEvents(saved.dir);

  saved = await f.review(['--resume', saved.slug]);
  assert.notEqual(await f.head(), firstHead, 'the resumed judge must make another fix');
  assert.equal(await f.remoteHead(), f.before, 'an unknown push preference must not publish either local fix');
  assert.equal(saved.run.target.pushEnabled, false);
  assert.equal(await f.git(f.repo, 'show', 'HEAD:fix-1.txt'), 'fixed');
  assert.equal(await f.git(f.repo, 'show', 'HEAD:fix-2.txt'), 'fixed');
});

for (const visibility of ['normal', 'no', 'all']) {
  test(`judge-created files reach the reviewed commit with status.showUntrackedFiles=${visibility}`, { timeout: 20000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jury-commit-files-'));
    const isolated = testEnvironment();
    try {
      const repo = path.join(root, 'repo');
      await mkdir(repo);
      const agent = path.join(root, 'agent.cjs');
      await writeFile(agent, `
        const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
        if (process.argv[2] === 'judge') {
          fs.mkdirSync('generated', { recursive: true });
          fs.writeFileSync('created.test.cjs', "require('node:assert/strict').equal(require('node:fs').readFileSync('generated/created.txt', 'utf8'), 'fixed');");
          assert.notEqual(cp.spawnSync(process.execPath, ['created.test.cjs']).status, 0);
          fs.writeFileSync('generated/created.txt', 'fixed');
          assert.equal(cp.spawnSync(process.execPath, ['created.test.cjs']).status, 0);
          fs.writeFileSync('ignored.cache', 'temporary fixture output');
          console.log(JSON.stringify({ verdict: 'accepted', reproduced: 'test fails while the required file is absent', test: 'created.test.cjs fails before and passes after file creation', reason: 'added the missing file' }));
        } else if (fs.existsSync('generated/created.txt')) console.log('NO NEW FINDINGS');
        else console.log('FINDING: missing required file\\nWHERE: generated/created.txt:1\\nThe required file is absent.');
      `);
      const git = async (...args) => (await exec('git', args, { cwd: repo, env: isolated.env })).stdout.trim();
      await git('init', '-q', '-b', 'master');
      await writeFile(path.join(repo, '.gitignore'), 'runs/\nignored.cache\n');
      await writeFile(path.join(repo, 'value.txt'), 'base\n');
      await writeFile(path.join(repo, 'jury.config.json'), JSON.stringify({ agents: [
        { name: 'fixture-reviewer', role: 'reviewer', cwd: 'worktree', argv: [process.execPath, agent, 'reviewer', '{{promptText}}'], report: 'whole', resume: { supported: false } },
        { name: 'fixture-judge', role: 'main', cwd: 'worktree', argv: [process.execPath, agent, 'judge', '{{promptText}}'], report: 'whole', resume: { supported: false } },
      ] }));
      await git('add', '-A'); await git('commit', '-qm', 'base');
      await git('update-ref', 'refs/remotes/origin/master', 'HEAD');
      await git('checkout', '-qb', 'feature');
      await writeFile(path.join(repo, 'value.txt'), 'feature\n');
      await git('commit', '-qam', 'feature');
      await git('config', 'status.showUntrackedFiles', visibility);
      const before = await git('rev-parse', 'HEAD');
      const { stdout } = await exec(process.execPath, [cli, 'review', '--dir', repo, '--trunk', 'master',
        '--judge', 'fixture-judge', '--reviewer', 'fixture-reviewer', '--rounds', '1', '--web=false', '--push=false'],
      { cwd: repo, env: isolated.env, timeout: 15000 });

      const head = await git('rev-parse', 'HEAD');
      assert.notEqual(head, before, 'a new-file-only fix must produce a commit');
      assert.equal(await git('show', 'HEAD:generated/created.txt'), 'fixed');
      assert.match(await git('show', 'HEAD:created.test.cjs'), /generated\/created\.txt/);
      const files = (await git('ls-tree', '-r', '--name-only', 'HEAD')).split('\n');
      assert.ok(!files.includes('ignored.cache'), 'ignore rules must still protect temporary output');
      assert.equal(await readFile(path.join(repo, 'ignored.cache'), 'utf8'), 'temporary fixture output');
      assert.equal(await git('status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(await git('config', '--get', 'status.showUntrackedFiles'), visibility, 'do not rewrite the saved setting');
      const [slug] = await readdir(path.join(repo, 'runs'));
      const saved = JSON.parse(await readFile(path.join(repo, 'runs', slug, 'run.json'), 'utf8'));
      assert.equal(saved.target.state, 'converged');
      assert.equal(saved.target.reviewedCommit, await git('rev-parse', '--short', head));
      assert.match(stdout, /REVIEW COMPLETE/);
    } finally {
      isolated.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
