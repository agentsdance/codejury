import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {testEnvironment} from '../scripts/test-environment.mjs';

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const root = path.dirname(path.dirname(cli));
const load = name => import(pathToFileURL(path.join(root, 'lib', name)));
const {appendEvent, readEvents, foldEvents} = await load('store.js');
const {findingsIn} = await load('findings.js');
const {replyRound, outstanding, MAX_TURNS} = await load('loop.js');
const id = 'r1-reviewfixture-1';
const claim = '[P2] Missing authorization validation';
const body = 'An anonymous request reaches the protected action.';
const explanation = '缺少权限校验的问题依然存在：匿名请求仍能调用受保护操作。';
const dispute = `DISPUTE: ${id}\n${explanation}`;
const acknowledgement = `${claim} at a.txt:1 is resolved; I agree.\nNO NEW FINDINGS`;

async function fixture(t, {fresh = false, invalidJudge = false} = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'jury-contested-resume-'));
  const repo = path.join(temp, 'repo'), calls = path.join(temp, 'calls.ndjson');
  const isolated = testEnvironment();
  t.after(() => { isolated.dispose(); return rm(temp, {recursive: true, force: true}); });
  await mkdir(repo);
  await writeFile(calls, '');
  const git = (...args) => exec('git', args, {cwd: repo, env: isolated.env});
  await git('init', '-q', '-b', 'master');
  await writeFile(path.join(repo, '.gitignore'), 'runs/\njury.config.json\n');
  await writeFile(path.join(repo, 'a.txt'), 'before\n');
  await git('add', '.'); await git('commit', '-qm', 'base');
  await git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  await git('switch', '-qc', 'feature');
  await writeFile(path.join(repo, 'a.txt'), 'after\n');
  await git('commit', '-qam', 'change');
  const reviewCode = `
    const fs = require('node:fs'), prompt = process.argv[1];
    const action = prompt.startsWith('Thanks —') ? 'reply' : 'review';
    const previous = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({action, prompt}) + '\\n');
    const first = !previous.some(call => call.action === action);
    console.log(${fresh} && first
      ? action === 'review' ? ${JSON.stringify(`FINDING: ${claim}\nWHERE: a.txt:1\n${body}`)} : ${JSON.stringify(dispute)}
      : action === 'reply' ? ${JSON.stringify(acknowledgement)} : 'NO NEW FINDINGS');
  `;
  const judgeCode = `
    require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({action: 'judge', prompt: process.argv[1]}) + '\\n');
    console.log(${JSON.stringify(invalidJudge ? 'Unable to reach a verdict.' : JSON.stringify({
      verdict: 'rejected', reason: 'Rechecked the dispute', reproduced: null, test: null,
    }))});
  `;
  await writeFile(path.join(repo, 'jury.config.json'), JSON.stringify({agents: [
    {name: 'reviewfixture', role: 'reviewer', argv: [process.execPath, '-e', reviewCode, '{{promptText}}']},
    {name: 'judgefixture', role: 'main', argv: [process.execPath, '-e', judgeCode, '{{promptText}}']},
  ]}));
  const dir = path.join(repo, 'runs', 'saved');
  async function seed({status = 'rejected', turns = 1} = {}) {
    await appendEvent(dir, {t: 'target', target: {judge: 'judgefixture', language: 'en'}});
    await appendEvent(dir, {t: 'round.start', n: 1});
    await appendEvent(dir, {t: 'finding.raised', id, round: 1, agent: 'reviewfixture', claim, loc: 'a.txt:1', body});
    await appendEvent(dir, {t: 'finding.resolved', id, verdict: status, reason: 'Previously checked'});
    await appendEvent(dir, {t: 'language.changed', language: 'zh-CN'});
    // Save turns through the actual translated-reply path, not an assigned contested flag.
    for (let n = 0; n < turns; n++) {
      const [answer] = await replyRound({dir, pool: [{name: 'reviewfixture',
        argv: [process.execPath, '-e', `console.log(${JSON.stringify(dispute)})`]}],
      cfg: {stopToken: 'NO NEW FINDINGS'}, worktree: repo, sha: 'abc', round: 1,
      language: 'zh-CN', findings: await findingsIn(dir)});
      assert.equal(answer.failed, false);
    }
    await appendEvent(dir, {t: 'round.end', n: 1});
  }
  async function invoke(rounds = 1) {
    const result = await exec(process.execPath, [cli, 'review', '--dir', repo,
      ...(!fresh ? ['--resume', 'saved'] : []), '--trunk', 'master',
      '--reviewer', 'reviewfixture', '--judge', 'judgefixture', '--language', 'zh-CN',
      '--rounds', String(rounds), '--push=false', '--web=false'], {cwd: repo, env: isolated.env, timeout: 15000, maxBuffer: 2e6});
    const runDir = path.join(repo, 'runs', (await readdir(path.join(repo, 'runs')))[0]);
    const events = await readEvents(runDir);
    return {...result, events, findings: await findingsIn(runDir), target: foldEvents(events).target,
      calls: (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)};
  }
  return {seed, invoke};
}

