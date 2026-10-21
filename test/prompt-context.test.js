import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const root = path.dirname(path.dirname(cli));
const { buildPrompt } = await import(pathToFileURL(path.join(root, 'lib/prompt.js')));
const { appendEvent } = await import(pathToFileURL(path.join(root, 'lib/store.js')));
const { refreshSettled } = await import(pathToFileURL(path.join(root, 'lib/loop.js')));
const options = { target: { repo: 'fixture/repo', id: '#1' }, trunk: 'master', stopToken: 'NO NEW FINDINGS' };
const settledSection = prompt => prompt.split('ALREADY SETTLED — do NOT re-report these, they are known and decided:\n\n')[1].split('\n\nWHAT I WANT')[0];

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-prompt-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, settledFile: path.join(dir, 'settled.md') };
}

test('the next review prompt preserves complete regenerated settled reasoning', async t => {
  const { dir, settledFile } = await scratch(t);
  const findings = [
    { id: 'one', verdict: 'rejected', reason: 'The lock is released on the error path.\nEvidence: the finally block runs before rejection.\n\n  The failure-path test confirms cleanup.' },
    { id: 'two', verdict: 'deferred', reason: 'Pre-existing behavior; no edit made.\n1. Reproduced on unchanged master.\n2. The current diff does not touch this path.\nThe follow-up needs a separate fix.' },
  ];
  for (const f of findings) {
    await appendEvent(dir, { t: 'finding.raised', id: f.id, round: 1, agent: 'fixture', claim: `${f.id} claim`, loc: 'file.js:1' });
    await appendEvent(dir, { t: 'finding.resolved', ...f });
  }
  await refreshSettled(dir);
  const saved = await readFile(settledFile, 'utf8');
  for (const f of findings) assert.ok(saved.includes(f.reason));
  const prompt = await buildPrompt({ ...options, settledFile });
  assert.equal(settledSection(prompt), saved.trim(), 'a fresh reviewer must receive the entire saved reasoning, including continuation lines');
});

test('missing settled files retain the caller-provided context and numbering', async t => {
  const { settledFile } = await scratch(t);
  const settled = ['1. Existing entry\nIts evidence.', 'Another entry\nIts evidence.'];
  for (const extra of [{}, { settledFile }]) {
    const prompt = await buildPrompt({ ...options, settled, ...extra });
    assert.equal(settledSection(prompt), '1. Existing entry\nIts evidence.\n2. Another entry\nIts evidence.');
  }
});

test('an empty regenerated list replaces stale caller-provided context', async t => {
  const { settledFile } = await scratch(t);
  await writeFile(settledFile, '\n  \n');
  const prompt = await buildPrompt({ ...options, settledFile, settled: ['Stale finding'] });
  assert.match(settledSection(prompt), /nothing settled yet/);
  assert.doesNotMatch(prompt, /Stale finding/);
});
