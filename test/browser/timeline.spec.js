import { test, expect, agents } from './fixture.js';
import { contrast, effectiveOpacity } from './contrast.js';

for (const theme of ['light', 'dark']) {
  for (const width of [1100, 390]) {
    test(`${theme} ${width}px: readable timeline colors, states and duration summaries`, async ({ page, consoleURL }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(consoleURL);
      await expect(page.locator('#t-title')).toHaveText('Timeline browser fixture');
      await expect(page.locator('#tl .lane')).toHaveCount(agents.length);
      for (const agent of agents) {
        const lane = page.locator('#tl .lane').filter({ has: page.locator(`.seg[data-a="${agent}"]`) });
        const segments = lane.locator('.seg');
        await expect(segments).toHaveCount(5);
        const complete = segments.nth(0);
        await expect(complete).toHaveText('5 min');
        const colors = await complete.evaluate(el => {
          const style = getComputedStyle(el);
          return { fg: style.color, bg: style.backgroundColor, image: style.backgroundImage };
        });
        expect(colors.bg, `${agent} needs a solid fallback/agent background`).not.toBe('rgba(0, 0, 0, 0)');
        expect(contrast(colors.fg, colors.bg), `${agent} completed label contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
        expect(colors.image).toBe('none');
        expect(await complete.evaluate(effectiveOpacity), `${agent} completed label and ancestors must be opaque`).toBe(1);
        for (const i of [2, 3]) {
          expect(await segments.nth(i).evaluate(el => getComputedStyle(el).backgroundImage), `${agent} state stripes`).toContain('repeating-linear-gradient');
        }
        await expect(segments.nth(2)).toHaveAttribute('data-open', '1');
        await expect(segments.nth(3)).toHaveAttribute('data-abandoned', '1');
        expect(await segments.nth(3).evaluate(el => Number(getComputedStyle(el).opacity))).toBeLessThan(1);
        await expect(segments.nth(1)).toHaveText(''); // Duration still visible below, even when it cannot fit inside.
        await expect(lane.locator('.lane-duration')).toHaveText([
          'Round 1: 5 min', 'Round 2: 3s', 'Round 3: 3 min · running', 'Round 4: 4 min · interrupted', 'Reply: 1.2s',
        ]);
        for (const label of await lane.locator('.lane-duration').all()) {
          await expect(label).toBeVisible();
          const geometry = await label.evaluate(el => {
            const parent = el.parentElement.getBoundingClientRect(), box = el.getBoundingClientRect();
            const style = getComputedStyle(el), strongEl = el.querySelector('strong'), strong = getComputedStyle(strongEl);
            const bg = getComputedStyle(el.closest('.tl')).backgroundColor;
            return { fits: box.left >= parent.left - 1 && box.right <= parent.right + 1, fg: style.color, strong: strong.color, bg };
          });
          expect(geometry.fits, `${agent} summary must fit its lane`).toBeTruthy();
          expect(await label.evaluate(effectiveOpacity), `${agent} summary and ancestors must be opaque`).toBe(1);
          expect(await label.locator('strong').evaluate(effectiveOpacity), `${agent} summary value and ancestors must be opaque`).toBe(1);
          expect(contrast(geometry.fg, geometry.bg)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(geometry.strong, geometry.bg)).toBeGreaterThanOrEqual(4.5);
        }
      }
      await expect(page.locator('.tl-rounds')).toContainText('rounds 2-3');
      expect(errors).toEqual([]);
      await testInfo.attach('timeline', { body: await page.locator('.tl').screenshot(), contentType: 'image/png' });
    });
  }
}

test('explicit theme overrides the system preference', async ({ page, consoleURL }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(consoleURL);
  await expect(page.locator('#t-title')).toHaveText('Timeline browser fixture');
  const label = page.locator('.seg[data-a="claude"]').first();
  const dark = await label.evaluate(el => getComputedStyle(el).color);
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  const light = await label.evaluate(el => getComputedStyle(el).color);
  expect(light).not.toBe(dark);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  expect(await label.evaluate(el => getComputedStyle(el).color)).toBe(dark);
});
