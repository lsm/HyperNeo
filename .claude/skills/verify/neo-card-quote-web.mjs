import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const[port,run]=process.argv.slice(2);assert.notEqual(port,'8399');
const{chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.VERIFY_BROWSER});const evidence=[];
try{for(const width of[402,1280]){
 const page=await browser.newPage({viewport:{width,height:900}});await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(`http://127.0.0.1:${port}/neo`);
 const quotes=[];for(const[id,text]of[['new-card','Replacement choice'],['old-card','Earlier choice']]){
  const quote=page.locator(`[data-reply-to="question:${id}"] [data-quote-bar]`);await quote.waitFor();const body=await quote.innerText();assert(body.includes(text),body);assert(body.includes('Neo'),body);assert(!body.includes('Original message unavailable'),body);quotes.push(body);
 }
 await page.screenshot({path:`${run}/evidence/card-quotes-${width}.png`,animations:'disabled'});evidence.push({width,quotes});await page.close();
}}finally{await browser.close();writeFileSync(`${run}/evidence/web.json`,JSON.stringify(evidence,null,2));}
