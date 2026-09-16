import { test, expect } from './fixture.js';

test('one CLI keeps reviewer messages and judge activity on separate sides', async ({ page, consoleURL }) => {
  await page.goto(consoleURL);
  await expect(page.locator('#t-title')).toHaveText('Timeline browser fixture');
  const result = await page.evaluate(() => {
    const events = [
      { t: 'target', target: { judge: 'codex' } },
      { t: 'agent.report', agent: 'codex', round: 1, report: 'Review report' },
      { t: 'agent.alive', agent: 'codex', forAgent: 'codex', round: 1, seconds: 5 },
      { t: 'finding.raised', agent: 'codex', id: 'f', claim: 'Claim' },
      { t: 'finding.resolved', who: 'codex', id: 'f', verdict: 'rejected', reason: 'Checked' },
      { t: 'reply.answered', agent: 'codex', report: 'Reviewer answer' },
      { t: 'finding.turn', agent: 'codex', who: 'codex', id: 'f', text: 'Reviewer answer excerpt' },
    ];
    return foldConversation(events)[0].turns.map(turn => {
      const container = document.createElement('div');
      container.innerHTML = turnHTML(turn, 'codex');
      return { kind: turn.kind, side: container.querySelector('.msg').dataset.side, text: container.textContent };
    });
  });
  for (const kind of ['report', 'answer', 'rebuttal']) {
    expect(result.find(turn => turn.kind === kind)?.side, kind).toBe('r');
  }
  for (const kind of ['waiting', 'verdict']) {
    expect(result.find(turn => turn.kind === kind)?.side, kind).toBe('l');
  }
  expect(result.find(turn => turn.kind === 'rebuttal')?.text).not.toContain('Reviewer answer excerpt');
});
