import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyWorkSearch(page, fixture, { evidence, touch = false }) {
  let reads=0, failRead=false;
  await page.routeWebSocket(`ws://127.0.0.1:${fixture.port}/ws`,ws=>{
    const server=ws.connectToServer();
    ws.onMessage(raw=>{
      const request=JSON.parse(String(raw));
      if(request.type==='REQ'&&request.data?.name==='neo.ask.read'){
        reads++;
        if(failRead){failRead=false;ws.send(JSON.stringify({...request,id:randomUUID(),requestId:request.id,type:'RSP',data:undefined,error:'Synthetic search read unavailable'}));return;}
      }
      server.send(raw);
    });
  });
  await page.goto(fixture.url);
  const use=control=>touch?control.tap():control.click();
  if(touch)await use(page.getByRole('button',{name:/^Your work/}));
  const work=page.locator('.neo-scene-list:visible');
  await work.locator('[data-ask="ask-match"]').waitFor();
  const capture=async name=>{
    await work.evaluate(async element=>{
      await Promise.all(element.getAnimations({subtree:true}).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished));
    });
    await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-${name}.png`,scale:'css'});
  };
  await capture('closed');
  assert.equal(await work.getByRole('searchbox').count(),0);
  await use(work.getByRole('button',{name:'Search work',exact:true}));
  const input=work.getByRole('searchbox',{name:'Search work',exact:true});
  await input.waitFor();
  const results=work.locator('[data-scene-group="search"] [data-ask]');
  const ids=()=>results.evaluateAll(elements=>elements.map(element=>element.getAttribute('data-ask')));
  await input.fill('needle');
  await results.nth(3).waitFor();
  assert.equal((await ids()).join(','),'ask-match,todo-match,status-match,report-match');
  const firstReads=reads;
  assert.equal(firstReads,fixture.cases.length);
  await capture('ranked');
  await results.last().scrollIntoViewIfNeeded();
  await capture('ranked-tail');
  const observed=[];
  for(const [query,id] of [['microcipher731','report-match'],['evidencesigil732','todo-match'],['outcomesigil733','status-match'],['permission734','ask-match'],['数据','cjk-match']]){
    await input.fill(query);
    await page.waitForFunction(expected=>document.querySelector('[data-scene-group="search"] [data-ask]')?.getAttribute('data-ask')===expected,id);
    assert.equal((await ids()).join(','),id);observed.push({query,id});
  }
  assert.equal(reads,firstReads);
  await input.fill('unmatchedsigil999');
  await work.getByText('No matching work',{exact:true}).waitFor();
  assert.equal(await results.count(),0);
  await capture('empty');
  await input.press('Escape');
  await input.waitFor({state:'detached'});
  assert.equal(await work.locator('[data-ask]').count(),fixture.cases.length);
  failRead=true;
  await use(work.getByRole('button',{name:'Search work',exact:true}));
  await input.fill('needle');
  await work.getByText('Could not search work. Close and reopen search to retry.',{exact:true}).waitFor();
  assert.equal(await work.getByText('No matching work',{exact:true}).count(),0);
  await input.press('Escape');
  await input.waitFor({state:'detached'});
  await use(work.getByRole('button',{name:'Search work',exact:true}));
  await input.fill('needle');
  await results.nth(3).waitFor();
  assert.equal((await ids()).join(','),'ask-match,todo-match,status-match,report-match');
  const box=await input.boundingBox();assert(box&&box.x>=0&&box.x+box.width<=page.viewportSize().width+1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await capture('recovered');
  return {touch,firstReads,queryChangesReuseIndex:true,observed,noMatches:true,escapeRestoresList:true,readFailureDistinct:true,recovery:true};
}