for (const status of ['rejected', 'accepted']) {
  test(`a clean resume reconsiders a saved translated dispute of a previously ${status} finding`, async t => {
    const f = await fixture(t);
    await f.seed({status});
    const result = await f.invoke();
    const judges = result.calls.filter(call => call.action === 'judge');
    assert.equal(judges.length, 1, 'the saved dispute must reach the judge before convergence');
    assert.ok(judges[0].prompt.includes(explanation), 'the judge must receive the translated rebuttal');
    assert.ok(judges[0].prompt.includes('Previously checked'));
    assert.ok(judges[0].prompt.includes(body));
    assert.ok(judges[0].prompt.includes('Response language: zh-CN.'));
    assert.equal(result.target.state, 'converged');
    assert.equal(result.findings.get(id).contested, false);
    assert.deepEqual(result.findings.get(id).rebuttals, [], 'resolved rebuttals must not be replayed as pending');
    assert.equal(result.events.filter(e => e.t === 'finding.turn').length, 1,
      'a clean acknowledgement mentioning the title and path must not reopen the dispute');
    assert.deepEqual(outstanding(result.findings, result.events), []);
  });
}

test('a translated dispute reaches the judge on the next clean round without a resume', async t => {
  const f = await fixture(t, {fresh: true});
  const result = await f.invoke(2);
  const judges = result.calls.filter(call => call.action === 'judge');
  assert.equal(judges.length, 2);
  assert.ok(!judges[0].prompt.includes(explanation));
  assert.ok(judges[1].prompt.includes(explanation));
  assert.equal(result.target.state, 'converged');
  assert.equal(result.findings.get(id).turns, 1);
  assert.equal(result.findings.get(id).contested, false);
});

test('a clean reply cannot converge when the judge leaves a saved dispute unanswered', async t => {
  const f = await fixture(t, {invalidJudge: true});
  await f.seed();
  const result = await f.invoke();
  assert.equal(result.calls.filter(call => call.action === 'judge').length, 1);
  assert.equal(result.target.state, 'human');
  assert.doesNotMatch(result.stdout, /REVIEW COMPLETE/);
  assert.equal(result.findings.get(id).contested, true);
  assert.equal(result.findings.get(id).turns, 1);
  assert.deepEqual(result.findings.get(id).rebuttals, [dispute]);
  assert.deepEqual(outstanding(result.findings, result.events).map(f => f.id), [id]);
});

for (const turns of [MAX_TURNS - 1, MAX_TURNS]) {
  test(`a clean resume preserves the existing turn limit with ${turns} saved disputes`, async t => {
    const f = await fixture(t);
    await f.seed({turns});
    const result = await f.invoke();
    assert.equal(result.calls.filter(call => call.action === 'judge').length, Number(turns < MAX_TURNS));
    assert.equal(result.findings.get(id).turns, turns);
    assert.equal(result.target.state, 'converged');
    assert.deepEqual(outstanding(result.findings, result.events), []);
  });
}
