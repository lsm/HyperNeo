import assert from 'node:assert/strict';
import { verifySettledPreview } from './neo-settled-question-preview-web.mjs';

export async function verifyAllItems(page, fixture, { touch = false, evidence }) {
  const use = control => touch ? control.tap() : control.click();
  const settle = () => page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));});
  const requests = [];
  page.on('websocket', socket => socket.on('framesent', ({payload}) => {
    try { const value = JSON.parse(String(payload)); if(value.method === 'operation.invoke') requests.push(value); } catch {}
  }));
  await page.goto(fixture.url);
  if(touch) await use(page.getByRole('button', {name:/^Your work/}));
  const card = page.locator('[data-ask="all-items"]:visible');
  const footer = card.getByRole('button', {name:'All · 30',exact:true});
  await footer.waitFor();
  assert.equal(await card.locator('[data-ask-todo]').count(),2);
  assert.equal(await card.getByRole('button',{name:/done — show more|more — Details/}).count(),0);
  const dimensions = await footer.evaluate(element => ({button:element.getBoundingClientRect().width,parent:element.parentElement.getBoundingClientRect().width,height:element.getBoundingClientRect().height}));
  assert(dimensions.height >=44 && Math.abs(dimensions.button-dimensions.parent)<1);
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));});
  await settle();
  await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-card.png`,scale:'css'});
  await use(footer);
  const dialog = page.getByRole('dialog',{name:'Synthetic All items',exact:true});
  await dialog.locator('[data-todo-state="done"]').nth(19).waitFor();
  assert.equal(await dialog.locator('[data-todo-state="done"]').count(),20);
  assert.equal(await dialog.getByRole('region',{name:'In progress'}).getByText('Unfinished All step',{exact:true}).count(),1);
  assert.equal(await dialog.getByText('Done · 25',{exact:true}).count(),1);
  await settle();
  await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-first-page.png`,scale:'css'});
  await use(dialog.getByRole('button',{name:'5 done — show more',exact:true}));
  await dialog.locator('[data-todo-state="done"]').nth(24).waitFor();
  assert.equal(await dialog.locator('[data-todo-state="done"]').count(),25);
  assert.equal(await dialog.getByRole('list',{name:'Removed',exact:true}).getByText('Removed All step',{exact:true}).count(),1);
  assert.equal(await dialog.getByRole('list',{name:'Answered',exact:true}).locator('li').count(),2);
  assert.equal(await dialog.getByRole('list',{name:'No longer needed',exact:true}).locator('li').count(),1);
  await dialog.getByText('Outcome sentinel',{exact:true}).scrollIntoViewIfNeeded();
  await settle();
  await page.screenshot({path:`${evidence}/${touch?'mobile':'desktop'}-history.png`,scale:'css'});
  const bounds=await dialog.boundingBox(),viewport=page.viewportSize();
  assert(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=viewport.width+1 && bounds.y+bounds.height<=viewport.height+1);
  const ids=await page.locator('[id]').evaluateAll(elements=>elements.map(e=>e.id));
  assert.equal(ids.length,new Set(ids).size);
  await dialog.press('Escape');
  await dialog.waitFor({state:'detached'});
  await page.waitForFunction(()=>document.querySelector('[data-ask-details-toggle]')===document.activeElement);
  await use(footer);
  await dialog.locator('[data-todo-state="done"]').nth(24).waitFor();
  assert.equal(await dialog.locator('[data-todo-state="done"]').count(),25);
  await use(dialog.getByRole('button',{name:'Close modal',exact:true}));
  await dialog.waitFor({state:'detached'});
  await page.waitForFunction(()=>document.querySelector('[data-ask-details-toggle]')===document.activeElement);
  const preview=await verifySettledPreview(page,fixture,{touch,evidence});
  const offsets=requests.filter(r=>r.data?.name==='neo.ask.doneTodos').map(r=>r.data.input.offset);
  assert.equal(offsets.slice(0,2).join(','),'0,20');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  return {touch,dimensions,doneRows:25,pageOffsets:offsets,focusReturned:true,duplicateIds:false,preview};
}
