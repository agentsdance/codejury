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
const {triagePrompt} = await load('triage.js');

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

for (const [label, claim, next, language, raised] of [
  ['distinct Hindi vowel signs', '[P2] कुल गलत है', '[P2] काल गलत है', 'hi', 1],
  ['Hindi punctuation duplicate', '[P2] कुल गलत है', '[P2] कुल गलत है!', 'hi', 0],
  ['English control', '[P2] Total is wrong', '[P2] Time is wrong', 'en', 1],
]) test(`reply deduplication preserves combining marks: ${label}`, async t => {
  const {answer, events, findings} = await reply(t, claim,
    `FINDING: ${next}\nWHERE: time.js:20\nNeeds correction.`, language);
  assert.equal(answer.raised, raised);
  const expected = raised ? [{claim: next, loc: 'time.js:20'}] : [];
  assert.deepEqual(events.filter(e => e.t === 'finding.raised' && e.id !== 'A')
    .map(({claim, loc}) => ({claim, loc})), expected);
  assert.deepEqual(outstanding(findings, events).filter(f => f.id !== 'A')
    .map(({claim, loc}) => ({claim, loc})), expected);
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

for (const [label, quoted] of [
  ['backtick fence', '```text\nDISPUTE: A\n```'],
  ['tilde fence', '~~~text\nDISPUTE: A\n~~~'],
  ['nested shorter and different fences', '````text\n```\n~~~\nDISPUTE: A\n````'],
  ['blockquote', '> DISPUTE: A'],
  ['four-space code block', '\n    DISPUTE: A\n'],
  ['tab-indented code block', '\n\tDISPUTE: A\n'],
  ['space and tab code block', '\n \tDISPUTE: A\n'],
]) test(`quoted dispute markers do not reopen findings: ${label}`, async t => {
  const {answer, events, findings} = await reply(t, '[P2] Missing authorization validation',
    `My earlier objection was:\n${quoted}\nI withdraw that objection and agree with the resolution.\nNO NEW FINDINGS`);
  assert.equal(answer.clean, true);
  assert.equal(answer.raised, 0);
  assert.deepEqual(events.filter(e => e.t === 'finding.turn'), []);
  assert.equal(findings.get('A').turns, 0);
  assert.equal(findings.get('A').contested, false);
  assert.deepEqual(outstanding(findings, events), []);
});

test('a three-space indented live dispute remains active', async t => {
  const {answer, events, findings} = await reply(t, '[P2] Missing authorization validation',
    '   DISPUTE: A\nThe objection remains.\nNO NEW FINDINGS');
  assert.equal(answer.clean, false);
  assert.equal(events.filter(e => e.t === 'finding.turn').length, 1);
  assert.equal(findings.get('A').contested, true);
});

test('complete unmarked rebuttals retain late reproduction evidence for the judge', async t => {
  const report = ['Missing authorization remains unfixed.', '', 'Reproduction:',
    '1. Sign out.', '', '2. Request the primary route and observe 401.', '',
    '3. Request the alternate route.', 'Observed: 200 and the protected action succeeded.'].join('\n');
  const {findings} = await reply(t, 'Missing authorization', report, 'en');
  const finding = findings.get('A');
  assert.deepEqual(finding.rebuttals, [report]);
  assert.ok(triagePrompt({finding, trunk: 'master', language: 'en'})
    .includes(`> ${report.split('\n').join('\n> ')}`));
});

for (const fence of ['```', '~~~']) {
  test(`an active dispute after a quoted example reaches triage: ${fence}`, async t => {
    const explanation = '我仍然不同意：权限校验的问题尚未修复。';
    const {answer, events, findings} = await reply(t, '[P2] Missing authorization validation',
      `Earlier example:\n${fence}text\nDISPUTE: A\n${fence}\n${'Historical context.\n'.repeat(8)}`
      + `DISPUTE: A\n${explanation}\nNO NEW FINDINGS`);
    assert.equal(answer.clean, false);
    const turns = events.filter(e => e.t === 'finding.turn');
    assert.deepEqual(turns.map(e => e.id), ['A']);
    assert.ok(turns[0].text.includes(explanation), 'the excerpt must come from the active dispute');
    assert.equal(findings.get('A').turns, 1);
    assert.equal(findings.get('A').contested, true);
    assert.deepEqual(outstanding(findings, events).map(f => f.id), ['A']);
  });
}

for (const [id, clean] of [['A', false], ['unknown', true]]) {
  test(`an explicit known dispute overrides the approval marker: ${id}`, async t => {
    const {answer, events, findings} = await reply(t, '[P2] Missing authorization validation',
      `DISPUTE: ${id}\nNO NEW FINDINGS`);
    assert.equal(answer.clean, clean);
    assert.equal(findings.get('A').contested, !clean);
    assert.equal(outstanding(findings, events).length, Number(!clean));
  });
}

for (const fence of ['```', '~~~']) {
  test(`complete dispute sections preserve quoted markers and stop at the next live dispute: ${fence}`, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jury-dispute-sections-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const sections = [
      ['DISPUTE: A', '复现步骤：', '', '1. 使用匿名请求。', '2. 改用备用路由。',
        `${fence}text`, 'DISPUTE: B', '示例输出，不是新的争议。', fence,
        '> DISPUTE: B', '    DISPUTE: B', '', '实际结果：备用路由返回 200。'].join('\n'),
      'DISPUTE: B\n另一个问题的证据。\n实际结果：余额变为负数。',
    ];
    const report = `Review context.\n\n${sections.join('\n\n')}`;
    const agent = {name: 'fixture', argv: [process.execPath, '-e', `console.log(${JSON.stringify(report)})`]};
    for (const [id, claim] of [['A', 'Missing authorization'], ['B', 'Incorrect balance']]) {
      await appendEvent(dir, {t: 'finding.raised', id, agent: agent.name, round: 1, claim});
      await appendEvent(dir, {t: 'finding.resolved', id, verdict: 'rejected', reason: 'Checked'});
    }
    await replyRound({dir, pool: [agent], cfg: {stopToken: 'NO NEW FINDINGS'}, worktree: dir,
      sha: 'abc', round: 1, findings: await findingsIn(dir), language: 'zh-CN'});
    const events = await readEvents(dir), findings = await findingsIn(dir);
    assert.deepEqual(events.filter(e => e.t === 'finding.turn').map(e => e.text), sections);
    for (const [index, id] of ['A', 'B'].entries()) {
      const finding = findings.get(id);
      assert.deepEqual(finding.rebuttals, [sections[index]]);
      const prompt = triagePrompt({finding, trunk: 'master', language: 'zh-CN'});
      assert.ok(prompt.includes(`> ${sections[index].split('\n').join('\n> ')}`));
      assert.ok(!prompt.includes(sections[1 - index].split('\n').at(-1)),
        'a finding must not receive the neighboring dispute section');
    }
  });
}

for (const [language, claim, agreement, objection] of [
  ['zh-CN', '[P2] 数值错误', '关于 B 的数值错误，我同意已经修复。', '匿名请求仍然能执行受保护操作。'],
  ['en', '[P2] Numeric overflow', 'I agree that B: Numeric overflow is fixed.', 'Anonymous requests can still perform the protected action.'],
]) test(`explicit dispute IDs keep mixed agreements settled: ${language}`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jury-mixed-reply-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const report = `DISPUTE: A\n${objection}\n\n${agreement}`;
  const agent = {name: 'fixture', argv: [process.execPath, '-e', `console.log(${JSON.stringify(report)})`]};
  // The agreed finding comes first so marker handling cannot depend on thread order.
  for (const [id, title, status] of [['B', claim, 'accepted'], ['A', '[P2] Missing authorization', 'rejected']]) {
    await appendEvent(dir, {t: 'finding.raised', id, agent: agent.name, round: 1, claim: title, loc: `${id}.js:1`});
    await appendEvent(dir, {t: 'finding.resolved', id, verdict: status, reason: 'Checked'});
  }
  const [answer] = await replyRound({dir, pool: [agent], cfg: {stopToken: 'NO NEW FINDINGS'},
    worktree: dir, sha: 'abc', round: 1, language, findings: await findingsIn(dir)});
  assert.equal(answer.failed, false);
  assert.equal(answer.clean, false, 'the disputed finding still needs the judge');
  const events = await readEvents(dir), findings = await findingsIn(dir);
  assert.deepEqual({
    turns: events.filter(e => e.t === 'finding.turn').map(e => e.id),
    pending: outstanding(findings, events).map(f => f.id),
    agreed: {status: findings.get('B').status, contested: findings.get('B').contested, turns: findings.get('B').turns},
  }, {turns: ['A'], pending: ['A'], agreed: {status: 'accepted', contested: false, turns: 0}});
  assert.ok(findings.get('A').rebuttals[0].includes(objection));
  assert.deepEqual(findings.get('B').rebuttals, []);
});

