import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifySearchRecovery(page, fixture, {phase,evidence,touch=false}) {
  let fail=true,hold=false;const held=[];
  await page.routeWebSocket(`ws://127.0.0.1:${fixture.port}/ws`,ws=>{
    const server=ws.connectToServer();
    ws.onMessage(raw=>{
      const request=JSON.parse(String(raw));
      if(request.type==='REQ' && request.data?.name==='neo.ask.read') {
        if(fail){fail=false;ws.send(JSON.stringify({...request,id:randomUUID(),requestId:request.id,type:'RSP',data:undefined,error:'Synthetic retry read failure'}));return;}
        if(hold){held.push(()=>server.send(raw));return;}
      }
      server.send(raw);
    });
  });
  const use=control=>touch?control.tap():control.click();
  const settle=()=>page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));});
  await page.goto(fixture.url);
  if(touch) await use(page.getByRole('button',{name:/^Your work/}));
  const work=page.locator('.neo-scene-list:visible');
  await work.getByRole('button',{name:'Search work',exact:true}).waitFor();
  await use(work.getByRole('button',{name:'Search work',exact:true}));
  const input=work.getByRole('searchbox',{name:'Search work',exact:true});
  const failure=work.getByText('Could not search work. Close and reopen search to retry.',{exact:true});
  await input.fill('needle');await failure.waitFor();
  await use(work.getByRole('button',{name:'Close work search',exact:true}));
  await input.waitFor({state:'detached'});
  hold=true;
  await use(work.getByRole('button',{name:'Search work',exact:true}));
  await input.waitFor();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await input.fill('needle');
  await page.waitForTimeout(150);
  const staleError=await failure.isVisible(),searching=await work.getByText('Searching work…',{exact:true}).isVisible();
  assert.equal(staleError,phase==='before');assert.equal(searching,phase==='after');
  await settle();
  await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-retry-${phase}.png`,scale:'css'});
  assert(held.length>0);hold=false;for(const release of held)release();
  await work.locator('[data-scene-group="search"] [data-ask]').nth(3).waitFor();
  await input.fill('数');await input.focus();
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'数据',selectionStart:2,selectionEnd:2});
  await input.press('Escape');
  const retained=await input.count()===1;
  assert.equal(retained,phase==='after');
  if(retained)assert((await input.inputValue()).includes('数据'));
  await settle();
  await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-ime-${phase}.png`,scale:'css'});
  await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
  await cdp.detach();
  if(retained){await input.press('Escape');await input.waitFor({state:'detached'});}
  return {touch,staleError,searching,compositionRetained:retained,ordinaryEscapeCloses:true,retryRecovers:true};
}
