import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('the actual test runner ignores a personal global judge and Git identity', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jury-runner-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personal = path.join(root, 'personal');
  await mkdir(path.join(personal, '.jury'), { recursive: true });
  await mkdir(path.join(root, 'test'));
  const config = path.join(personal, '.jury', 'config.json');
  await writeFile(config, '{"judge":"droid"}');
  const gitConfig = path.join(personal, '.gitconfig');
  await writeFile(gitConfig, '[user]\n name = Personal Identity\n email = personal@example.com\n');
  const configModule = new URL('../lib/config.js', import.meta.url).href;
  await writeFile(path.join(root, 'test', 'probe.test.js'), `
    const { test } = require('node:test');
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    test('isolated defaults', async () => {
      const { loadConfig } = await import(${JSON.stringify(configModule)});
      assert.equal((await loadConfig()).main.name, 'codex');
      assert.equal(execFileSync('git', ['config', '--global', 'user.email'], {encoding:'utf8'}).trim(), 'test@example.com');
    });
  `);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/test.mjs', import.meta.url))], {
    cwd: root, env: { ...process.env, HOME: personal, USERPROFILE: personal, GIT_CONFIG_GLOBAL: gitConfig }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(config, 'utf8'), '{"judge":"droid"}');
  assert.match(await readFile(gitConfig, 'utf8'), /personal@example.com/);
});
