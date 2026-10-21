import { test, expect } from './fixture.js';

test('the installed console distinguishes repeated related-PR reviews', async ({ page, consoleURL }) => {
  await page.goto(consoleURL);
  await expect(page.locator('#t-title')).toHaveText('Timeline browser fixture');
  for (const [attempts, expected] of [
    [['20261021-193001123-12345678-1234-1234-1234-123456789abc-jury-group-fCe2hV',
      '20261021-193001123-abcdef01-1234-1234-1234-123456789abc-jury-group-Dsb50g'],
    ['10/21 19:30:01.123 · 12345678', '10/21 19:30:01.123 · abcdef01']],
    [['20261021-1930-jury-group-fCe2hV', '20261021-1930-jury-group-Dsb50g'],
    ['10/21 19:30 · fCe2hV', '10/21 19:30 · Dsb50g']],
  ]) {
    const rendered = await page.evaluate(attempts => {
      const template = RUN;
      ALL = attempts.map(attempt => ({ ...template, slug: `related-prs-groupid-${attempt}`,
        target: { ...template.target, repo: 'related-prs', id: 'groupid', attempt } }));
      RUN = ALL[0];
      drawSwitcher();
      return {
        labels: [...document.querySelectorAll('.sw-i .at')].map(el => el.textContent),
        selected: document.querySelector('#sw-btn .nm').textContent,
      };
    }, attempts);
    expect(rendered.labels).toEqual(expected);
    expect(rendered.selected).toContain(expected[0]);
  }
});
