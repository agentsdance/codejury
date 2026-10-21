import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const root = path.dirname(path.dirname(cli));
const { BUILTIN_AGENTS } = await import(pathToFileURL(path.join(root, 'lib/agents/registry.js')));
const { runAgent, extractReport } = await import(pathToFileURL(path.join(root, 'lib/agents.js')));
const codex = BUILTIN_AGENTS.find(a => a.name === 'codex');
const providerId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const fixtureId = '3fa0d4e0-50a2-4e79-b393-fb824002f628';
const prose = `NO NEW FINDINGS\nA regression fixture used session ID ${fixtureId} instead of null.`;
const lines = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const message = text => ({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text } });
const completed = text => [{ type: 'turn.started' }, message(text), { type: 'turn.completed' }];
const options = { worktree: process.cwd(), prompt: 'fixture only', stopToken: 'NO NEW FINDINGS' };

function fake(events, plain = prose, exit = 0) {
  // Match the real CLI contract in either mode so the false-ID assertions also
  // reproduce against the old plain-output built-in definition.
  const script = `process.stdout.write(process.argv.includes('--json') ? ${JSON.stringify(lines(events))} : ${JSON.stringify(plain)}); process.exitCode=${exit};`;
  return { ...codex, argv: [process.execPath, '-e', script, '--', ...codex.argv.slice(1)] };
}

test('Codex does not mistake a UUID in report prose or tool output for a session', async () => {
  const tool = { type: 'item.completed', item: { type: 'command_execution', aggregated_output: lines([{ type: 'thread.started', thread_id: fixtureId }]) } };
  const result = await runAgent(fake([tool, ...completed(prose)]), options);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'clean');
  assert.equal(result.report, prose);
  assert.equal(result.sessionId, null);
});

test('Codex captures only the provider thread event even when the report quotes another session', async () => {
  const result = await runAgent(fake([{ thread_id: providerId, type: 'thread.started' }, ...completed(prose)]), options);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, providerId);
  assert.equal(result.report, prose);
});

test('Codex selects final assistant text and rejects failed, empty or unfinished turns', () => {
  const tool = { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'NO NEW FINDINGS' } };
  const preamble = message('NO NEW FINDINGS');
  assert.equal(extractReport(lines([preamble, tool, ...completed('FINDING: bug\nWHERE: a.js:1')]), 'codex-json'), 'FINDING: bug\nWHERE: a.js:1');
  for (const events of [[], [tool, { type: 'turn.completed' }], [preamble], completed(''),
    [...completed('NO NEW FINDINGS'), { type: 'turn.started' }],
    [preamble, { type: 'item.started', item: { type: 'agent_message' } }, { type: 'turn.completed' }],
    [...completed('NO NEW FINDINGS'), { type: 'turn.failed', error: { message: 'failed' } }],
    [...completed('NO NEW FINDINGS'), { type: 'error', message: 'failed' }],
  ]) assert.throws(() => extractReport(lines(events), 'codex-json'));
  assert.throws(() => extractReport('NO NEW FINDINGS', 'codex-json'), /Invalid Codex JSON/);
});

test('Codex keeps only known or provider-established IDs after failures', async () => {
  const events = [{ type: 'thread.started', thread_id: providerId }];
  const failed = await runAgent(fake([...events, ...completed(prose)], prose, 2), options);
  assert.equal(failed.ok, false);
  assert.equal(failed.sessionId, providerId);
  const malformed = await runAgent(fake([...events, { type: 'turn.started' }]), options);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.sessionId, providerId, 'metadata survives an incomplete response');
  const unestablished = await runAgent(fake(completed(prose), prose, 2), options);
  assert.equal(unestablished.sessionId, null);
  const missing = { ...codex, argv: ['jury-missing-codex-fixture'], resume: { ...codex.resume, argv: ['jury-missing-codex-fixture', '{{sessionId}}'] } };
  assert.equal((await runAgent(missing, options)).sessionId, null);
  assert.equal((await runAgent(missing, { ...options, sessionId: providerId })).sessionId, providerId);
});

test('Codex streams decoded assistant text while preserving the raw JSON artifact', async () => {
  const text = 'NO NEW FINDINGS\n审查 🧪';
  const output = lines([{ type: 'thread.started', thread_id: providerId }, ...completed(text)]);
  const script = `const b=Buffer.from(${JSON.stringify(output)}); let i=0; const next=()=>{if(i<b.length){process.stdout.write(b.subarray(i,i+1));i++;setImmediate(next)}}; next();`;
  const chunks = [];
  const result = await runAgent({ ...codex, argv: [process.execPath, '-e', script] }, { ...options, onChunk: c => chunks.push(c) });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, providerId);
  assert.equal(result.report, text);
  assert.equal(chunks.join(''), text + '\n');
  assert.equal(result.raw, output);
});

test('all Codex invocations request metadata without changing role permissions', () => {
  for (const [argv, sandbox] of [[codex.argv, 'read-only'], [codex.judgeArgv, 'workspace-write'],
    [codex.resume.argv, 'read-only'], [codex.resume.judgeArgv, 'workspace-write']]) {
    assert.ok(argv.includes('--json'));
    assert.equal(argv[argv.indexOf('--sandbox') + 1], sandbox);
    assert.ok(!argv.includes('--last'));
  }
});
