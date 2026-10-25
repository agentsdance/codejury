import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const launchers = ['plugins/codejury/scripts/jury.mjs', 'plugin/scripts/jury.mjs'];

function fixture(t, { installed = false, windows = process.platform === 'win32', mode = 'ok', version = '0.9.0', latest = '0.9.0' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'codejury-global-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const globalRoot = path.join(root, 'global install with spaces', 'node_modules');
  const pkg = path.join(globalRoot, '@agentsdance', 'codejury');
  const entry = path.join(pkg, 'bin', 'jury.js');
  const cwd = path.join(root, 'repository with spaces');
  const cache = path.join(root, 'old-plugin-cache');
  const calls = path.join(root, 'npm-calls.jsonl');
  mkdirSync(bin);
  mkdirSync(cwd);
  // A project-local CLI must never shadow the global installation.
  writeFileSync(path.join(bin, windows ? 'jury.cmd' : 'jury'), windows ? '@exit /b 99\r\n' : '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const cli = `console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), entry: process.argv[1] })); process.exitCode = 7;`;
  const metadata = JSON.stringify({ name: '@agentsdance/codejury', version, type: 'module' });
  if (installed) {
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), metadata);
    writeFileSync(entry, cli);
  }
  const npm = path.join(bin, 'npm.cjs');
  writeFileSync(npm, `#!${process.execPath}
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
    if (args[0] === 'root' && args[1] === '--global') {
      if (${JSON.stringify(mode)} === 'root-fails') process.exit(13);
      console.log(${JSON.stringify(globalRoot)});
    } else if (args[0] === 'view') {
      if (${JSON.stringify(mode)} === 'registry-fails') process.exit(13);
      if (${JSON.stringify(mode)} === 'registry-stalls') setInterval(() => {}, 1000);
      else if (${JSON.stringify(mode)} === 'invalid-json') console.log('not json');
      else console.log(JSON.stringify(${JSON.stringify(latest)}));
    } else if (args[0] === 'install') {
      if (!args.includes('--global') || args.includes('--prefix')) throw new Error('installation must use the configured global prefix');
      if (!args.includes('@agentsdance/codejury@latest')) throw new Error('expected the latest stable global CLI');
      if (${JSON.stringify(mode)} === 'install-fails') { console.error('EACCES: global prefix is not writable'); process.exit(13); }
      if (${JSON.stringify(mode)} !== 'empty-install') {
        fs.mkdirSync(${JSON.stringify(path.dirname(entry))}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(path.join(pkg, 'package.json'))}, ${JSON.stringify(metadata)});
        fs.writeFileSync(${JSON.stringify(entry)}, ${JSON.stringify(cli)});
      }
    } else throw new Error('unexpected npm command: ' + JSON.stringify(args));
  `, { mode: 0o755 });
  if (process.platform === 'win32') {
    writeFileSync(path.join(bin, 'npm.cmd'), `@"${process.execPath}" "${npm}" %*\r\n`);
  } else {
    writeFileSync(path.join(bin, windows ? 'npm.cmd' : 'npm'), readFileSync(npm), { mode: 0o755 });
  }
  const nodeArgs = [];
  if (windows && process.platform !== 'win32') {
    const preload = path.join(root, 'windows.mjs');
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' }); process.env.comspec = '/bin/sh';\n");
    nodeArgs.push('--import', pathToFileURL(preload).href);
  }
  return {
    entry, cwd, cache, bin,
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    run: (launcher, args = ['version']) => spawnSync(process.execPath, [...nodeArgs, fileURLToPath(new URL('../' + launcher, import.meta.url)), ...args], {
      cwd, env: { ...process.env, PATH: bin, CODEJURY_PLUGIN_CACHE: cache }, encoding: 'utf8', timeout: 10000,
    }),
  };
}

