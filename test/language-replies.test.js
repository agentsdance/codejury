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
