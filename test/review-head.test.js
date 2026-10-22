import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { testEnvironment } from '../scripts/test-environment.mjs';

const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;

for (const phase of ['review', 'finding review', 'reply', 'fix reply', 'failed reply']) {
  for (const changed of phase === 'failed reply' ? [true] : [false, true]) {
    test(`${phase} ${changed ? 'cannot complete after a concurrent commit' : 'completes on an unchanged reviewed HEAD'}`, { timeout: 25000 }, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'jury-review-head-'));
      const isolated = testEnvironment();
      let child, completion;
      try {
        const repo = path.join(root, 'repo');
        await mkdir(repo);
        const ready = path.join(root, 'ready.json');
        const release = path.join(root, 'release');
        const agent = path.join(root, 'agent.cjs');
        await writeFile(agent, `
          const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
          const role = process.argv[2], prompt = process.argv[3], phase = ${JSON.stringify(phase)};
          if (role === 'judge') {
            assert.notEqual(phase, 'review', 'a clean initial review needs no judge');
            if (phase === 'fix reply') {
              fs.writeFileSync('added.test.cjs', "require('node:assert/strict').equal(require('node:fs').readFileSync('added.txt', 'utf8'), 'fixed');");
              assert.notEqual(cp.spawnSync(process.execPath, ['added.test.cjs']).status, 0);
              fs.writeFileSync('added.txt', 'fixed');
              assert.equal(cp.spawnSync(process.execPath, ['added.test.cjs']).status, 0);
              console.log(JSON.stringify({ verdict: 'accepted', reproduced: 'new-file test failed before correction', test: 'added.test.cjs fails before and passes after', reason: 'created missing file' }));
            } else console.log(JSON.stringify({ verdict: 'rejected', reason: 'fixture claim is not valid' }));
          } else if (phase === 'finding review' && !prompt.startsWith('Thanks —')) {
            const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8' }).trim();
            fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ head: git('rev-parse', 'HEAD'), files: git('ls-files') }));
            const start = Date.now();
            const timer = setInterval(() => {
              if (fs.existsSync(${JSON.stringify(release)})) {
                clearInterval(timer);
                console.log('FINDING: missing file fixture\\nWHERE: added.txt:1\\nCheck the fixture.');
              }
              else if (Date.now() - start > 15000) { clearInterval(timer); console.error('fixture release timed out'); process.exitCode = 1; }
            }, 10);
          } else if (phase !== 'review' && !prompt.startsWith('Thanks —')) {
            console.log('FINDING: missing file fixture\\nWHERE: added.txt:1\\nCheck the fixture.');
          } else {
            const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8' }).trim();
            if (phase === 'fix reply') {
              fs.writeFileSync('staged-only.txt', 'not part of the reviewed commit');
              git('add', 'staged-only.txt');
            }
            fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ head: git('rev-parse', 'HEAD'), files: git('ls-tree', '-r', '--name-only', 'HEAD') }));
            const start = Date.now();
            const timer = setInterval(() => {
              if (fs.existsSync(${JSON.stringify(release)})) {
                clearInterval(timer);
                if (phase === 'failed reply') { console.error('fixture reply failed'); process.exitCode = 1; }
                else console.log('NO NEW FINDINGS');
              }
              else if (Date.now() - start > 15000) { clearInterval(timer); console.error('fixture release timed out'); process.exitCode = 1; }
            }, 10);
          }
        `);
        const git = (...args) => execFileSync('git', args, { cwd: repo, env: isolated.env, encoding: 'utf8' }).trim();
        git('init', '-q', '-b', 'master');
        await writeFile(path.join(repo, '.gitignore'), 'runs/\n');
        await writeFile(path.join(repo, 'value.txt'), 'base\n');
        await writeFile(path.join(repo, 'jury.config.json'), JSON.stringify({ agents: [
          { name: 'fixture-reviewer', role: 'reviewer', cwd: 'worktree', argv: [process.execPath, agent, 'reviewer', '{{promptText}}'], report: 'whole', resume: { supported: false } },
          { name: 'fixture-judge', role: 'main', cwd: 'worktree', argv: [process.execPath, agent, 'judge', '{{promptText}}'], report: 'whole', resume: { supported: false } },
        ] }));
        git('add', '-A'); git('commit', '-qm', 'base');
        git('update-ref', 'refs/remotes/origin/master', 'HEAD');
        git('checkout', '-qb', 'feature');
        await writeFile(path.join(repo, 'value.txt'), 'feature\n');
        git('commit', '-qam', 'feature');
        const initialHead = git('rev-parse', 'HEAD');
        child = spawn(process.execPath, [cli, 'review', '--dir', repo, '--trunk', 'master',
          '--reviewer', 'fixture-reviewer', '--judge', 'fixture-judge', '--rounds', '1', '--web=false', '--push=false'],
        { cwd: repo, env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] });
        completion = once(child, 'exit');
        let stdout = '', stderr = '';
        child.stdout.on('data', b => { stdout += b; });
        child.stderr.on('data', b => { stderr += b; });
        const deadline = Date.now() + 10000;
        let observed;
        while (Date.now() < deadline) {
          try { observed = JSON.parse(await readFile(ready, 'utf8')); break; }
          catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
          assert.equal(child.exitCode, null, `CLI exited before the review checkpoint:\n${stdout}\n${stderr}`);
          await delay(10);
        }
        assert.ok(observed, 'reviewer must reach the synchronized checkpoint');
        const reviewedHead = observed.head;
        if (phase === 'fix reply') {
          assert.notEqual(reviewedHead, initialHead, 'the loop must commit the judge fix before asking for approval');
          assert.ok(observed.files.split('\n').includes('added.txt'));
          assert.ok(observed.files.split('\n').includes('added.test.cjs'));
          assert.ok(!observed.files.split('\n').includes('staged-only.txt'), 'the checkpoint must inspect the reviewed commit, not the index');
        } else assert.equal(reviewedHead, initialHead);
        if (changed) {
          await writeFile(path.join(repo, 'value.txt'), 'concurrent change\n');
          git('commit', '-qam', 'concurrent change');
          assert.notEqual(git('rev-parse', 'HEAD'), reviewedHead);
        }
        await writeFile(release, 'continue');
        const [code, signal] = await completion;
        assert.equal(signal, null, stderr);
        assert.equal(code, phase === 'failed reply' ? 1 : 0, stderr);
        const [slug] = await readdir(path.join(repo, 'runs'));
        const saved = JSON.parse(await readFile(path.join(repo, 'runs', slug, 'run.json'), 'utf8'));
        if (phase === 'failed reply') {
          assert.equal(saved.target.state, 'human');
          assert.match(saved.target.stateNote, /reviewer replies failed/);
          assert.doesNotMatch(stdout, /REVIEW COMPLETE/);
        } else if (changed) {
          assert.equal(saved.target.state, 'human', 'an approval for an obsolete HEAD must not complete the review');
          assert.match(saved.target.stateNote, /HEAD changed during review/);
          assert.doesNotMatch(stdout, /REVIEW COMPLETE/);
        } else {
          assert.equal(saved.target.state, 'converged');
          assert.equal(saved.target.reviewedCommit, git('rev-parse', '--short', reviewedHead));
          assert.match(stdout, /REVIEW COMPLETE/);
        }
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await completion; }
        isolated.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