for (const launcher of launchers) {
  for (const windows of process.platform === 'win32' ? [true] : [false, true]) {
    const label = `${launcher} (${windows ? 'Windows' : 'POSIX'})`;
    test(`${label} reuses the global CLI even when PATH contains another jury`, t => {
      const f = fixture(t, { installed: true, windows });
      const args = ['review', 'https://github.com/owner/repo/pull/1', '--push=false', '--summary', 'literal $(touch unwanted) `echo bad` ; & "text"'];
      const result = f.run(launcher, args);
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { cwd: f.cwd, argv: args, entry: f.entry });
      assert.deepEqual(f.calls(), [['root', '--global']], 'an existing global CLI must not be reinstalled or upgraded');
      assert.equal(existsSync(f.cache), false);
      assert.equal(existsSync(path.join(f.cwd, 'unwanted')), false);
    });

    test(`${label} installs globally once, then reuses that installation`, t => {
      const f = fixture(t, { windows });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = f.run(launcher);
        assert.equal(result.status, 7, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { cwd: f.cwd, argv: ['version'], entry: f.entry });
      }
      const installs = f.calls().filter(args => args[0] === 'install');
      assert.equal(installs.length, 1);
      assert.ok(installs[0].includes('--global'));
      assert.equal(installs[0].includes('--prefix'), false);
      assert.equal(existsSync(f.cache), false);
      assert.equal(existsSync(path.join(f.cwd, 'node_modules')), false);
    });

    test(`${label} version preflight offers a newer global CLI without upgrading`, t => {
      const f = fixture(t, { installed: true, windows, version: '0.9.9', latest: '0.10.0' });
      const result = f.run(launcher);
      assert.equal(result.status, 7, result.stderr);
      assert.match(result.stderr, /CodeJury update available: 0\.9\.9 -> 0\.10\.0/);
      assert.match(result.stderr, /Upgrade the global CLI\?/);
      assert.match(result.stderr, /npm install --global @agentsdance\/codejury@0\.10\.0/);
      assert.deepEqual(JSON.parse(result.stdout), { cwd: f.cwd, argv: ['version'], entry: f.entry });
      assert.equal(f.calls().filter(args => args[0] === 'view').length, 1);
      assert.equal(f.calls().filter(args => args[0] === 'install').length, 0);
      assert.equal(existsSync(f.cache), false);
    });
  }

  test(`${launcher} compares stable versions numerically and respects prereleases and build metadata`, t => {
    for (const [version, latest, update] of [
      ['0.10.0', '0.10.0', false],
      ['0.11.0', '0.10.0', false],
      ['0.11.0-rc.1', '0.10.0', false],
      ['0.10.0+local', '0.10.0', false],
      ['0.10.0', '0.10.0+build.2', false],
      ['0.10.0-rc.1', '0.10.0', true],
      ['0.10.0', '0.10.1', true],
      ['0.10.0', '1.0.0', true],
    ]) {
      const f = fixture(t, { installed: true, version, latest });
      const result = f.run(launcher);
      assert.equal(result.status, 7, result.stderr);
      assert.equal(result.stderr.includes('CodeJury update available:'), update, `${version} -> ${latest}`);
      assert.doesNotMatch(result.stderr, /Update check unavailable/);
      assert.equal(f.calls().filter(args => args[0] === 'install').length, 0);
    }
  });

  test(`${launcher} checks version aliases without checking ordinary CLI commands`, t => {
    const f = fixture(t, { installed: true, latest: '0.10.0' });
    for (const command of ['--version', '-v', 'agents', 'runs', 'help']) {
      const result = f.run(launcher, [command]);
      assert.equal(result.status, 7, result.stderr);
      assert.equal(result.stderr.includes('CodeJury update available:'), ['--version', '-v'].includes(command));
    }
    assert.equal(f.calls().filter(args => args[0] === 'view').length, 2);
  });

  for (const mode of ['registry-fails', 'registry-stalls', 'invalid-json']) {
    test(`${launcher} continues with the installed CLI when ${mode}`, t => {
      const f = fixture(t, { installed: true, mode });
      const started = Date.now();
      const result = f.run(launcher);
      assert.equal(result.status, 7, result.stderr);
      assert.match(result.stderr, /Update check unavailable/);
      assert.doesNotMatch(result.stderr, /CodeJury update available/);
      assert.equal(f.calls().filter(args => args[0] === 'install').length, 0);
      assert.ok(Date.now() - started < 8000, 'registry check must be bounded');
    });
  }

  test(`${launcher} ignores malformed, missing, or prerelease latest metadata`, t => {
    for (const latest of ['0.11.0-rc.1', '0.10', '01.0.0', '0.10.1; touch unwanted', { error: 'not found' }, null]) {
      const f = fixture(t, { installed: true, latest });
      const result = f.run(launcher);
      assert.equal(result.status, 7, result.stderr);
      assert.match(result.stderr, /Update check unavailable/);
      assert.doesNotMatch(result.stderr, /CodeJury update available|touch unwanted/);
      assert.equal(f.calls().filter(args => args[0] === 'install').length, 0);
    }
  });

  for (const mode of ['root-fails', 'install-fails', 'empty-install']) {
    test(`${launcher} stops on ${mode} without falling back to a private cache`, t => {
      const f = fixture(t, { mode });
      const result = f.run(launcher);
      assert.notEqual(result.status, 0);
      assert.notEqual(result.status, 7, 'the CLI must not be invoked');
      assert.match(result.stderr, /global/i);
      assert.equal(f.calls().filter(args => args[0] === 'install').length, mode === 'root-fails' ? 0 : 1);
      assert.equal(existsSync(f.cache), false);
      assert.equal(existsSync(path.join(f.cwd, 'node_modules')), false);
    });
  }
}
