import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export async function verifySharedDisclosure(page, { port, run, width, phase }) {
  assert.notEqual(String(port), '8399');
  const seed = JSON.parse(readFileSync(`${run}/evidence/disclosure-seed.json`, 'utf8'));
  const dir = `${run}/evidence/${phase}`;
  mkdirSync(dir, { recursive: true });
  const observed = [];
  const record = (item) => { observed.push(item); writeFileSync(`${dir}/disclosure-${width}.json`, JSON.stringify(observed, null, 2)); };
  async function position(button, name) {
    await button.scrollIntoViewIfNeeded();
    const layout = await button.evaluate((node) => {
      const paragraph = node.closest('p') ?? node.parentElement;
      const rect = (el) => { const b=el.getBoundingClientRect(); return { left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height }; };
      const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT); let last;
      for(let text=walker.nextNode();text;text=walker.nextNode()) if(text.textContent.trim() && !text.parentElement.closest('button')) last=text;
      let lastGlyph=null;
      if(last) { const range=document.createRange(); const end=last.textContent.trimEnd().length; range.setStart(last,end-1); range.setEnd(last,end); const r=range.getBoundingClientRect(); lastGlyph={left:r.left,right:r.right,top:r.top,bottom:r.bottom}; }
      return { button:rect(node), paragraph:rect(paragraph), float:getComputedStyle(node).cssFloat, lastGlyph };
    });
    record({ name, layout });
    await page.screenshot({ path:`${dir}/${name}-${width}.png` });
    if (phase === 'after') {
      assert.equal(layout.float, 'right');
      assert(Math.abs(layout.button.right - layout.paragraph.right) <= 2, JSON.stringify(layout));
      if (layout.lastGlyph) {
        const sameLine=layout.button.top < layout.lastGlyph.bottom && layout.button.bottom > layout.lastGlyph.top;
        const room=layout.lastGlyph.right + layout.button.width + 12 <= layout.paragraph.right;
        assert(room ? sameLine : layout.button.top >= layout.lastGlyph.top, JSON.stringify({room,sameLine,...layout}));
      }
    }
  }
  await page.setViewportSize({width,height:1000});
  await page.goto(`http://127.0.0.1:${port}/neo`);
  for (const item of seed.cases) {
    const article = page.locator('article[data-public-entry]').filter({ hasText:item.shortText });
    const more = article.getByRole('button', { name:/more$/ });
    await more.waitFor();
    await position(more, `${item.name}-collapsed`);
    await more.focus(); await page.keyboard.press('Enter');
    const less = article.getByRole('button', { name:/less$/ });
    await less.waitFor();
    await position(less, `${item.name}-expanded`);
    await article.locator('[data-publication-details] p').last().click({ position:{x:8,y:8} });
    assert.equal(await article.locator('[data-publication-details]').count(),1);
    if(item.name === 'short') {
      const p=article.locator('[data-publication-details] p').last(); const box=await p.boundingBox();
      await page.mouse.move(box.x+3,box.y+10); await page.mouse.down(); await page.mouse.move(box.x+75,box.y+10,{steps:8}); await page.mouse.up();
      const selected=await page.evaluate(()=>getSelection()?.toString()??''); assert(selected.length>0);
      assert.equal(await article.locator('[data-publication-details]').count(),1); record({name:'body-selection',selected});
    }
    await less.focus(); await page.keyboard.press('Space');
    assert.equal(await article.locator('[data-publication-details]').count(),0);
  }
  const human = page.locator('article[data-public-entry]').filter({hasText:'Synthetic human message'});
  await human.getByRole('button',{name:'Show more',exact:true}).click();
  await position(human.getByRole('button',{name:'Show less',exact:true}), 'human-expanded');
  await human.getByRole('button',{name:'Show less',exact:true}).click();
  if (width === 390) await page.getByRole('button', { name:/^Your work/ }).click();
  const card = page.locator('[data-ask="collapse-card"]:visible');
  const labels=await card.locator('button[aria-expanded]').evaluateAll(nodes=>nodes.map(node=>({visible:node.textContent.replace(/[▴▾]/g,'').trim(),name:node.getAttribute('aria-label')??node.textContent.trim()})));
  record({name:'visible-words-in-accessible-names',controls:labels});
  if(phase==='after') for(const control of labels) assert(control.name.toLocaleLowerCase().includes(control.visible.toLocaleLowerCase()),JSON.stringify(control));
  const row = card.locator('[data-ask-todo="collapse-card-1"]');
  const todoLabel=(expanded)=>`${phase==='after'?(expanded?'less — ':'more — '):''}${expanded?'Hide':'Show'} details: Synthetic step 1`;
  await row.getByText('Synthetic step 1', {exact:true}).click();
  const toggledByBody = await row.locator('[data-todo-details]').count();
  record({ name:'todo-body-click',toggledByBody });
  if (phase === 'after') assert.equal(toggledByBody,0);
  if (toggledByBody) await row.getByRole('button',{name:todoLabel(true)}).click();
  await row.getByRole('button',{name:todoLabel(false)}).focus(); await page.keyboard.press('Enter');
  await row.locator('[data-todo-details]').waitFor();
  const expandedTodoName=await row.getByRole('button',{name:todoLabel(true)}).getAttribute('aria-label');
  record({name:'expanded-todo-accessible-name',accessibleName:expandedTodoName});
  if(phase==='after') assert(expandedTodoName.includes('less'));
  await page.screenshot({path:`${dir}/todo-expanded-${width}.png`});
  await row.getByRole('button',{name:todoLabel(true)}).click();
  const details = card.locator('[data-ask-details-toggle]');
  await details.click();
  await card.getByText('Synthetic historical question with details.',{exact:true}).waitFor();
  if(phase==='after') { const name=await details.getAttribute('aria-label'); assert(name.includes('less')); record({name:'expanded-history-accessible-name',accessibleName:name}); }
  await page.screenshot({path:`${dir}/question-history-${width}.png`});
  await details.click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  return observed;
}
