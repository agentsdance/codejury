import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL('../bin/jury.js', import.meta.url));
const root = path.dirname(path.dirname(cli));
const { loadConfig, judgeAgent, reviewers } = await import(pathToFileURL(path.join(root, 'lib/config.js')));
const { runAgent } = await import(pathToFileURL(path.join(root, 'lib/agents.js')));

test('Antigravity is discoverable without configuration and receives literal prompts in the review worktree', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-agy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, 'review with spaces');
  const bin = path.join(dir, 'bin');
  await mkdir(worktree); await mkdir(bin);
  const executable = path.join(bin, 'agy');
  // Antigravity is read through --output-format json, so the stub answers in
  // that shape: a bare line of prose would no longer be a valid report.
  await writeFile(executable, `#!${process.execPath}\nimport('node:fs').then(fs => { fs.writeFileSync('invocation.json', JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2)})); console.log(JSON.stringify({conversation_id:'af730fe4-e36e-4146-a5c5-ba4fea33a325', status:'SUCCESS', response:'NO NEW FINDINGS'})); });\n`, { mode: 0o755 });
  const cfg = await loadConfig(worktree, { globalFile: path.join(dir, 'missing.json') });
  const agent = reviewers(cfg).find(a => a.name === 'agy');
  assert.ok(agent);
  assert.equal(judgeAgent(cfg).name, 'codex');
  assert.equal(judgeAgent(cfg, 'agy').name, 'agy');
  const prompt = 'Read this literally: "quotes"; $(touch unwanted)\nReview only.';
  const result = await runAgent({ ...agent, argv: [executable, ...agent.argv.slice(1)] }, { worktree, prompt, stopToken: 'NO NEW FINDINGS' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'clean');
  const call = JSON.parse(await readFile(path.join(worktree, 'invocation.json')));
  assert.equal(call.cwd, await realpath(worktree));
  assert.deepEqual(call.args, ['--dangerously-skip-permissions', '--add-dir', worktree, '--print-timeout', '20m', '--output-format', 'json', '--print', prompt]);
  // The conversation id is captured so the reply resumes this exact review
  // rather than whatever conversation happens to be most recent.
  assert.equal(result.sessionId, 'af730fe4-e36e-4146-a5c5-ba4fea33a325');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const listing = spawnSync(process.execPath, [cli, 'agents'], { cwd: worktree, env, encoding: 'utf8' }).stdout;
  assert.match(listing, /ok\s+agy\s+reviewer/);
  execFileSync(process.execPath, [cli, 'agents', 'judge', 'agy'], { cwd: worktree, env });
  assert.equal(JSON.parse(await readFile(path.join(dir, '.jury/config.json'))).judge, 'agy');
  await writeFile(path.join(worktree, 'jury.config.json'), JSON.stringify({ agents: [{ name: 'agy', enabled: false }] }));
  assert.ok(!(await loadConfig(worktree, { globalFile: path.join(dir, 'missing.json') })).agents.some(a => a.name === 'agy'));
});
