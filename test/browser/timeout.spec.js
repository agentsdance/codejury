import { test, expect } from './fixture.js';
import { foldEvents } from '../../lib/store.js';

test('saved timeout remains visible in the round and exchange with no working placeholder', async ({ page, consoleURL }) => {
  const ts = seconds => new Date(Date.parse('2026-10-20T12:00:00Z') + seconds * 1000).toISOString();
  const events = [
    { ts: ts(0), t: 'target', target: { repo: 'fixture/timeout', title: 'Timed-out review', judge: 'codex', state: 'human' } },
    { ts: ts(0), t: 'round.start', n: 1, sha: 'abc1234' },
    { ts: ts(0), t: 'agent.launch', agent: 'trae', round: 1 },
    { ts: ts(0), t: 'agent.launch', agent: 'peer', round: 1 },
    { ts: ts(20), t: 'agent.report', agent: 'peer', round: 1, verdict: 'clean', seconds: 20,
      summary: 'NO NEW FINDINGS', report: 'NO NEW FINDINGS' },
    { ts: ts(595), t: 'agent.alive', agent: 'trae', round: 1, seconds: 595 },
    { ts: ts(605), t: 'agent.report', agent: 'trae', round: 1, verdict: 'error', seconds: 605,
      timedOut: true, timeoutSeconds: 600, summary: 'Timed out after 10 minutes',
      report: 'Timed out after 10 minutes\n\npartial review' },
    { ts: ts(605), t: 'agent.alive', agent: 'trae', round: 1, seconds: 600 },
  ];
  const run = { ...foldEvents(events), slug: 'timeline' };
  await page.route('**/api/run', route => route.fulfill({ json: run }));
  const stream = events.map(event => `event: event\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'event: ready\ndata: {}\n\n';
  await page.route('**/api/stream?*', route => route.fulfill({ contentType: 'text/event-stream', body: stream }));
  await page.goto(consoleURL);
  await expect(page.locator('#rounds .verd[data-s="error"]')).toContainText('Timed out after 10 minutes');
  await expect(page.locator('#rounds .verd[data-s="clean"]')).toContainText('peer');
  await expect(page.locator('.lane-duration').filter({ hasText: '10.1 min' })).toHaveCount(1);
  await page.locator('#convo-tabs [data-ctab="trae"]').click();
  await expect(page.locator('#convo-grid')).toContainText('Timed out after 10 minutes');
  await expect(page.locator('#convo-grid')).toContainText('partial review');
  await expect(page.locator('#convo-grid [data-k="waiting"]')).toHaveCount(0);
  await expect(page.locator('#convo-grid [data-k="streaming"]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('timeout-console.png'), fullPage: true });
});
