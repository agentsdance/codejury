import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixture.js';

// TRAE's own mark from https://www.trae.ai (icon-logo.svg), not the generic
// triangle previously returned for this built-in agent.
const traePath = 'M48 34.642H6.857v-6.854H0V.358h48zM6.857 27.788h34.286V7.215H6.857zm17.145-10.391-4.849 4.848-4.848-4.848 4.848-4.848zm13.713-.003-4.848 4.848-4.848-4.848 4.848-4.848z';

async function expectMark(label, agent) {
  await expect(label).toContainText(agent);
  const svg = label.locator('svg');
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute('aria-hidden', 'true');
  // Marks stay self-contained instead of loading an external image or symbol.
  await expect(svg.locator('image, use')).toHaveCount(0);
  const shape = svg.locator('path').first();
  await expect(shape).toHaveAttribute('fill', 'currentColor');
  if (agent === 'trae') {
    await expect(svg).toHaveAttribute('viewBox', '0 0 48 35');
    await expect(shape).toHaveAttribute('d', traePath);
  } else {
    // The other participant must retain Codex's own mark.
    await expect(shape).toHaveAttribute('d', /^M22\.2819/);
  }
  expect(await shape.evaluate(el => {
    const box = el.getBBox();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).fill !== 'none';
  })).toBe(true);
}

for (const source of ['console', 'demo']) {
  for (const theme of ['light', 'dark']) {
    for (const role of ['reviewer', 'judge']) {
      test(`${source} ${theme}: TRAE ${role} has its own mark beside the correct name`, async ({ page, consoleURL }, testInfo) => {
        const judge = role === 'judge' ? 'trae' : 'codex';
        const reviewer = role === 'reviewer' ? 'trae' : 'codex';
        const target = { repo: 'fixture/icons', title: 'TRAE participant icons', judge, state: 'converged' };
        const run = {
          slug: 'timeline', target, totalMin: 3, marks: [{ at: 0, l: 'round 1' }],
          lanes: [judge, reviewer].map(who => ({ who, label: who, segs: [{ r: 1, s: 0, e: 2 }] })),
          rounds: [{ n: 1, sha: 'abc1234', verdicts: [{ a: reviewer, s: 'clean', t: 'Review complete' }] }],
          exchanges: [{
            id: 'f1', with: reviewer, claim: 'Check participant icons', res: 'rejected',
            turns: [{ who: reviewer, body: 'Review report' }, { who: judge, body: 'Checked the evidence' }],
          }],
          ship: [], tlfoot: 'Saved fixture; no agents invoked',
        };
        const events = [
          { t: 'target', target },
          { t: 'agent.report', agent: reviewer, round: 1, report: 'Review report' },
          { t: 'finding.raised', agent: reviewer, id: 'f1', claim: 'Check participant icons' },
          { t: 'finding.resolved', who: judge, id: 'f1', verdict: 'rejected', reason: 'Checked the evidence' },
        ];
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.emulateMedia({ colorScheme: theme });
        await page.route('**/api/run', route => route.fulfill({ json: run }));
        await page.route('**/api/stream?*', route => route.fulfill({
          contentType: 'text/event-stream',
          body: events.map(event => `event: event\ndata: ${JSON.stringify(event)}\n\n`).join('')
            + 'event: ready\ndata: {}\n\n',
        }));
        let url = consoleURL;
        if (source === 'demo') {
          const html = await readFile(path.join(process.env.JURY_BROWSER_PACKAGE_ROOT, 'docs/console-demo.html'), 'utf8');
          await page.route('**/console-demo.html?*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
          url = new URL('console-demo.html?run=timeline', consoleURL).href;
        }
        await page.goto(url);
        if (source === 'demo') {
          // The standalone demo deliberately ignores api/run. Give its real
          // renderer the same saved-run fixture without changing its source.
          await page.evaluate(saved => { RUN = saved; render(); }, run);
        }
        await expect(page.locator('#t-title')).toHaveText(target.title);
        await expect(page.locator('#convo-grid .msg')).toHaveCount(2);
        await page.screenshot({ path: testInfo.outputPath('participant-icons.png'), fullPage: true });

        for (const agent of [judge, reviewer]) {
          await expectMark(page.locator('#tl .lane > .who').filter({ hasText: agent }), agent);
          await expectMark(page.locator(`#thread .ln[data-who="${agent}"] .nm`), agent);
        }
        await expectMark(page.locator('#rounds .ag'), reviewer);
        await expectMark(page.locator('#convo-tabs .pr-chip'), reviewer);
        await expectMark(page.locator('#convo-grid .msg[data-side="l"] > .nm'), judge);
        await expectMark(page.locator('#convo-grid .msg[data-side="r"] > .nm'), reviewer);
        for (const header of [page.locator('#thread .rule .lbl').first(), page.locator('#convo-grid header .who')]) {
          await expect(header).toHaveText(`${judge} ⇄ ${reviewer}`);
          await expect(header.locator('svg')).toHaveCount(2);
          const marks = await header.locator('svg path').evaluateAll(paths => paths.map(el => el.getAttribute('d')));
          expect(marks[role === 'judge' ? 0 : 1]).toBe(traePath);
          expect(marks[role === 'judge' ? 1 : 0]).toMatch(/^M22\.2819/);
        }
        expect(errors).toEqual([]);
      });
    }
  }
}
