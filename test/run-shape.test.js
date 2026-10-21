import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const packageRoot = path.dirname(path.dirname(cli));
const { listRuns, foldEvents } = await import(pathToFileURL(path.join(packageRoot, 'lib/store.js')));
const { serve } = await import(pathToFileURL(path.join(packageRoot, 'lib/server.js')));
const valid = () => foldEvents([], { target: { repo: 'fixture/good', id: '#1', title: 'Readable review', state: 'converged' } });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'jury-run-shape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'runs');
  const save = async (slug, run) => {
    const dir = path.join(base, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'run.json'), JSON.stringify(run));
    return path.join(dir, 'run.json');
  };
  return { root, base, save };
}

test('non-object saved snapshots are skipped with a diagnostic', async t => {
  const { base, save } = await fixture(t);
  await save('good', valid());
  for (const [i, value] of [null, [], 'not a run', 42].entries()) await save(`bad-${i}`, value);
  const { runs, skipped } = await listRuns(base);
  assert.deepEqual(runs.map(r => r.slug), ['good']);
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every(s => /run.json.*object/i.test(s.reason)));
});

test('malformed saved-run containers cannot enter the shared listing', async t => {
  const { base, save } = await fixture(t);
  await save('good', valid());
  const arrays = ['rounds', 'exchanges', 'replies', 'lanes', 'marks', 'ship'];
  for (const field of arrays) await save(`bad-${field}`, { ...valid(), [field]: {} });
  await save('bad-target', { ...valid(), target: [] });
  const { runs, skipped } = await listRuns(base);
  assert.deepEqual(runs.map(r => r.slug), ['good']);
  assert.equal(skipped.length, arrays.length + 1);
  for (const field of [...arrays, 'target']) {
    assert.match(skipped.find(s => s.dir === `bad-${field}`).reason, new RegExp(field));
  }
});

test('minimal legacy runs and unknown metadata remain readable without rewriting', async t => {
  const { base, save } = await fixture(t);
  const legacy = { target: { id: '#1' }, rounds: [], exchanges: [], extension: { future: true } };
  const file = await save('legacy', legacy);
  const before = await readFile(file, 'utf8');
  const { runs, skipped } = await listRuns(base);
  assert.deepEqual(skipped, []);
  assert.deepEqual(runs, [{ slug: 'legacy', ...legacy }]);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('jury runs displays a valid review alongside a malformed snapshot', async t => {
  const { root, save } = await fixture(t);
  await save('good', valid());
  const file = await save('bad', { ...valid(), target: { id: '#0', state: 'human' }, exchanges: {} });
  const before = await readFile(file, 'utf8');
  const result = spawnSync(process.execPath, [cli, 'runs', '--dir', root], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Readable review/);
  assert.match(result.stdout, /SKIPPED bad:.*exchanges/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('console run APIs retain valid neighbors and report the skipped count', async t => {
  const { root, save } = await fixture(t);
  await save('good', valid());
  await save('bad', { ...valid(), exchanges: {} });
  const logs = [];
  const { server, url } = await serve({ cwd: root, port: 0, onLog: text => logs.push(text) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const endpoint of ['/api/run', '/api/runs']) {
    const response = await fetch(url + endpoint);
    assert.equal(response.status, 200);
    const run = await response.json();
    assert.equal(run.slug, 'good');
    assert.equal(run.target.title, 'Readable review');
  }
  const health = await (await fetch(url + '/api/health')).json();
  assert.equal(health.runs, 1);
  assert.equal(health.skipped, 1);
  assert.ok(logs.some(line => /skipped bad:.*exchanges/.test(line)));
});

test('all-invalid snapshots produce no readable runs rather than a broken payload', async t => {
  const { root, save } = await fixture(t);
  await save('bad', { ...valid(), exchanges: {} });
  const result = spawnSync(process.execPath, [cli, 'runs', '--dir', root], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIPPED bad:.*exchanges/);
  assert.match(result.stdout, /no readable runs/);
  const { server, url } = await serve({ cwd: root, port: 0, onLog: () => {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(url + '/api/run');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'no runs yet' });
});
