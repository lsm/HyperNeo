import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

export async function verifyGitTask(page, { run, width, phase, port = 9396 }) {
  const after = phase === 'after';
  const seed = JSON.parse(await readFile(`${run}/evidence/git-task-seed.json`, 'utf8'));
  const result = { width, phase, synthetic: true, github: 'local gh stub; Git and task RPC/LiveQuery are real' };
  await page.setViewportSize({width,height:1000});
  await page.goto(`http://127.0.0.1:${port}/session/${seed.worker}`);
  await page.getByRole('button',{name:'Conversation info',exact:true}).click();
  await page.getByRole('tab',{name:'Changes',exact:true}).click();
  const label = page.getByText('1 check failing',{exact:true});
  await label.click();
  const checkControl = () => after ? page.getByRole('button',{name:/^(more|less) — Git checks$/}) : page.getByTestId('git-checks-toggle');
  result.checkTitleClickExpanded = await checkControl().getAttribute('aria-expanded');
  assert.equal(result.checkTitleClickExpanded,after?'false':'true');
  if(!after) await checkControl().click();
  await page.screenshot({path:`${run}/evidence/${phase}-${width}-checks-closed.png`,scale:'css',animations:'disabled'});
  await checkControl().press('Enter');
  const checks = page.getByTestId('git-checks-list');
  await checks.waitFor();
  if(after) assert(await checkControl().evaluate(el=>el===document.activeElement));
  assert.equal(await checks.getByRole('link',{name:/Synthetic build/}).getAttribute('href'),'https://example.invalid/ci/1');
  await label.click();
  if(!after) await checkControl().click();
  assert.equal(await checkControl().getAttribute('aria-expanded'),'true');
  await checkControl().scrollIntoViewIfNeeded();
  result.checksControl = await checkControl().evaluate(el=>({right:el.getBoundingClientRect().right,parentRight:el.parentElement.getBoundingClientRect().right}));
  if(after) {
    assert(result.checksControl.parentRight-result.checksControl.right<=16);
    const rows=await checks.boundingBox(), button=await checkControl().boundingBox();
    assert(button.y>=rows.y+rows.height-2);
  }
  await page.screenshot({path:`${run}/evidence/${phase}-${width}-checks-open.png`,scale:'css',animations:'disabled'});
  await checkControl().press('Space');
  const diff = page.getByTestId('git-expand-diff');
  await diff.scrollIntoViewIfNeeded();
  await page.screenshot({path:`${run}/evidence/${phase}-${width}-diff-preview.png`,scale:'css',animations:'disabled'});
  const patchSection = page.locator('section').filter({has:page.locator('h3[title="big.txt"]')}).last();
  assert.equal(await patchSection.getByText('+Synthetic final diff ending',{exact:true}).count(),0);
  await diff.press('Enter');
  await patchSection.getByText('+Synthetic final diff ending',{exact:true}).waitFor();
  result.fullDiffLoaded = true;
  if(after) {
    const less = page.getByRole('button',{name:'less — Full diff',exact:true});
    assert(await less.evaluate(el=>el===document.activeElement));
    const lastLine=patchSection.getByText('+Synthetic final diff ending',{exact:true});
    await lastLine.click();
    const lineBox=await lastLine.boundingBox();
    const clip=await lastLine.evaluate(el=>el.closest('pre').parentElement.parentElement.getBoundingClientRect().toJSON());
    const start=Math.max(lineBox.x,clip.x)+8;
    await page.mouse.move(start,lineBox.y+8);await page.mouse.down();
    await page.mouse.move(Math.min(start+100,clip.right-10),lineBox.y+8,{steps:8});await page.mouse.up();
    result.diffSelection=await page.evaluate(()=>window.getSelection()?.toString());
    assert(result.diffSelection?.length>2);
    assert.equal(await less.getAttribute('aria-expanded'),'true');
    await less.scrollIntoViewIfNeeded();
    result.diffControl = await less.evaluate(el=>({right:el.getBoundingClientRect().right,parentRight:el.parentElement.getBoundingClientRect().right}));
    assert(result.diffControl.parentRight-result.diffControl.right<=16);
    await page.screenshot({path:`${run}/evidence/${phase}-${width}-diff-full.png`,scale:'css',animations:'disabled'});
    await less.press('Space');
    assert.equal(await patchSection.getByText('+Synthetic final diff ending',{exact:true}).count(),0);
    assert(await page.getByRole('button',{name:'more — Full diff',exact:true}).evaluate(el=>el===document.activeElement));
  } else {
    assert.equal(await page.getByRole('button',{name:/less/}).count(),0);
    await patchSection.getByText('+Synthetic final diff ending',{exact:true}).scrollIntoViewIfNeeded();
    result.diffControl = null;
    await page.screenshot({path:`${run}/evidence/${phase}-${width}-diff-full.png`,scale:'css',animations:'disabled'});
  }
  await page.getByRole('button',{name:/^M small.txt/}).click();
  await page.getByText('+Synthetic small file',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('git-expand-diff').count(),0);
  await page.getByRole('button',{name:/^M big.txt/}).click();
  await page.getByTestId('git-expand-diff').waitFor();
  result.selectedFileReset = true;
  await page.goto(`http://127.0.0.1:${port}/space/${seed.spaceId}/task/${seed.taskId}`);
  const kickoff = page.getByTestId('minimal-thread-task-kickoff');
  await kickoff.click();
  result.kickoffTitleClickExpanded = after ? await page.getByRole('button',{name:'more — Task kickoff',exact:true}).getAttribute('aria-expanded') : await kickoff.getAttribute('aria-expanded');
  assert.equal(result.kickoffTitleClickExpanded,after?'false':'true');
  if(!after) await kickoff.click();
  await page.screenshot({path:`${run}/evidence/${phase}-${width}-kickoff-closed.png`,scale:'css',animations:'disabled'});
  await (after?page.getByRole('button',{name:'more — Task kickoff',exact:true}):kickoff).press('Enter');
  const body = page.getByTestId('minimal-thread-task-kickoff-body');
  await body.getByText('Synthetic kickoff ending.',{exact:true}).waitFor();
  if(after) assert(await page.getByRole('button',{name:'less — Task kickoff',exact:true}).evaluate(el=>el===document.activeElement));
  assert.match(await body.innerText(),/Synthetic kickoff ending/);
  await body.getByText('Synthetic kickoff ending.',{exact:true}).click();
  const control = after?page.getByRole('button',{name:'less — Task kickoff',exact:true}):kickoff;
  assert.equal(await control.getAttribute('aria-expanded'),'true');
  const ending=body.getByText('Synthetic kickoff ending.',{exact:true});
  const box=await ending.boundingBox();
  await page.mouse.move(box.x+2,box.y+8);await page.mouse.down();
  await page.mouse.move(box.x+Math.min(box.width-2,150),box.y+8,{steps:8});await page.mouse.up();
  result.kickoffSelection=await page.evaluate(()=>window.getSelection()?.toString());
  assert(result.kickoffSelection?.length>2);
  await control.scrollIntoViewIfNeeded();
  if(after) {
    const bounds=await control.boundingBox(), parent=await control.evaluate(el=>el.parentElement.getBoundingClientRect().toJSON());
    assert(Math.abs(bounds.x+bounds.width-parent.right)<2);
    assert(bounds.y>=box.y+box.height-2);
  }
  await page.screenshot({path:`${run}/evidence/${phase}-${width}-kickoff-open.png`,scale:'css',animations:'disabled'});
  await control.press('Space');
  assert.equal(await body.count(),0);
  if(after) assert(await page.getByRole('button',{name:'more — Task kickoff',exact:true}).evaluate(el=>el===document.activeElement));
  await writeFile(`${run}/evidence/${phase}-${width}.json`,JSON.stringify(result,null,2)+'\n');
  return result;
}
