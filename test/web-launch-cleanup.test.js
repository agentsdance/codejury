import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testEnvironment } from '../scripts/test-environment.mjs';
import { cleanupStack } from './helpers/cleanup-stack.js';

test('fixture cleanup attempts every resource and preserves failures', async () => {
  let run;
  const cleanup = cleanupStack({ after: callback => { run = callback; } });
  const events = [];
  const childError = new Error('child cleanup failed');
  const filesError = new Error('file cleanup failed');
  cleanup(() => { events.push('files'); throw filesError; });
  cleanup(() => { events.push('socket'); });
  cleanup(() => { events.push('child'); throw childError; });
  await assert.rejects(run, error => {
    assert.deepEqual(error.errors, [childError, filesError]);
    return true;
  });
  assert.deepEqual(events, ['child', 'socket', 'files']);
});

for (const pattern of [
  'default web opens the current run on an OS-assigned port',
  'web-only opens a saved run on an OS-assigned port without starting a review',
]) {
  test(`cleanup reaps the console before a deletion failure: ${pattern}`, {
    timeout: 20000, skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jury-cleanup-regression-'));
    const isolated = testEnvironment();
    const trace = path.join(root, 'events.jsonl');
    const preload = path.join(root, 'fault.cjs');
    await writeFile(trace, '');
    // Fail only the outer fixture deletion, after its real console has opened.
    // A marker synchronizes the assertion; elapsed time is only a hang bound.
    await writeFile(preload, `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const log = (event, extra = {}) => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({event, ...extra})+'\\n');
const spawn = cp.spawn;
cp.spawn = function(...args) {
  const child = Reflect.apply(spawn, this, args);
  if (args[1]?.some(arg => path.basename(String(arg)) === 'jury.js')) {
    log('spawn', {pid:child.pid});
    child.once('exit', () => log('exit', {pid:child.pid}));
  }
  return child;
};
const rm = fs.promises.rm;
fs.promises.rm = async function(directory, options) {
  if (/^jury-(web-test|saved-console)-/.test(path.basename(String(directory)))) {
    log('cleanup-error', {root:String(directory)});
    process.stderr.write('JURY_CLEANUP_FAILURE\\n');
    const error = new Error('Injected fixture deletion failure');
    error.code = 'ENOTEMPTY';
    throw error;
  }
  return Reflect.apply(rm, this, arguments);
};
require('node:module').syncBuiltinESMExports();
`);
    let child, exited, timer;
    let events = [];
    try {
      child = spawn(process.execPath, ['--require', preload, `--test-name-pattern=^${pattern}$`,
        path.resolve('test/web-launch.test.js')], {
        env: isolated.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      exited = once(child, 'exit');
      let output = '';
      const barrier = new Promise((resolve, reject) => {
        const observe = chunk => {
          output += chunk;
          if (output.includes('JURY_CLEANUP_FAILURE')) resolve();
        };
        child.stdout.on('data', observe);
        child.stderr.on('data', observe);
        child.once('error', reject);
        child.once('exit', () => {
          if (!output.includes('JURY_CLEANUP_FAILURE')) reject(new Error(output));
        });
      });
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture did not finish: ${output}`)), 15000);
      });
      await Promise.race([barrier, deadline]);
      events = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      const launched = events.filter(event => event.event === 'spawn');
      assert.equal(launched.length, 1, output);
      const stopped = events.findIndex(event => event.event === 'exit' && event.pid === launched[0].pid);
      const failed = events.findIndex(event => event.event === 'cleanup-error');
      assert.ok(stopped >= 0 && stopped < failed, `Console must exit before deleting its files: ${JSON.stringify(events)}`);
      const [code] = await Promise.race([exited, deadline]);
      assert.equal(code, 1, 'the injected cleanup error must still fail the inner test');
    } finally {
      clearTimeout(timer);
      // The failing-before case deliberately leaves a console alive. Reap only
      // this fixture's process group, including a child surviving its parent.
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        await exited.catch(() => {});
      }
      events = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      for (const event of events.filter(event => event.event === 'cleanup-error')) {
        await rm(event.root, { recursive: true, force: true });
      }
      isolated.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
