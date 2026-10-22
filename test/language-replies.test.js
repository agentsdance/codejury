import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const cli = process.env.JURY_TEST_CLI ?? new URL('../bin/jury.js', import.meta.url).pathname;
const root = path.dirname(path.dirname(cli));
const load = name => import(pathToFileURL(path.join(root, 'lib', name)));
const {appendEvent, readEvents} = await load('store.js');
const {findingsIn} = await load('findings.js');
const {replyRound, outstanding} = await load('loop.js');
const {languageIn} = await load('language.js');

async function reply(t, claim, report, language = 'zh-CN') {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-language-reply-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const agent = {name: 'fixture', argv: [process.execPath, '-e', `console.log(${JSON.stringify(report)})`]};
  await appendEvent(dir, {t: 'finding.raised', id: 'A', agent: agent.name, round: 1, claim, loc: 'value.js:1'});
  await appendEvent(dir, {t: 'finding.resolved', id: 'A', verdict: 'rejected', reason: 'Checked'});
  const [answer] = await replyRound({dir, pool: [agent], cfg: {stopToken: 'NO NEW FINDINGS'},
    worktree: dir, sha: 'abc', round: 1, language, findings: await findingsIn(dir)});
  assert.equal(answer.failed, false);
  return {answer, events: await readEvents(dir), findings: await findingsIn(dir)};
}

test('distinct Chinese findings with the same severity survive reply deduplication', async t => {
  const {answer, events, findings} = await reply(t, '[P2] 数值错误',
    'FINDING: [P2] 缺少权限检查\nWHERE: auth.js:20\n需要检查权限。');
  assert.equal(answer.raised, 1);
  assert.equal(outstanding(findings, events).filter(f => f.id !== 'A').length, 1);
});

for (const [label, claim, report, contested, language] of [
  ['Chinese title without severity', '[P2] 缺少权限检查', '我仍然不同意：缺少权限检查的问题依然存在。', true],
  ['Chinese title with severity', '[P2] 条件错误', '[P2] 条件错误仍然存在，并没有修复。', true],
  ['unrelated Chinese response', '[P2] 缺少权限检查', '另外发现了数值错误。', false],
  ['Russian title without severity', '[P2] Отсутствует проверка доступа',
    'Я по-прежнему не согласен: Отсутствует проверка доступа, проблема не исправлена.', true, 'ru'],
  ['Korean title without severity', '[P2] 접근 권한 검사 누락',
    '여전히 동의하지 않습니다: 접근 권한 검사 누락 문제가 해결되지 않았습니다.', true, 'ko'],
  ['unrelated Russian response', '[P2] Отсутствует проверка доступа',
    'Обнаружена ошибка вычисления.', false, 'ru'],
  ['unrelated Korean response', '[P2] 접근 권한 검사 누락',
    '계산 오류를 발견했습니다.', false, 'ko'],
  ['empty title after severity', '[P2]', 'Обнаружена ошибка вычисления.', false, 'ru'],
  ['English control', '[P2] Missing authorization validation', 'Missing authorization validation remains a problem.', true],
]) test(`reply disputes reach triage: ${label}`, async t => {
  const {events, findings} = await reply(t, claim, report, language);
  assert.equal(events.filter(e => e.t === 'finding.turn' && e.id === 'A').length, Number(contested));
  assert.equal(findings.get('A').contested, contested);
  assert.equal(outstanding(findings, events).some(f => f.id === 'A'), contested);
});

for (const [initial, language, claim, message] of [
  ['en', 'zh-CN', '[P2] Missing authorization validation',
    '我仍然不同意：缺少权限校验的问题依然存在，尚未修复。'],
  ['zh-CN', 'en', '[P2] 缺少权限校验',
    'I still disagree: missing authorization validation remains unfixed.'],
]) for (const resumed of [false, true]) {
  test(`translated disputes retain finding IDs: ${initial} to ${language}, resumed=${resumed}`, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jury-language-switch-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    // The fixture can return an ID only if the delivered prompt supplies it.
    const argv = [process.execPath, '-e', `
      const prompt = process.argv[1];
      const ids = [...prompt.matchAll(/^Finding ID: (.+)$/gm)].map(match => match[1]);
      const marker = ids[1] ? 'DISPUTE: ' + ids[1] + '\\n' : '';
      console.log('...\\n'.repeat(8) + marker + ${JSON.stringify(message)});
    `, '{{promptText}}'];
    const agent = {name: 'fixture', argv, resume: {supported: true, argv: [...argv, '{{sessionId}}']}};
    const id = 'r1-fixture-10', neighbor = 'r1-fixture-1', other = 'r1-peer-1';
    await appendEvent(dir, {t: 'target', target: {language: initial}});
    for (const [findingId, owner, title] of [
      [neighbor, agent.name, '[P2] Numeric overflow'],
      [id, agent.name, claim],
      [other, 'peer', '[P2] Missing validation'],
    ]) {
      await appendEvent(dir, {t: 'finding.raised', id: findingId, agent: owner, round: 1,
        claim: title, loc: `${findingId}.js:20`});
      await appendEvent(dir, {t: 'finding.resolved', id: findingId, verdict: 'rejected', reason: 'Checked'});
    }
    await appendEvent(dir, {t: 'language.changed', language});
    const [answer] = await replyRound({dir, pool: [agent], cfg: {stopToken: 'NO NEW FINDINGS'},
      worktree: dir, sha: 'abc', round: 1, language: languageIn(await readEvents(dir)),
      sessions: new Map(resumed ? [[agent.name, 'session']] : []), findings: await findingsIn(dir)});
    assert.equal(answer.failed, false);
    const events = await readEvents(dir), findings = await findingsIn(dir);
    const turns = events.filter(e => e.t === 'finding.turn');
    assert.deepEqual(turns.map(e => e.id), [id]);
    assert.ok(turns[0].text.includes(message), 'the saved rebuttal must include its translated explanation');
    assert.equal(findings.get(id).contested, true);
    assert.equal(findings.get(id).turns, 1);
    assert.equal(findings.get(neighbor).contested, false, 'an ID prefix must not match');
    assert.equal(findings.get(other).contested, false);
    assert.deepEqual(outstanding(findings, events).map(f => f.id), [id]);
    const sent = events.find(e => e.t === 'reply.sent');
    assert.equal(sent.resumed, resumed);
    assert.ok(sent.text.includes(`Response language: ${language}.`));
    assert.ok(sent.text.includes(`Finding ID: ${id}`));
    assert.ok(!sent.text.includes(other), 'only this reviewer receives its finding IDs');
    assert.match(sent.text, /"DISPUTE: <finding-id>" on its own line/);
    assert.match(sent.text, /Preserve the DISPUTE:\nmarker and finding ID unchanged even when translating your response/);
    assert.match(sent.text, /only for findings you still dispute, not for agreements or new findings/);
    assert.ok(sent.text.includes('say exactly "NO NEW FINDINGS" on its own line'));
    assert.equal(answer.raised, 0, 'a dispute marker is not a new finding');
    assert.equal(answer.clean, false);
  });
}

for (const report of ['DISPUTE: A-extra', 'DISPUTE: unknown', '我同意 A 的结论。\nNO NEW FINDINGS']) {
  test(`finding IDs require an exact dispute marker: ${report.split('\n')[0]}`, async t => {
    const {events, findings} = await reply(t, '[P2] Missing authorization validation', report);
    assert.equal(events.filter(e => e.t === 'finding.turn').length, 0);
    assert.equal(findings.get('A').contested, false);
    assert.deepEqual(outstanding(findings, events), []);
  });
}
