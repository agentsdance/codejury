import { test, expect } from './fixture.js';
import { foldEvents } from '../../lib/store.js';
const record={model:'gpt-test',modelSource:'reported',input:100,output:20,total:120,cacheRead:80,cacheWrite:10};
const events=[{t:'target',target:{id:'#123',title:'Usage review',state:'converged'}},
 {t:'usage.snapshot',id:'one',agent:'codex',action:'review',round:1,status:'completed',records:[record]},
 {t:'usage.snapshot',id:'two',agent:'codex',action:'fix',round:1,status:'failed',records:[record]},
 {t:'usage.snapshot',id:'three',agent:'claude',action:'reply',round:2,status:'completed',records:[]}];
for(const theme of ['light','dark']) test(`token breakdown remains readable in ${theme} at narrow width`, async ({page,consoleURL})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width:390,height:844});
 await page.route('**/api/run',route=>route.fulfill({json:{...foldEvents(events),slug:'timeline'}}));
 await page.goto(consoleURL);
 const section=page.locator('#usage-sec');
 await expect(section.locator('.usage-total')).toHaveText('240 tokens · partial');
 await expect(section).toContainText('gpt-test (reported)');
 await expect(section).toContainText('model unavailable (unavailable)');
 const details=section.locator('details');
 const invocations=details.locator('table');
 await expect(invocations).toBeHidden();
 await section.locator('summary').click();
 await expect(details).toHaveAttribute('open','');
 await expect(invocations).toBeVisible();
 await expect(invocations.getByRole('cell',{name:'Round 1 · fix · codex · failed · partial',exact:true})).toBeVisible();
 await expect(invocations.getByRole('row').filter({hasText:'Round 2 · reply · claude'})).toBeVisible();
 await expect(section.locator('table')).toHaveCount(3);
 // Wide numeric tables stay inside the narrow viewport, with all columns
 // reachable in their own keyboard-accessible horizontal scroll containers.
 for(const scroller of await section.locator('.usage-scroll').all()) {
  await scroller.scrollIntoViewIfNeeded();
  const box=await scroller.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(390);
  expect(await scroller.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  await scroller.focus();
  await scroller.press('ArrowRight');
  await expect.poll(()=>scroller.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
  const lastCell=scroller.locator('tbody tr').first().locator('td').last();
  await lastCell.scrollIntoViewIfNeeded();
  await expect(lastCell).toBeInViewport();
 }
 expect(errors).toEqual([]);
});

for(const theme of ['light','dark']) test(`live usage updates preserve expansion, scroll and focus in ${theme}`, async ({page,consoleURL})=>{
 await page.emulateMedia({colorScheme:theme});
 await page.setViewportSize({width:390,height:844});
 const payload=total=>({...foldEvents([...events,{t:'usage.snapshot',id:'one',agent:'codex',action:'review',round:1,status:'completed',records:[{...record,input:total-140,total:total-120}]}]),slug:'timeline'});
 let live=payload(240);
 await page.route('**/api/run',route=>route.fulfill({json:live}));
 await page.goto(consoleURL);
 const section=page.locator('#usage-sec'), details=section.locator('details');
 await expect(section.locator('.usage-total')).toHaveText('240 tokens · partial');
 await details.locator('summary').click();
 const scroller=details.locator('.usage-scroll');
 await scroller.focus();
 await scroller.evaluate(el=>{el.scrollLeft=90});
 const scroll=await scroller.evaluate(el=>el.scrollLeft);
 expect(scroll).toBeGreaterThan(0);
 live=payload(360);
 // Wait for the real three-second polling interval to publish changed data.
 await expect(section.locator('.usage-total')).toHaveText('360 tokens · partial',{timeout:10000});
 await expect(details).toHaveAttribute('open','');
 await expect(details.locator('table')).toBeVisible();
 await expect(scroller).toBeFocused();
 expect(await scroller.evaluate(el=>el.scrollLeft)).toBe(scroll);
 await details.locator('summary').focus();
 live=payload(480);
 await page.evaluate(()=>poll());
 await expect(section.locator('.usage-total')).toHaveText('480 tokens · partial');
 await expect(details.locator('summary')).toBeFocused();
 expect(await scroller.evaluate(el=>el.scrollLeft)).toBe(scroll);
 live={...payload(600),slug:'another-run'};
 await page.evaluate(()=>poll());
 await expect(section.locator('.usage-total')).toHaveText('600 tokens · partial');
 await expect(details.locator('table')).toBeHidden();
 await expect(details.locator('summary')).not.toBeFocused();
 await details.locator('summary').click();
 expect(await scroller.evaluate(el=>el.scrollLeft)).toBe(0);
});
