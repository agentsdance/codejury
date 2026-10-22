import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const launcher = fileURLToPath(new URL('../plugins/codejury/scripts/jury.mjs', import.meta.url));

for (const windows of process.platform === 'win32' ? [true] : [false, true]) {
  test(`plugin launcher prefers an installed CodeJury ${windows ? 'Windows shim' : 'POSIX symlink'} over downloading`, () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'codejury-global-')));
    try {
      const bin = path.join(root, 'global install with spaces');
      const pkg = path.join(bin, 'node_modules', '@agentsdance', 'codejury');
      const entry = path.join(pkg, 'bin', 'jury.js');
      const cache = path.join(root, 'unused-cache');
      const cwd = path.join(root, 'repository with spaces');
      mkdirSync(path.dirname(entry), { recursive: true });
      mkdirSync(cwd);
      writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@agentsdance/codejury', version: '0.8.2', type: 'module' }));
      writeFileSync(entry, `#!${process.execPath}\nconsole.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), version: '0.8.2' })); process.exitCode = 7;`, { mode: 0o755 });
      const env = { ...process.env, PATH: bin, CODEJURY_PLUGIN_CACHE: cache };
      const nodeArgs = [];
      if (windows && process.platform !== 'win32') {
        const preload = path.join(root, 'windows.mjs');
        writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });");
        nodeArgs.push('--import', pathToFileURL(preload).href);
      }
      for (const command of ['jury', 'codejury']) {
        const executable = path.join(bin, command + (windows ? '.cmd' : ''));
        // Resolve npm's JS entrypoint without executing a Windows shell shim.
        if (windows) writeFileSync(executable, '@exit /b 99\r\n');
        else symlinkSync(entry, executable);
        for (const push of ['--push=true', '--push=false']) {
          const args = ['review', 'https://github.com/owner/repo/pull/1', push, '--summary', 'literal $(touch unwanted) `echo bad` ; & "text"'];
          const result = spawnSync(process.execPath, [...nodeArgs, launcher, ...args], { cwd, env, encoding: 'utf8' });
          assert.equal(result.status, 7, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), { cwd, argv: args, version: '0.8.2' });
          assert.equal(existsSync(cache), false, 'global CLI must run before creating or installing a fallback cache');
          assert.equal(existsSync(path.join(cwd, 'unwanted')), false);
        }
        rmSync(executable);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('plugin launcher installs into Windows cache paths containing spaces', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'codejury-plugin-')));
  try {
    const cache = path.join(root, 'Jane Doe', '.cache', 'codejury', 'plugin-cli');
    const cwd = path.join(root, 'repository with spaces');
    const bin = path.join(root, 'bin');
    mkdirSync(cwd);
    mkdirSync(bin);
    const fixture = path.join(bin, 'npm.cjs');
    writeFileSync(fixture, `#!${process.execPath}
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const args = process.argv.slice(2);
      assert.equal(args[0], 'install');
      assert.equal(args[1], '--prefix');
      assert.equal(path.resolve(args[2]), process.cwd(), 'npm received a split cache path: ' + JSON.stringify(args));
      assert.deepEqual(args.slice(3), ['--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '@agentsdance/codejury@0.9.0']);
      const pkg = path.join(path.resolve(args[2]), 'node_modules', '@agentsdance', 'codejury');
      fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@agentsdance/codejury', version: '0.9.0', type: 'module' }));
      fs.writeFileSync(path.join(pkg, 'bin', 'jury.js'), 'console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));');
    `);
    const preload = path.join(root, 'windows.mjs');
    const env = { ...process.env, CODEJURY_PLUGIN_CACHE: cache, PATH: bin };
    const nodeArgs = [];
    if (process.platform === 'win32') {
      writeFileSync(path.join(bin, 'npm.cmd'), `@"${process.execPath}" "${fixture}" %*\r\n`);
    } else {
      writeFileSync(path.join(bin, 'npm.cmd'), readFileSync(fixture), { mode: 0o755 });
      // Exercise the Windows launcher branch with a real shell on other hosts.
      // Both shells split an unquoted prefix at spaces; Windows uses cmd.exe above.
      writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });\nprocess.env.comspec = '/bin/sh';\n");
      nodeArgs.push('--import', pathToFileURL(preload).href);
    }
    const result = spawnSync(process.execPath, [...nodeArgs, launcher, 'version'], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: realpathSync(cwd), argv: ['version'] });
    const metadata = JSON.parse(readFileSync(path.join(cache, '0.9.0', 'node_modules', '@agentsdance', 'codejury', 'package.json'), 'utf8'));
    assert.equal(metadata.version, '0.9.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plugin launcher falls back when jury on PATH is not a CodeJury installation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codejury-plugin-'));
  try {
    const pkg = path.join(root, 'cache', '0.9.0', 'node_modules', '@agentsdance', 'codejury');
    const cwd = path.join(root, 'repository with spaces');
    const shadow = path.join(root, 'bin');
    mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    mkdirSync(cwd);
    mkdirSync(shadow);
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@agentsdance/codejury', version: '0.9.0', type: 'module' }));
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
    const install = path.join(root, '0.9.0');
    mkdirSync(install);
    writeFileSync(path.join(install, 'keep.txt'), 'preserve');
    const result = spawnSync(process.execPath, [launcher, 'version'], {
      env: { ...process.env, CODEJURY_PLUGIN_CACHE: root, PATH: root }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Incomplete CLI cache/);
    assert.equal(readFileSync(path.join(install, 'keep.txt'), 'utf8'), 'preserve');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plugin launcher reuses a cache published after its initial miss', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codejury-cache-race-'));
  try {
    const cache = path.join(root, 'cache');
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'npm-calls');
    const peerResult = path.join(root, 'peer.json');
    const metadata = path.join(cache, '0.9.0', 'node_modules', '@agentsdance', 'codejury', 'package.json');
    mkdirSync(bin);
    const fixture = path.join(bin, 'npm.cjs');
    writeFileSync(fixture, `#!${process.execPath}
      const fs = require('node:fs'), path = require('node:path');
      fs.appendFileSync(${JSON.stringify(calls)}, 'install\\n');
      const pkg = path.join(process.cwd(), 'node_modules', '@agentsdance', 'codejury');
      fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@agentsdance/codejury', version: '0.9.0', type: 'module' }));
      fs.writeFileSync(path.join(pkg, 'bin', 'jury.js'), 'console.log("cached fixture CLI");');
    `);
    if (process.platform === 'win32') {
      writeFileSync(path.join(bin, 'npm.cmd'), `@"${process.execPath}" "${fixture}" %*\r\n`);
    } else {
      writeFileSync(path.join(bin, 'npm'), readFileSync(fixture), { mode: 0o755 });
    }
    const preload = path.join(root, 'interleave.mjs');
    // Finish a second real launcher between the first launcher's failed read
    // and its directory check. This reproduces the interleaving without sleeps.
    writeFileSync(preload, `
      import fs from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.readFileSync;
      let fired = false;
      fs.readFileSync = function(file, ...args) {
        try { return original.call(this, file, ...args); }
        catch (error) {
          if (!fired && file === ${JSON.stringify(metadata)} && error.code === 'ENOENT') {
            fired = true;
            const result = spawnSync(process.execPath, [${JSON.stringify(launcher)}, 'version'], {
              env: process.env, encoding: 'utf8', timeout: 10000,
            });
            fs.writeFileSync(${JSON.stringify(peerResult)}, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error('peer launcher failed');
          }
          throw error;
        }
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, launcher, 'version'], {
      env: { ...process.env, CODEJURY_PLUGIN_CACHE: cache, PATH: bin },
      encoding: 'utf8', timeout: 20000,
    });
    assert.ifError(result.error);
    const peer = JSON.parse(readFileSync(peerResult, 'utf8'));
    assert.equal(peer.status, 0, peer.stderr);
    assert.equal(peer.stdout.trim(), 'cached fixture CLI');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'cached fixture CLI');
    assert.equal(readFileSync(calls, 'utf8'), 'install\n', 'the completed cache must be reused without another installation');
    assert.equal(JSON.parse(readFileSync(metadata, 'utf8')).version, '0.9.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
