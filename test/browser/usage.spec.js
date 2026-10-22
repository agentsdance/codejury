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
 await section.locator('summary').click();
 await expect(section).toContainText('Round 1 · fix · codex · failed');
 await expect(section).toContainText('unavailable');
 await expect(section.locator('table')).toHaveCount(3);
 expect(errors).toEqual([]);
});
