import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testEnvironment } from '../scripts/test-environment.mjs';

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const root = path.dirname(path.dirname(cli));
const { DEFAULTS } = await import(pathToFileURL(path.join(root, 'lib/config.js')));
const { appendEvent, readEvents } = await import(pathToFileURL(path.join(root, 'lib/store.js')));
const { findingsIn } = await import(pathToFileURL(path.join(root, 'lib/findings.js')));
const { replyRound, sessionsIn } = await import(pathToFileURL(path.join(root, 'lib/loop.js')));
const literal = 'Keep {{unknown}}, {{promptText}}, {{promptFile}}, {{worktree}}, {{packageDir}}, {{sessionId}}, {{model}}, {{modelArgs}}, $&, $1, and Unicode 文😀 unchanged.';

for (const mode of ['automatic', 'standalone']) {
  for (const delivery of ['argv', 'file']) {
    for (const sessionMode of ['fresh', 'resumed', 'unsupported']) {
      const resumed = sessionMode === 'resumed';
      test(`${mode} ${delivery} reply preserves literal templates with ${sessionMode} resume`, { timeout: 15000 }, async t => {
        const temp = await mkdtemp(path.join(tmpdir(), 'jury-reply-template-'));
        const isolated = testEnvironment();
        t.after(() => { isolated.dispose(); return rm(temp, { recursive: true, force: true }); });
        const worktree = path.join(temp, 'work tree');
        await mkdir(worktree);
        const capture = path.join(temp, 'capture.cjs');
        await writeFile(capture, `
          const fs = require('node:fs');
          const args = process.argv.slice(2);
          const value = flag => args[args.indexOf(flag) + 1];
          const prompt = ${delivery === 'file'} ? fs.readFileSync(value('--content'), 'utf8') : value('--content');
          fs.writeFileSync('call.json', JSON.stringify({ args, prompt }));
          console.log('NO NEW FINDINGS');
        `);
        const argv = [process.execPath, capture, 'fresh', '{{modelArgs}}', '--worktree', '{{worktree}}', '--content', delivery === 'file' ? '{{promptFile}}' : '{{promptText}}'];
        if (mode === 'automatic') argv.push('--sha', '{{sha}}');
        const agent = { name: 'fixture-reviewer', role: 'reviewer', cwd: 'worktree', report: 'whole', promptDelivery: delivery,
          model: 'fixture-model', modelArgs: ['--model', '{{model}}'], argv,
          resume: { supported: sessionMode !== 'unsupported', argv: [process.execPath, capture, 'resume', '--session', '{{sessionId}}', ...argv.slice(3)] } };
        const dir = path.join(worktree, 'runs', 'reply-fixture');
        await appendEvent(dir, { t: 'target', target: { repo: 'fixture', id: '#1', judge: 'fixture-judge' } });
        if (sessionMode !== 'fresh') await appendEvent(dir, { t: 'agent.report', agent: agent.name, round: 1, sessionId: 'provider-session' });
        await appendEvent(dir, { t: 'finding.raised', id: 'A', agent: agent.name, round: 1, claim: 'Literal content', loc: 'template.js:1', body: literal });
        await appendEvent(dir, { t: 'finding.resolved', id: 'A', verdict: 'rejected', reason: literal });
        if (mode === 'automatic') {
          const answers = await replyRound({ dir, pool: [agent], cfg: { stopToken: 'NO NEW FINDINGS' }, worktree, sha: 'abc123', round: 1,
            findings: await findingsIn(dir), sessions: sessionsIn(await readEvents(dir)) });
          assert.equal(answers[0].clean, true);
        } else {
          const git = (...args) => exec('git', args, { cwd: worktree, env: isolated.env });
          await git('init', '-q', '-b', 'master');
          await git('commit', '--allow-empty', '-qm', 'base');
          await writeFile(path.join(worktree, 'jury.config.json'), JSON.stringify({ agents: [
            ...DEFAULTS.agents.map(a => ({ name: a.name, enabled: false })),
            { name: 'fixture-judge', role: 'main', argv: [process.execPath] }, agent,
          ] }));
          await exec(process.execPath, [cli, 'reply', '--dir', worktree, '--run', 'reply-fixture', '--reviewer', agent.name],
            { cwd: worktree, env: isolated.env, timeout: 10000 });
        }
        const events = await readEvents(dir);
        const sent = events.find(e => e.t === 'reply.sent');
        const call = JSON.parse(await readFile(path.join(worktree, 'call.json'), 'utf8'));
        assert.equal(call.prompt, sent.text, 'delivered prompt must exactly match the persisted reply');
        assert.ok(call.prompt.includes(literal));
        assert.equal(call.args[0], resumed ? 'resume' : 'fresh');
        assert.equal(sent.resumed, resumed);
        if (resumed) assert.equal(call.args[call.args.indexOf('--session') + 1], 'provider-session');
        assert.equal(call.args[call.args.indexOf('--worktree') + 1], worktree);
        if (mode === 'automatic') assert.equal(call.args[call.args.indexOf('--sha') + 1], 'abc123');
        assert.equal(call.args[call.args.indexOf('--model') + 1], 'fixture-model');
        assert.equal(call.args.filter(arg => arg === '--model').length, 1);
        assert.equal(events.find(e => e.t === 'reply.answered').verdict, 'clean');
        if (sessionMode === 'unsupported') assert.notEqual(events.find(e => e.t === 'reply.answered').sessionId, 'provider-session');
        if (mode === 'standalone') assert.equal(await readFile(path.join(dir, `reply.${agent.name}.md`), 'utf8'), sent.text);
      });
    }
  }
}
