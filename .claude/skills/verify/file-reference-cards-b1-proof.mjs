import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyLiveFilePage} from './live-file-web-a4-proof.mjs';

export async function verifyCardSources(page,{run,base,width,bun}) {
  const {files,todoId,questionId}=JSON.parse(await readFile(join(run,'evidence/file-card-sources.json'),'utf8'));
  assert(files[0].startsWith(join(run,'workspace')+'/'));
  const calls=[];
  page.on('websocket',socket=>socket.on('framesent',frame=>{
    try {const call=JSON.parse(String(frame.payload)); if(call.method==='operation.invoke'&&/^(file\.reference|artifact\.)/.test(call.data?.name)) calls.push(call.data);}catch{}
  }));
  const env={HOME:join(run,'home'),NODE_ENV:'test',HYPERNEO_DATA_DIR:join(run,'data'),PATH:`${join(run,'bin')}:${dirname(bun)}:/usr/bin:/bin`};
  const counts=()=>execFileSync(bun,[fileURLToPath(new URL('./live-file-web-a4-seed.ts',import.meta.url)),run,'counts'],{env,encoding:'utf8'}).trim();
  const before=counts();
  await page.goto(`${base}/neo`);
  await page.getByText('Live source-bound files:',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Open current file: notes.md',exact:true}).count(),1);
  assert((await page.getByRole('button',{name:'Open preview: Synthetic notes',exact:true}).innerText()).includes('Saved attachment'));
  const question=page.locator(`[data-ask-question="${questionId}"]`);
  const work=async()=>{
    if(width>=1120){
      const tab=page.getByRole('tab',{name:/Your work/});
      if(await tab.count()) await tab.click();
    }else{
      const back=page.getByRole('button',{name:'Back',exact:true});
      if(await back.isVisible()) await back.click();
      if(!await question.isVisible()) await page.getByRole('button',{name:'Your work, 1 need your attention',exact:true}).click();
    }
    await question.waitFor({state:'visible'});
  };
  const shot=async name=>{
    await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
    await page.screenshot({path:join(run,'evidence',`cards-${name}-${width}.png`)});
  };
  const close=()=>width>=1120?page.getByRole('button',{name:'Close current notes.md',exact:true}).click():page.getByRole('button',{name:'Back',exact:true}).click();
  for(const [kind,id] of [['question',questionId],['todo',todoId]]){
    await work();
    const container=page.locator(`[data-ask-${kind}="${id}"]`);
    if(kind==='todo'){
      const toggle=container.locator('button[aria-expanded]');
      const title=container.locator('[data-todo-head]').getByRole('link',{name:`Open preview: ${files[0]}`,exact:true});
      const script=join(run,'workspace/script.sh');
      assert((await container.locator('[data-todo-head]').innerText()).includes(script));
      assert.equal(await container.locator('[data-todo-head]').getByRole('link',{name:new RegExp('script\\.sh')}).count(),0);
      assert.equal(await title.evaluate(node=>!!node.closest('button')),false);
      await writeFile(files[0],'# Inline todo source\n');
      await title.click();
      await page.getByRole('heading',{name:'Inline todo source',exact:true}).waitFor();
      await shot('todo-inline');
      await close();
      await work();
      if(await toggle.getAttribute('aria-expanded')==='false'){
        const box=await container.locator('[data-todo-head]').boundingBox();
        assert(box);
        await page.mouse.click(box.x+20,box.y+7);
        assert.equal(await toggle.getAttribute('aria-expanded'),'true');
      }
    }
    const card=container.getByRole('button',{name:'Open current file: current notes.md',exact:true});
    if(kind==='question') assert.equal(calls.length,0);
    assert.equal(await container.getByRole('button',{name:/Open current file:/}).count(),1);
    assert.equal(await page.getByRole('button',{name:/Open current file: metadata-only/}).count(),0);
    if(kind==='question'){
      assert.equal(await container.getByRole('link',{name:'PR',exact:true}).getAttribute('data-preview-reference'),null);
      const inline=container.getByRole('link',{name:`Open preview: ${files[0]}`,exact:true}).first();
      await writeFile(files[0],'# Inline question source\n');
      await inline.click();
      await page.getByRole('heading',{name:'Inline question source',exact:true}).waitFor();
      await shot('question-inline');
      await close();
      await work();
      const reportTrigger=container.getByRole('button',{name:'View full report',exact:true});
      await reportTrigger.click();
      const dialog=page.getByRole('dialog',{name:'View full report',exact:true});
      assert((await dialog.innerText()).includes(join(run,'workspace/script.sh')));
      assert.equal(await dialog.getByRole('link',{name:/script\.sh/}).count(),0);
      const reportLink=dialog.getByRole('link',{name:`Open preview: ${files[0]}`,exact:true});
      await reportLink.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading',{name:'Inline question source',exact:true}).waitFor();
      assert.equal(await dialog.count(),0);
      await shot('question-document');
      await close();
      await reportTrigger.waitFor({state:'visible'});
      assert.equal(await reportTrigger.evaluate(node=>document.activeElement===node),true);
      await work();
    }
    await card.scrollIntoViewIfNeeded();
    await shot(`${kind}-card`);
    await writeFile(files[0],'# Card source A\n');
    await card.click();
    await page.getByRole('heading',{name:'Card source A',exact:true}).waitFor();
    await work();
    await writeFile(files[0],'# Card source B\n');
    await card.click();
    await page.getByRole('heading',{name:'Card source B',exact:true}).waitFor();
    await shot(`${kind}-edited`);
    await close();
  }
  assert(calls.length>=4);
  assert(calls.every(call=>call.name==='file.reference.read'&&call.input.reference===join(run,'workspace/current notes.md')));
  for(const [kind,id] of [['question',questionId],['todo',todoId]]) assert(calls.filter(call=>call.input.sourceMessageOrCard.kind===kind&&call.input.sourceMessageOrCard.id===id).length>=2);
  assert.equal(counts(),before);
  const observed={width,question:true,todo:true,deduplicated:true,metadataExcluded:true,editedOnReopen:true,savedLabeled:true,sourceBound:true,noRegistryWrites:true};
  await writeFile(join(run,'evidence',`card-sources-${width}.json`),JSON.stringify(observed,null,2));
  return observed;
}

if(typeof process!=='undefined'&&process.argv[1]===fileURLToPath(import.meta.url)){
  const {createRequire}=await import('node:module');
  const {chromium}=createRequire(import.meta.url)('playwright');
  const [run,port]=process.argv.slice(2);
  assert.notEqual(port,'8399');
  const base=`http://127.0.0.1:${port}`;
  const browser=await chromium.launch({headless:true,...(process.env.VERIFY_BROWSER?{executablePath:process.env.VERIFY_BROWSER}:{})});
  const offOrigin=[];
  try{
    for(const width of [1280,390]){
      const context=await browser.newContext({viewport:{width,height:844},locale:'en-US',...(width===390?{isMobile:true,deviceScaleFactor:1}:{})});
      try{
        await context.route('**/*',route=>route.request().url().startsWith(base)?route.continue():(offOrigin.push(route.request().url()),route.abort()));
        const page=await context.newPage();
        const pairing=JSON.parse(execFileSync(process.env.VERIFY_BUN??'bun',['.claude/skills/verify/rpc.ts','device.pair.create',JSON.stringify({kind:'human',name:'Synthetic file cards'})],{env:{...process.env,VERIFY_PORT:port,HYPERNEO_DATA_DIR:join(run,'data')},encoding:'utf8'})).reply;
        assert.equal((await page.request.post(`${base}/pair`,{headers:{origin:base},data:{code:pairing.code,name:'Synthetic file cards'}})).status(),200);
        const options={run,base,width,bun:process.env.VERIFY_BUN??'bun'};
        await verifyLiveFilePage(page,{...options,cards:true});
        await verifyCardSources(page,options);
      }finally{await context.close();}
    }
    assert.equal(offOrigin.length,0);
    console.log('PASS: deduplicated publication/todo/question file cards use current reads; saved and Git previews remain separate');
  }finally{await browser.close();}
}
