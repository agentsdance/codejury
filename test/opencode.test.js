import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL('../bin/jury.js', import.meta.url));
const root = path.dirname(path.dirname(cli));
const { loadConfig, judgeAgent } = await import(pathToFileURL(path.join(root, 'lib/config.js')));
const { runAgent, extractReport } = await import(pathToFileURL(path.join(root, 'lib/agents.js')));
const finish = JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } });
const event = text => JSON.stringify({ type: 'text', sessionID: 'ses_fixture', part: { text } }) + '\n' + finish;

test('OpenCode parses assistant text only and fails closed on errors or incomplete output', () => {
  const earlier = JSON.stringify({ type: 'text', part: { messageID: 'old', text: 'NO NEW FINDINGS' } });
  const final = JSON.stringify({ type: 'text', part: { messageID: 'new', text: 'I found a problem.' } });
  assert.equal(extractReport(earlier + '\n' + final + '\n' + finish, 'opencode-json'), 'I found a problem.');
  const tool = JSON.stringify({ type: 'tool_use', part: { state: { output: 'NO NEW FINDINGS' } } });
  assert.equal(extractReport(tool + '\n' + event('FINDING: bug\nWHERE: a.js:1'), 'opencode-json'), 'FINDING: bug\nWHERE: a.js:1');
  for (const output of [tool, JSON.stringify({type:'text',part:{text:'NO NEW FINDINGS'}}), '', 'NO NEW FINDINGS', event('NO NEW FINDINGS') + '\n' + JSON.stringify({ type: 'error', error: 'auth failed' })]) {
    assert.throws(() => extractReport(output, 'opencode-json'));
  }
});

test('OpenCode will not let a stale sign-off stand in for a truncated later message', () => {
  const step = (messageID, reason) => JSON.stringify({ type: 'step_finish', part: { messageID, reason } });
  const start = messageID => JSON.stringify({ type: 'step_start', part: { messageID } });
  const signOff = JSON.stringify({ type: 'text', part: { messageID: 'm1', text: 'NO NEW FINDINGS' } });

  // A second message that produces no text and dies on the token limit must not
  // inherit the first message's sign-off.
  const truncated = [signOff, step('m1', 'stop'), start('m2'),
    JSON.stringify({ type: 'tool_use', part: { messageID: 'm2', state: { output: 'x' } } }),
    step('m2', 'length')].join('\n');
  assert.throws(() => extractReport(truncated, 'opencode-json'), /no assistant text/);

  // A message whose own text is cut off mid-answer is not a verdict either.
  const cutOff = [JSON.stringify({ type: 'text', part: { messageID: 'm1', text: 'NO NEW FINDINGS' } }),
    step('m1', 'length')].join('\n');
  assert.throws(() => extractReport(cutOff, 'opencode-json'), /stopped early: length/);

  // A completed turn still parses.
  assert.equal(extractReport([signOff, step('m1', 'stop')].join('\n'), 'opencode-json'), 'NO NEW FINDINGS');
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
  assert.match(spawnSync(process.execPath, [cli, 'agents'], { cwd: worktree, env, encoding: 'utf8' }).stdout, /ok\s+opencode\s+reviewer/);
  exec(['agents', 'judge', 'opencode']);
  assert.equal(JSON.parse(await readFile(path.join(dir, '.jury/config.json'))).judge, 'opencode');
  assert.equal((await loadConfig(worktree, { globalFile: path.join(dir, '.jury/config.json') })).main.name, 'opencode');
  // First prove that this exact transcript passes with exit 0, then change only
  // the exit code. A parse error or startup timeout must not mask the exit check.
  const clean = `console.log(${JSON.stringify(event('NO NEW FINDINGS'))});`;
  await writeFile(exe, `#!${process.execPath}\n${clean}`, { mode: 0o755 });
  assert.equal((await invoke(agent)).verdict, 'clean');
  await writeFile(exe, `#!${process.execPath}\n${clean}process.exit(2);`, { mode: 0o755 });
  const failed = await invoke(agent);
  assert.equal(failed.verdict, 'error'); assert.match(failed.report, /exited 2/);
  await writeFile(exe, `#!${process.execPath}\nconsole.log('not json');`, { mode: 0o755 });
  assert.match((await invoke(agent)).report, /Invalid OpenCode JSON/);
  await writeFile(exe, `#!${process.execPath}\nsetInterval(()=>{},1000);`, { mode: 0o755 });
  const timed = await runAgent({ ...agent, argv: [exe] }, { worktree, prompt, stopToken: 'NO NEW FINDINGS', timeoutSeconds: 0.3 });
  assert.equal(timed.verdict, 'error'); assert.match(timed.report, /timed out/);
  await rm(exe);
  assert.equal((await invoke(agent)).verdict, 'error');
});
