import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const [port,run]=process.argv.slice(2);
assert(port && run && port!=='8399');
const log=readFileSync(`${run}/daemon.log`,'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const seed=JSON.parse(readFileSync(`${run}/evidence/neo-wake-pagination-seed.json`,'utf8'));
const {chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,...(process.env.VERIFY_BROWSER?{executablePath:process.env.VERIFY_BROWSER}:{})});
const observed=[];
try {
 const page=await browser.newPage({viewport:{width:1280,height:900},locale:'en-US',reducedMotion:'reduce'});
 for(const [name,width] of [['desktop',1280],['mobile',390]]) {
  await page.setViewportSize({width,height:900});
  await page.goto(`http://127.0.0.1:${port}/neo`);
  const message=page.locator(`[data-message-ref="${seed.publication}"]`);
  const wake=page.locator(`[data-wake="${seed.scheduleId}"]`);
  await message.waitFor({timeout:30000});
  await page.locator(`[data-message-ref="${seed.cached}"]`).getByText('Later retained update 1.',{exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await wake.count(),0);
  const earlier=page.getByRole('button',{name:'Load earlier saved conversation',exact:true});
  await earlier.scrollIntoViewIfNeeded();
  const scroller=page.locator(width>=1120?'.neo-chat-rail':'main');
  await scroller.evaluate(element=>{element.scrollTop=80;element.dispatchEvent(new Event('scroll',{bubbles:true}));});
  await earlier.scrollIntoViewIfNeeded();
  const before=await message.boundingBox();
  const scrollBefore=await scroller.evaluate(element=>element.scrollTop);
  await page.screenshot({path:`${run}/evidence/neo-wake-pagination-${name}-before.png`});
  await earlier.click();
  await wake.waitFor();
  await page.locator(`[data-message-ref="${seed.older}"]`).waitFor();
  const after=await wake.boundingBox();
  const scrollAfter=await scroller.evaluate(element=>element.scrollTop);
  const hiddenHeight=await message.evaluate(element=>element.getBoundingClientRect().height);
  observed.push({viewport:name,before,after,scrollBefore,scrollAfter,hiddenHeight,delta:after.y-before.y});
  writeFileSync(`${run}/evidence/neo-wake-pagination.json`,JSON.stringify(observed,null,2));
  await page.screenshot({path:`${run}/evidence/neo-wake-pagination-${name}-after.png`});
  assert.equal(await message.isVisible(),false);
  assert(Math.abs(after.y-before.y)<2,`Load earlier moved replacement wake by ${after.y-before.y}px`);
 }
 console.log(`PASS: Load earlier keeps the visible wake at the former publication position. ${run}/evidence/neo-wake-pagination.json`);
} finally {await browser.close();}
