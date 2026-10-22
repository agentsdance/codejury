import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testEnvironment } from '../scripts/test-environment.mjs';

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;

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
