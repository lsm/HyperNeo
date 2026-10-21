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
      return { button:rect(node), paragraph:rect(paragraph), float:getComputedStyle(node).cssFloat };
    });
    record({ name, layout });
    await page.screenshot({ path:`${dir}/${name}-${width}.png` });
    if (phase === 'after') {
      assert.equal(layout.float, 'right');
      assert(Math.abs(layout.button.right - layout.paragraph.right) <= 2, JSON.stringify(layout));
    }
  }
  await page.setViewportSize({width,height:1000});
  await page.goto(`http://127.0.0.1:${port}/neo`);
  for (const item of seed.cases) {
    const article = page.locator('article[data-public-entry]').filter({ hasText:item.shortText });
    const more = article.getByRole('button', { name:/more$/ });
    await more.waitFor();
    await position(more, `${item.name}-collapsed`);
    await more.click();
    const less = article.getByRole('button', { name:/less$/ });
    await less.waitFor();
    await position(less, `${item.name}-expanded`);
    await article.locator('[data-publication-details] p').last().click({ position:{x:8,y:8} });
    assert.equal(await article.locator('[data-publication-details]').count(),1);
    await less.click();
    assert.equal(await article.locator('[data-publication-details]').count(),0);
  }
  const human = page.locator('article[data-public-entry]').filter({hasText:'Synthetic human message'});
  await human.getByRole('button',{name:'Show more',exact:true}).click();
  await position(human.getByRole('button',{name:'Show less',exact:true}), 'human-expanded');
  await human.getByRole('button',{name:'Show less',exact:true}).click();
  if (width === 390) await page.getByRole('button', { name:/^Your work/ }).click();
  const card = page.locator('[data-ask="collapse-card"]:visible');
  const row = card.locator('[data-ask-todo="collapse-card-1"]');
  await row.getByText('Synthetic step 1', {exact:true}).click();
  const toggledByBody = await row.locator('[data-todo-details]').count();
  record({ name:'todo-body-click',toggledByBody });
  if (phase === 'after') assert.equal(toggledByBody,0);
  if (toggledByBody) await row.getByRole('button',{name:'Hide details: Synthetic step 1'}).click();
  await row.getByRole('button',{name:'Show details: Synthetic step 1'}).click();
  await page.screenshot({path:`${dir}/todo-expanded-${width}.png`});
  await row.getByRole('button',{name:'Hide details: Synthetic step 1'}).click();
  const details = card.locator('[data-ask-details-toggle]');
  await details.click();
  await card.getByText('Synthetic historical question with details.',{exact:true}).waitFor();
  await page.screenshot({path:`${dir}/question-history-${width}.png`});
  await details.click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  return observed;
}
