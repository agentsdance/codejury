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
const { buildReply } = await import(pathToFileURL(path.join(root, 'lib/reply.js')));
const { validateAgent } = await import(pathToFileURL(path.join(root, 'lib/agent-schema.js')));
const { appendEvent, readEvents } = await import(pathToFileURL(path.join(root, 'lib/store.js')));
const { findingsIn } = await import(pathToFileURL(path.join(root, 'lib/findings.js')));
const { replyRound, sessionsIn } = await import(pathToFileURL(path.join(root, 'lib/loop.js')));
const literal = 'Keep {{unknown}}, {{promptText}}, {{promptFile}}, {{worktree}}, {{packageDir}}, {{sessionId}}, {{model}}, {{modelArgs}}, $&, $1, and Unicode 文😀 unchanged.';

for (const mode of ['automatic', 'standalone']) {
  for (const delivery of ['argv', 'file']) {
    for (const resumed of [false, true]) {
      test(`${mode} ${delivery} reply preserves literal templates in a ${resumed ? 'resumed' : 'fresh'} session`, { timeout: 15000 }, async t => {
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
        const agent = { name: 'fixture-reviewer', role: 'reviewer', cwd: 'worktree', report: 'whole', promptDelivery: delivery,
          model: 'fixture-model', modelArgs: ['--model', '{{model}}'], argv,
          resume: { supported: true, argv: [process.execPath, capture, 'resume', '--session', '{{sessionId}}', ...argv.slice(3)] } };
        const dir = path.join(worktree, 'runs', 'reply-fixture');
        await appendEvent(dir, { t: 'target', target: { repo: 'fixture', id: '#1', judge: 'fixture-judge' } });
        if (resumed) await appendEvent(dir, { t: 'agent.report', agent: agent.name, round: 1, sessionId: 'provider-session' });
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
        assert.equal(call.args[call.args.indexOf('--model') + 1], 'fixture-model');
        assert.equal(call.args.filter(arg => arg === '--model').length, 1);
        assert.equal(events.find(e => e.t === 'reply.answered').verdict, 'clean');
        if (mode === 'standalone') assert.equal(await readFile(path.join(dir, `reply.${agent.name}.md`), 'utf8'), sent.text);
      });
    }
  }
}

for (const name of ['peer', 'peer-reviewer', 'peer-', 'peer--']) {
  test(`reply redaction recognizes complete ${name} names without changing partial words`, () => {
    assert.deepEqual(validateAgent({ ...DEFAULTS.agents.find(a => a.name === 'codex'), name }), []);
    const finding = { agent: 'fixture', status: 'rejected', claim: 'A defect', loc: 'file.js:1',
      reason: `Reason: [${name}], the ${name} report, a ${name.toUpperCase()} report; r12-${name}-3; 12-${name}-reply-3.`,
      reproduced: `Evidence: ${name}.`, test: `Test: ${name}.` };
    const build = f => buildReply({ agent: 'fixture', thread: [f], sha: 'abc', worktree: '/fixture', stopToken: 'NO NEW FINDINGS', others: [name] });
    const reply = build(finding);
    assert.ok(reply.includes("Reason: [another reviewer], another reviewer's report, another reviewer's report; another reviewer's finding; another reviewer's finding."));
    assert.ok(reply.includes('Reproduced first: Evidence: another reviewer.'));
    assert.ok(reply.includes('Regression test: Test: another reviewer.'));
    const partials = [
      `x${name}`, `${name}x`, `prefix-${name}`, `${name}-extended`, `_${name}`, `${name}_`,
      `é${name}`, `${name}中文`, `e\u0301${name}`, `${name}\u0301`,
      `${name}²`, `${name}¼`,
      `${name}$reviewer`, `${name}\u200Creviewer`, `${name}\u200Dreviewer`,
      `${name}‿reviewer`, `${name}⁀reviewer`,
      `prefix-r12-${name}-3`, `r12-${name}-3-suffix`, `r12-${name}-3x`, `r12-${name}-3_`,
      `r12-${name}-3²`, `r12-${name}-3¼`,
    ].join(' ');
    const reason = `Preserve: ${partials}`;
    assert.ok(build({ ...finding, reason }).includes(reason), 'do not redact part of a larger name, identifier, or Unicode word');
  });
}

for (const otherName of ['peer-reviewer', 'peer-']) {
  test(`standalone reply redacts accepted other reviewer ${otherName} before delivery`, async t => {
    const temp = await mkdtemp(path.join(tmpdir(), 'jury-reply-name-'));
    const isolated = testEnvironment();
    t.after(() => { isolated.dispose(); return rm(temp, { recursive: true, force: true }); });
    const worktree = path.join(temp, 'repo'); await mkdir(worktree);
    const capture = path.join(temp, 'capture.cjs');
    await writeFile(capture, "require('node:fs').writeFileSync('received.txt',process.argv[2]); console.log('NO NEW FINDINGS');\n");
    const receiver = { name: 'fixture-reviewer', role: 'reviewer', cwd: 'worktree', argv: [process.execPath, capture, '{{promptText}}'], report: 'whole' };
    const other = { ...DEFAULTS.agents.find(a => a.name === 'codex'), name: otherName, role: 'reviewer' };
    assert.deepEqual(validateAgent(other), []);
    other.argv = [process.execPath, '-e', "throw new Error('unselected reviewer must not run')"];
    await writeFile(path.join(worktree, 'jury.config.json'), JSON.stringify({ agents: [
      ...DEFAULTS.agents.map(a => ({ name: a.name, enabled: false })),
      { name: 'fixture-judge', role: 'main', argv: [process.execPath] }, receiver, other,
    ] }));
    const git = (...args) => exec('git', args, { cwd: worktree, env: isolated.env });
    await git('init', '-q', '-b', 'master'); await git('commit', '--allow-empty', '-qm', 'base');
    const dir = path.join(worktree, 'runs', 'reply-fixture');
    await appendEvent(dir, { t: 'target', target: { repo: 'fixture', id: '#1', judge: 'fixture-judge' } });
    await appendEvent(dir, { t: 'finding.raised', id: 'A', agent: receiver.name, round: 1, claim: 'A defect', loc: 'file.js:1' });
    await appendEvent(dir, { t: 'finding.resolved', id: 'A', verdict: 'rejected', reason: `The ${otherName} reviewer agreed; see r1-${otherName}-1.` });
    await exec(process.execPath, [cli, 'reply', '--dir', worktree, '--run', 'reply-fixture', '--reviewer', receiver.name],
      { cwd: worktree, env: isolated.env, timeout: 10000 });
    const received = await readFile(path.join(worktree, 'received.txt'), 'utf8');
    assert.equal(received, (await readEvents(dir)).find(e => e.t === 'reply.sent').text);
    assert.equal(received, await readFile(path.join(dir, `reply.${receiver.name}.md`), 'utf8'));
    assert.ok(received.includes("another reviewer's reviewer agreed; see another reviewer's finding."));
    assert.ok(!received.includes(otherName), 'the recipient must not learn the other reviewer identity');
  });
}
