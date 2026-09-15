import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL('../bin/jury.js', import.meta.url));
const root = path.dirname(path.dirname(cli));
const { loadConfig, judgeAgent } = await import(pathToFileURL(path.join(root, 'lib/config.js')));
const { runAgent, extractReport } = await import(pathToFileURL(path.join(root, 'lib/agents.js')));
const event = text => JSON.stringify({ type: 'text', sessionID: 'ses_fixture', part: { text } });

test('OpenCode parses assistant text only and fails closed on errors or incomplete output', () => {
  const earlier = JSON.stringify({ type: 'text', part: { messageID: 'old', text: 'NO NEW FINDINGS' } });
  const final = JSON.stringify({ type: 'text', part: { messageID: 'new', text: 'I found a problem.' } });
  assert.equal(extractReport(earlier + '\n' + final, 'opencode-json'), 'I found a problem.');
  const tool = JSON.stringify({ type: 'tool_use', part: { state: { output: 'NO NEW FINDINGS' } } });
  assert.equal(extractReport(tool + '\n' + event('FINDING: bug\nWHERE: a.js:1'), 'opencode-json'), 'FINDING: bug\nWHERE: a.js:1');
  for (const output of [tool, '', 'NO NEW FINDINGS', event('NO NEW FINDINGS') + '\n' + JSON.stringify({ type: 'error', error: 'auth failed' })]) {
    assert.throws(() => extractReport(output, 'opencode-json'));
  }
});

test('OpenCode installed CLI discovers, selects, and saves the judge, delivering literal prompts in the worktree', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-opencode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, 'work tree'); const bin = path.join(dir, 'bin');
  await mkdir(worktree); await mkdir(bin);
  const exe = path.join(bin, 'opencode');
  await writeFile(exe, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync('call.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),permission:JSON.parse(process.env.OPENCODE_PERMISSION)}));console.log(${JSON.stringify(event('NO NEW FINDINGS'))});`, { mode: 0o755 });
  const cfg = await loadConfig(worktree, { globalFile: path.join(dir, 'absent') });
  const agent = cfg.agents.find(a => a.name === 'opencode');
  const prompt = '--literal "quotes"; $(touch unwanted)\nReview only.';
  const invoke = a => runAgent({ ...a, argv: [exe, ...a.argv.slice(1)] }, { worktree, prompt, stopToken: 'NO NEW FINDINGS', timeoutSeconds: 3 });
  assert.equal((await invoke(agent)).verdict, 'clean');
  let call = JSON.parse(await readFile(path.join(worktree, 'call.json')));
  assert.equal(call.cwd, await realpath(worktree));
  assert.deepEqual(call.args, ['run', '--dir', worktree, '--agent', 'plan', '--format', 'json', '--', prompt]);
  assert.equal(call.permission.edit, 'deny');
  assert.equal(agent.resume.supported, false);
  assert.equal((await invoke(judgeAgent(cfg, 'opencode'))).verdict, 'clean');
  call = JSON.parse(await readFile(path.join(worktree, 'call.json')));
  assert.ok(call.args.includes('build')); assert.ok(call.args.includes('--auto'));
  assert.equal(call.permission.edit, undefined);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const exec = args => execFileSync(process.execPath, [cli, ...args], { cwd: worktree, env, encoding: 'utf8' });
  assert.match(exec(['agents']), /ok\s+opencode\s+reviewer/);
  exec(['agents', 'judge', 'opencode']);
  assert.equal(JSON.parse(await readFile(path.join(dir, '.jury/config.json'))).judge, 'opencode');
  assert.equal((await loadConfig(worktree, { globalFile: path.join(dir, '.jury/config.json') })).main.name, 'opencode');
  for (const script of ['console.log("NO NEW FINDINGS");process.exit(2)', 'console.log("not json")', 'setInterval(()=>{},1000)']) {
    await writeFile(exe, `#!${process.execPath}\n${script}`, { mode: 0o755 });
    const result = await runAgent({ ...agent, argv: [exe] }, { worktree, prompt, stopToken: 'NO NEW FINDINGS', timeoutSeconds: 0.1 });
    assert.equal(result.verdict, 'error'); assert.equal(result.ok, false);
  }
  await rm(exe);
  assert.equal((await invoke(agent)).verdict, 'error');
});
