import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port,run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log=readFileSync(`${run}/daemon.log`,'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const seed=JSON.parse(readFileSync(`${run}/evidence/goal-detail-seed.json`,'utf8'));
const {chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,...(process.env.VERIFY_BROWSER ? {executablePath:process.env.VERIFY_BROWSER}:{})});
const observed=[];
async function settle(page) {
  await page.evaluate(async()=>{await document.fonts.ready;});
  await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState!=='running'||animation.effect?.getTiming().iterations===Infinity));
}
try {
  const page=await browser.newPage({viewport:{width:1280,height:1000},locale:'en-US'});
  for(const width of [1280,390]) for(const entrypoint of ['schedule','goals']) {
    await page.setViewportSize({width,height:1000});
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if(entrypoint === 'goals' && width === 390) await page.getByRole('button',{name:'Your work',exact:true}).click();
    const strip=entrypoint === 'schedule' ? page.locator(`[data-session-schedules="${seed.root}"]`) : page.getByRole('region',{name:'Goals',exact:true});
    if(entrypoint === 'schedule') await strip.getByRole('button',{name:'more — Schedules',exact:true}).click();
    await strip.getByRole('button',{name:'more — Publish useful guide',exact:true}).click();
    await strip.getByText('Concrete examples work',{exact:true}).waitFor();
    for(const text of ['readers: 30','useful: true','Write examples','Guide for adopters'])
      await strip.getByText(text,{exact:true}).waitFor();
    await strip.getByText('Done when: One hundred readers',{exact:true}).waitFor();
    await strip.getByText('Guide for adopters',{exact:true}).scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({path:`${run}/evidence/goal-definition-${entrypoint}-${width}.png`,fullPage:true});
    const mandate=strip.getByRole('link',{name:'mandate.md#adoption',exact:true});
    assert.equal(await mandate.getAttribute('href'),`https://github.com/example/synthetic-neo-home/blob/${seed.rev}/mandate.md#adoption`);
    const journal=strip.getByRole('region',{name:'Journal',exact:true});
    await journal.locator('[data-journal-entry]').last().waitFor();
    assert.equal(await journal.locator('[data-journal-entry]').count(),20);
    await journal.getByRole('button',{name:'Older entries',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-journal-entry]').length===21);
    const ids=await journal.locator('[data-journal-entry]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-journal-entry')));
    assert.deepEqual(ids,seed.ids);
    const latest=journal.locator(`[data-journal-entry="${seed.ids[0]}"]`);
    await latest.getByRole('button',{name:'more — Effect 21',exact:true}).click();
    const evidence=latest.getByRole('link',{name:'Guide PR 21',exact:true});
    assert.equal(await evidence.getAttribute('href'),'https://github.com/example/synthetic-repo/pull/21');
    await latest.getByText('Published draft 21',{exact:true}).waitFor();
    await evidence.scrollIntoViewIfNeeded();
    await settle(page);
    const box=await strip.boundingBox();assert(box&&box.x>=0&&box.x+box.width<=width+1,JSON.stringify(box));
    await page.screenshot({path:`${run}/evidence/goal-detail-${entrypoint}-${width}.png`,fullPage:true});
    observed.push({width,entrypoint,mandate:await mandate.getAttribute('href'),evidence:await evidence.getAttribute('href'),orderedJournalIds:ids,metrics:true,worksNote:true});
  }
  writeFileSync(`${run}/evidence/goal-detail-web.json`,JSON.stringify(observed,null,2));
  console.log(`PASS: real desktop/mobile goal details, remote mandate link, what-works and 21 paged journal entries. ${run}/evidence/goal-detail-web.json`);
} finally {await browser.close();}
