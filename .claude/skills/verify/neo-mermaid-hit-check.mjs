import assert from 'node:assert/strict';

export async function verifyMermaidHitAreas(page, fixture, { phase, evidence, touch = false }) {
  await page.goto(fixture.url);
  const article = page.locator('[data-public-entry]').filter({hasText:'Mermaid hit-area fixture'});
  await article.locator('.mermaid svg').waitFor();
  const expand = article.getByRole('button',{name:'Expand diagram',exact:true});
  const copy = article.getByRole('button',{name:'Copy code',exact:true});
  await expand.scrollIntoViewIfNeeded();
  await article.evaluate(async element => {
    await Promise.all(element.getAnimations({subtree:true}).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished));
  });
  const a=await expand.boundingBox(),b=await copy.boundingBox();
  assert(a&&b);
  const overlap=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x);
  if(phase==='before'&&touch) assert(overlap>0);
  else assert(overlap<=0);
  if(phase==='after'&&touch){assert(a.width>=44&&a.height>=44);assert(b.width>=44&&b.height>=44);}
  const use=button=>touch?button.tap():button.click();
  await use(copy);
  assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).trimEnd(),fixture.diagram);
  await use(expand);
  await page.getByRole('button',{name:'Close',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await article.screenshot({path:`${evidence}/${phase}-mermaid-${touch?'mobile':'desktop'}.png`,scale:'css'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  return {touch,expand:a,copy:b,overlap,codeClipboardExact:true,diagramOpens:true};
}
