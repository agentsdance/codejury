import { test as base, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { testEnvironment } from '../../scripts/test-environment.mjs';

export const agents = ['claude', 'codex', 'grok', 'droid', 'agy', 'main', 'custom-agent'];
const run = {
  target: { repo: 'fixture/timeline', id: '#1', title: 'Timeline browser fixture', judge: 'codex', state: 'review' },
  totalMin: 20, marks: [{ at: 0, l: 'round 1' }, { at: 6, l: 'round 2' }, { at: 7, l: 'round 3' }, { at: 11, l: 'round 4' }],
  lanes: agents.map(who => ({ who, label: who, segs: [
    { r: 1, s: 0, e: 5 }, { r: 2, s: 6, e: 6.05 },
    { r: 3, s: 7, e: 10, open: true }, { r: 4, s: 11, e: 15, abandoned: true },
    { r: 'reply', s: 16, e: 16, t: 'reply · 1.2s' },
  ] })), rounds: [], exchanges: [], ship: [], tlfoot: 'Timeline browser fixture',
};

export const test = base.extend({
  consoleURL: [async ({}, use) => {
    const installed = process.env.JURY_BROWSER_PACKAGE_ROOT;
    if (!installed) throw new Error('Use npm run test:browser so the console is tested from an installed package.');
    const root = await mkdtemp(path.join(tmpdir(), 'jury-browser-run-'));
    const isolated = testEnvironment();
    let child;
    let exited;
    let output = '';
    try {
      const dir = path.join(root, 'runs', 'timeline');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'run.json'), JSON.stringify(run));
      await writeFile(path.join(dir, 'events.ndjson'), JSON.stringify({ t: 'target', target: run.target }) + '\n');
      // Prevent opening a real desktop browser. Playwright opens the actual served URL below.
      const bin = path.join(root, 'bin'); await mkdir(bin);
      await writeFile(path.join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const reserved = net.createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
      const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
      child = spawn(process.execPath, [path.join(installed, 'bin/jury.js'), '--web-only', '--dir', root, '--run', 'timeline', '--port', String(port)], {
        cwd: root, env: { ...isolated.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      exited = once(child, 'exit');
      child.stdout.on('data', b => { output += b; });
      child.stderr.on('data', b => { output += b; });
      await expect.poll(() => {
        if (child.exitCode !== null) throw new Error(`Console exited: ${output}`);
        return /console: (http:\/\/127\.0\.0\.1:\d+\/\?run=timeline)/.exec(output)?.[1];
      }, { timeout: 15000, message: 'Installed CLI must start the saved-run console' }).toBeTruthy();
      const url = /console: (http:\/\/127\.0\.0\.1:\d+\/\?run=timeline)/.exec(output)[1];
      const response = await fetch(url);
      expect(await response.text()).toBe(await readFile(path.join(installed, 'web/index.html'), 'utf8'));
      await use(url);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (exited) await exited;
      isolated.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});
export { expect };
