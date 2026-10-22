import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const [port,run]=process.argv.slice(2);
assert(port && run && port!=='8399');
const log=readFileSync(`${run}/daemon.log`,'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const seed=JSON.parse(readFileSync(`${run}/evidence/goal-detail-seed.json`,'utf8'));
const reply=JSON.parse(execFileSync('bun',['.claude/skills/verify/rpc.ts','goal.session.update',JSON.stringify({
  ownerSessionId:seed.root,goalId:seed.goalId,metrics:{pending:null,readers:0,useful:false},mandateRef:'missing.md#adoption',
})],{env:{...process.env,VERIFY_PORT:port},encoding:'utf8'})).reply;
assert(reply.accepted,JSON.stringify(reply));
const {chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,...(process.env.VERIFY_BROWSER?{executablePath:process.env.VERIFY_BROWSER}:{})});
try {
  const page=await browser.newPage({viewport:{width:390,height:1000},locale:'en-US'});
  let capture;
  const held=new Promise(resolve=>{capture=resolve;});
  let homeId;
  let homeDone;
  const homeRead=new Promise(resolve=>{homeDone=resolve;});
  let hold=true;
  await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`,socket=>{
    const server=socket.connectToServer();
    socket.onMessage(raw=>{
      const message=JSON.parse(String(raw));
      if(message.data?.name==='neo.home.read')homeId=message.id;
      if(hold && message.data?.name==='goal.journal.list' && message.data.input.limit===20)capture({server,raw});
      else server.send(raw);
    });
    server.onMessage(raw=>{
      socket.send(raw);
      const message=JSON.parse(String(raw));
      if(homeId && message.requestId===homeId)homeDone();
    });
  });
  await page.goto(`http://127.0.0.1:${port}/neo`);
  await page.getByRole('button',{name:'Your work',exact:true}).click();
  const goals=page.getByRole('region',{name:'Goals',exact:true});
  await goals.getByRole('button',{name:'more — Publish useful guide',exact:true}).click();
  const pending=await held;
  const journal=goals.getByRole('region',{name:'Journal',exact:true});
  await journal.getByRole('status').waitFor();
  const retryDuringLoading=await journal.getByRole('button',{name:'Retry journal',exact:true}).count();
  await page.evaluate(async()=>{await document.fonts.ready;});
  await page.screenshot({path:`${run}/evidence/goal-review-loading.png`,fullPage:true});
  hold=false;pending.server.send(pending.raw);
  await journal.locator('[data-journal-entry]').first().waitFor();
  await homeRead;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const text=await goals.innerText();
  const alerts=await goals.getByRole('alert').allTextContents();
  assert.equal(await goals.getByRole('link',{name:'missing.md#adoption',exact:true}).count(),0);
  await goals.getByText('missing.md#adoption',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:`${run}/evidence/goal-review-metadata.png`,fullPage:true});
  const result={retryDuringLoading,alerts,text,missingMandateIsText:true,hold:'Only the first full journal read was delayed; its reply and all other RPCs came from the actual isolated daemon.'};
  writeFileSync(`${run}/evidence/goal-review.json`,JSON.stringify(result,null,2));
  assert.equal(retryDuringLoading,0);
  assert.deepEqual(alerts,[]);
  assert(text.includes('pending: —') && text.includes('readers: 0') && text.includes('useful: false'));
  console.log(`PASS: loading/retry, nullable metrics and optional metadata refusal. ${run}/evidence/goal-review.json`);
} finally {await browser.close();}
