import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../plugins/codejury/scripts/jury.mjs', import.meta.url));

test('plugin launcher preserves cwd, literal arguments, and exit status without using a shadowed jury', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codejury-plugin-'));
  try {
    const pkg = path.join(root, 'cache', '0.8.2-rc.1', 'node_modules', '@agentsdance', 'codejury');
    const cwd = path.join(root, 'repository with spaces');
    const shadow = path.join(root, 'bin');
    mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    mkdirSync(cwd);
    mkdirSync(shadow);
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@agentsdance/codejury', version: '0.8.2-rc.1', type: 'module' }));
    writeFileSync(path.join(pkg, 'bin', 'jury.js'), 'console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) })); process.exitCode = 7;');
    writeFileSync(path.join(shadow, 'jury'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const args = ['review', '--summary', 'literal $(touch unwanted) `echo bad` ; & "text"'];
    const result = spawnSync(process.execPath, [launcher, ...args], {
      cwd, env: { ...process.env, CODEJURY_PLUGIN_CACHE: path.join(root, 'cache'), PATH: shadow }, encoding: 'utf8',
    });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: realpathSync(cwd), argv: args });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plugin launcher rejects an incomplete cache without replacing user files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codejury-plugin-'));
  try {
    const install = path.join(root, '0.8.2-rc.1');
    mkdirSync(install);
    writeFileSync(path.join(install, 'keep.txt'), 'preserve');
    const result = spawnSync(process.execPath, [launcher, 'version'], {
      env: { ...process.env, CODEJURY_PLUGIN_CACHE: root }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Incomplete CLI cache/);
    assert.equal(readFileSync(path.join(install, 'keep.txt'), 'utf8'), 'preserve');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
