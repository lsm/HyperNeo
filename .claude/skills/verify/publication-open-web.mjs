import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const run=process.argv[2], fixture=JSON.parse(readFileSync(`${run}/fixture.json`,'utf8'));
const {chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.VERIFY_BROWSER});
const cases=[];
try {
 for(const touch of [false,true])for(const theme of ['light','dark']) {
 const context=await browser.newContext({viewport:touch?{width:390,height:844}:{width:1280,height:900},hasTouch:touch,locale:'en-US',colorScheme:theme});
 const page=await context.newPage();
 try {
 await page.addInitScript(theme=>{localStorage.setItem('theme',theme);window.nativeOpens=[];window.open=(link)=>{window.nativeOpens.push(link);return null;};},theme);
 await page.goto(fixture.url);await page.getByText('Ordinary reply',{exact:true}).waitFor();
 const entries=fixture.fixtures.map(item=>({...item,row:page.locator(`[data-message-ref="${item.id}"]`)}));
 if(fixture.phase==='before') {
 for(const entry of entries)assert.equal(await entry.row.getByRole('button',{name:/^Open session:/}).count(),0);
 await page.screenshot({path:`${run}/evidence/before-${theme}-${touch?'touch':'desktop'}.png`,fullPage:true,animations:'disabled'});
 cases.push({touch,theme,missingOpenReproduced:true});continue;
 }
 for(const entry of entries) {
 const button=entry.row.getByRole('button',{name:/^Open session:/});
 if(!entry.session){assert.equal(await button.count(),0);continue;}
 await button.waitFor();await button.scrollIntoViewIfNeeded();await button.waitFor({state:'visible'});
 await page.waitForFunction(id=>!document.querySelector(`[data-message-ref="${id}"] button[aria-label^="Open session:"]`)?.disabled,entry.id);
 assert.equal((await button.innerText()).trim(),'Open');assert.equal(await button.locator('svg').count(),1);
 const position=await button.boundingBox(),row=await entry.row.boundingBox(),bubble=await entry.row.locator('.neo-message-bubble').boundingBox();
 assert(Math.abs(position.x+position.width-(row.x+row.width))<=8);assert(position.y<bubble.y);
 await page.screenshot({path:`${run}/evidence/${theme}-${touch?'touch':'desktop'}-${entry.session.split(':')[0]}.png`,fullPage:true,animations:'disabled'});
 if(touch)await button.tap();else await button.click();
 if(entry.session==='local-worker') {
 const pane=page.locator('.neo-session-pane');await pane.getByRole('heading',{name:/Local worker/}).waitFor();
 await pane.getByRole('button',{name:'Back to Neo',exact:true}).click();await button.waitFor();
 if(!touch && theme==='light'){await button.focus();await button.press('Enter');await pane.getByRole('heading',{name:/Local worker/}).waitFor();await pane.getByRole('button',{name:'Back to Neo',exact:true}).click();}
 } else {
 const expected=entry.session.startsWith('codex')?'codex://threads/synthetic-thread':'claude://claude.ai/epitaxy/synthetic-session';
 assert.equal((await page.evaluate(()=>window.nativeOpens)).at(-1),expected);
 }
 }
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 cases.push({touch,theme,localPane:true,nativeLinks:true,ordinaryWithoutOpen:true,topRight:true});
 } catch(error){await page.screenshot({path:`${run}/evidence/failure-${theme}-${touch}.png`,fullPage:true,animations:'disabled'});throw error;} finally {await context.close();}
 }
 const result={passed:true,phase:fixture.phase,cases,nativeAppLaunch:'captured callback only'};writeFileSync(`${run}/evidence/browser.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await browser.close();}
