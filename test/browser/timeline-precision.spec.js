import { test, expect } from './fixture.js';
import { foldEvents } from '../../lib/store.js';

for (const theme of ['light', 'dark']) {
  test(`${theme}: event timestamps preserve short review durations in the installed console`, async ({ page, consoleURL }, testInfo) => {
    const ts = seconds => new Date(Date.parse('2026-10-20T12:00:00Z') + seconds * 1000).toISOString();
    const events = [
      { ts: ts(0), t: 'target', target: { repo: 'fixture/precision', title: 'Short review durations', judge: 'codex', state: 'converged' } },
      { ts: ts(0), t: 'round.start', n: 1, sha: 'abc1234' },
      { ts: ts(0), t: 'agent.launch', agent: 'trae', round: 1 },
      { ts: ts(2), t: 'agent.report', agent: 'trae', round: 1, verdict: 'clean', seconds: 2, report: 'NO NEW FINDINGS' },
      { ts: ts(2.5), t: 'round.start', n: 2, sha: 'def5678' },
      { ts: ts(2.5), t: 'agent.launch', agent: 'trae', round: 2 },
      { ts: ts(3.5), t: 'agent.report', agent: 'trae', round: 2, verdict: 'clean', seconds: 1, report: 'NO NEW FINDINGS' },
      { ts: ts(10), t: 'round.start', n: 3, sha: 'fed4321' },
      { ts: ts(10), t: 'agent.launch', agent: 'trae', round: 3 },
      { ts: ts(30), t: 'agent.report', agent: 'trae', round: 3, verdict: 'clean', seconds: 20, report: 'NO NEW FINDINGS' },
    ];
    await page.route('**/api/run', route => route.fulfill({ json: { ...foldEvents(events), slug: 'timeline' } }));
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(consoleURL);
    await expect(page.locator('#t-title')).toHaveText('Short review durations');
    const labels = page.locator('#tl .lane-duration');
    await expect(labels).toHaveText(['Round 1: 2s', 'Round 2: 1s', 'Round 3: 20s']);
    const segments = page.locator('#tl .seg[data-a="trae"]');
    await expect(segments).toHaveCount(3);
    for (const segment of await segments.all()) {
      expect(await segment.evaluate(el => parseFloat(el.style.width))).toBeGreaterThan(0);
    }
    await testInfo.attach('timeline-precision', { body: await page.locator('.tl').screenshot(), contentType: 'image/png' });
  });
}
