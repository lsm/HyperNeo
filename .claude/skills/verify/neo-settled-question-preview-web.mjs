import assert from 'node:assert/strict';

export async function verifySettledPreview(page, fixture, { touch = false, evidence }) {
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
  const card = page.locator(`[data-ask="${fixture.askId ?? 'settled-preview'}"]:visible`);
  await card.waitFor();
  const settle = async () => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished));
  });
  await settle();
  await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-initial.png`,scale:'css'});
  await use(card.locator('[data-ask-details-toggle]'));
  const history = page.getByTestId(`neo-ask-all-${fixture.askId ?? 'settled-preview'}`);
  const first = history.locator('#neo-ref-question-answered-long');
  await first.getByRole('button', {name:'Read all',exact:true}).waitFor();
  const result = {touch, previewLengths:[], completeText:false, documentsSeparate:false, closed:false};
  for (const id of ['answered-long','retired-long']) {
    const row = history.locator(`#neo-ref-question-${id}`);
    await row.getByText('important choices', {exact:true}).first().waitFor();
    const preview = await row.innerText();
    assert(preview.length < 450 && !preview.includes('Final detail 9098'));
    assert(preview.includes(id === 'answered-long' ? 'Keep the decision' : 'No longer needed'));
    result.previewLengths.push(preview.length);
    await use(row.getByRole('button',{name:'Read all',exact:true}));
    const dialog=page.getByRole('dialog',{name:'Read all',exact:true});
    await dialog.getByRole('table').waitFor();
    assert.equal(await dialog.getByText('important choices',{exact:true}).count(),60);
    assert.equal(await dialog.getByRole('link',{name:'Safe source'}).getAttribute('href'),'https://example.test/decision');
    await dialog.getByText('Final detail 9098',{exact:true}).scrollIntoViewIfNeeded();
    assert((await dialog.innerText()).includes('Final detail 9098'));
    await settle();
    await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-${id}-full.png`,scale:'css'});
    const box=await dialog.boundingBox();const viewport=page.viewportSize();
    assert(box.x>=0 && box.y>=0 && box.x+box.width<=viewport.width+1 && box.y+box.height<=viewport.height+1);
    await use(dialog.getByRole('button',{name:'Close modal'}));
    await dialog.waitFor({state:'detached'});
    assert(!(await row.innerText()).includes('Final detail 9098'));
  }
  result.completeText=true;result.closed=true;
  assert.equal(await history.locator('#neo-ref-question-answered-short').getByRole('button',{name:'Read all',exact:true}).count(),0);
  await use(first.getByRole('button',{name:'View full report',exact:true}));
  const versions=page.getByRole('dialog',{name:'View full report',exact:true});assert.equal(await versions.locator('pre').innerText(),'Literal original versions');
  await use(versions.getByRole('button',{name:'Close modal'}));result.documentsSeparate=true;
  await first.scrollIntoViewIfNeeded();await settle();
  await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-preview.png`,scale:'css'});
  assert.equal(await card.getByRole('button',{name:'Continue',exact:true}).count(),1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  return result;
}
