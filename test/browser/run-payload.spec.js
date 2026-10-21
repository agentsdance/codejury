import { test, expect } from './fixture.js';
import { foldEvents } from '../../lib/store.js';

const saved = (slug, title) => ({
  ...foldEvents([], { target: { id: '#1', title, state: 'converged' } }),
  slug,
});

for (const kind of ['empty', 'populated', 'envelope']) {
  test(`saved-run polling preserves run identity with ${kind} targets metadata`, async ({ page, consoleURL }) => {
    const real = saved('timeline', 'Actual saved review');
    const other = saved('other', 'Unrelated review');
    const payload = kind === 'envelope' ? { targets: [other, real] }
      : { ...real, targets: kind === 'empty' ? [] : [other] };
    await page.route('**/api/run', route => route.fulfill({ json: payload }));
    await page.goto(consoleURL);
    await expect(page.locator('#t-title')).toHaveText('Actual saved review');
    await expect(page).toHaveURL(/\?run=timeline$/);
  });
}
