import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const seed = JSON.parse(readFileSync(`${run}/evidence/neo-wake-web-seed.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.VERIFY_BROWSER ? {executablePath:process.env.VERIFY_BROWSER} : {}),
});
const observed = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale:'en-US' });
  for (const [name, width] of [['desktop',1280],['mobile',390]]) {
    await page.setViewportSize({width,height:1000});
    await page.goto(`http://127.0.0.1:${port}/neo`);
    const row = page.locator(`[data-wake="${seed.complete}"]`);
    await row.waitFor({timeout:30000});
    await row.scrollIntoViewIfNeeded();
    assert.equal(await row.getAttribute('open'),null);
    const summary = await row.locator('summary').innerText();
    assert(summary.includes('Publish the guide') && summary.includes('Guide check complete.'),summary);
    assert((await page.locator(`[data-wake="${seed.active}"] summary`).innerText()).includes('Working…'));
    assert((await page.locator(`[data-wake="${seed.empty}"] summary`).innerText()).includes('No changes needed.'));
    const publication = seed.additions.find(item => item.kind === 'publication');
    const message = row.locator(`[data-message-ref="${publication.id}"]`);
    assert.equal(await message.isVisible(),false);
    assert.equal(await page.locator(`[data-message-ref="${publication.id}"]`).count(),1);
    await page.screenshot({path:`${run}/evidence/neo-wake-${name}-collapsed.png`,fullPage:true});
    await row.locator('summary').click();
    await row.getByRole('link',{name:'Review guide',exact:true}).waitFor();
    assert.equal(await message.isVisible(),true);
    assert((await row.innerText()).includes('Guide ready.'));
    await page.screenshot({path:`${run}/evidence/neo-wake-${name}-expanded.png`,fullPage:true});
    const publicationLink = row.getByRole('link',{name:publication.label,exact:true});
    await publicationLink.click();
    const anchor = await page.evaluate(() => location.hash.slice(1));
    const articleId = await message.getAttribute('id');
    const linked = await message.evaluate((element,id) => document.getElementById(id) === element,anchor);
    writeFileSync(`${run}/evidence/neo-wake-${name}-publication-link.json`,JSON.stringify({anchor,articleId,linked,url:page.url()},null,2));
    assert.equal(linked,true,'Publication link must resolve to its rendered article');
    const box = await row.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1);
    const todo = seed.additions.find(item => item.kind === 'todo');
    await row.getByRole('link',{name:todo.label,exact:true}).click();
    await page.locator(`[data-ask-todo="${todo.id}"]`).waitFor({state:'visible'});
    if (name === 'mobile') await page.getByRole('button',{name:'Close work list',exact:true}).click();
    const question = seed.additions.find(item => item.kind === 'question');
    await row.getByRole('link',{name:question.label,exact:true}).click();
    const target = page.locator(`[data-ask-question="${question.id}"]`);
    await target.waitFor({state:'visible'});
    await target.scrollIntoViewIfNeeded();
    assert((await target.innerText()).includes(question.label));
    await page.screenshot({path:`${run}/evidence/neo-wake-${name}-question.png`,fullPage:true});
    observed.push({viewport:name,summary,question:await target.innerText(),foldedPublication:publication.id});
  }
  writeFileSync(`${run}/evidence/neo-wake-web.json`,JSON.stringify(observed,null,2));
  console.log(`PASS: folded wakes, attributed publication and question navigation on desktop/mobile. ${run}/evidence/neo-wake-web.json`);
} finally { await browser.close(); }