test('quoted dispute markers do not disable legacy title matching', async t => {
  const report = 'Earlier example:\n```text\nDISPUTE: unknown\n```\n我仍然不同意：缺少权限检查的问题依然存在。';
  const {events, findings} = await reply(t, '[P2] 缺少权限检查', report);
  assert.deepEqual(events.filter(e => e.t === 'finding.turn').map(e => e.id), ['A']);
  assert.deepEqual(outstanding(findings, events).map(f => f.id), ['A']);
});

test('complete rebuttal sections preserve code examples and repeated disputes without other findings', async t => {
  const first = [
    'DISPUTE: A', 'The quoted example is part of the reproduction:', '',
    '```text', 'DISPUTE: B', '```', '',
    'Important evidence after the example: the protected write succeeds.',
  ].join('\n');
  const second = 'DISPUTE: A\nAn additional request confirms the same unauthorized write.';
  const report = `Introduction.\n\n${first}\n\nDISPUTE: B\nUnrelated dispute evidence.\n\n${second}\n\n`
    + 'FINDING: A separate defect\nWHERE: other.js:2\nUnrelated new finding evidence.';
  const {events, findings} = await reply(t, '[P2] Missing authorization validation', report, 'en');
  const saved = events.find(e => e.t === 'finding.turn' && e.id === 'A').text;
  assert.equal(saved, `${first}\n\n${second}`, 'keep all sections for the exact ID and respect live boundaries');
  const prompt = triagePrompt({finding: findings.get('A'), trunk: 'master', stopToken: 'NO NEW FINDINGS'});
  assert.ok(prompt.includes('Important evidence after the example: the protected write succeeds.'));
  assert.ok(prompt.includes('An additional request confirms the same unauthorized write.'));
  assert.ok(!prompt.includes('Unrelated dispute evidence.'));
  assert.ok(!prompt.includes('Unrelated new finding evidence.'));
});

