import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyQuoteColours(page, {run,base,phase,theme,baseline}) {
  const {publicationId} = JSON.parse(await readFile(join(run,'evidence/quote-colour-fixture.json'),'utf8'));
  const errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(theme=>{
    localStorage.setItem('theme',theme);
  },theme);
  await page.goto(`${base}/neo`);
  const article=page.locator(`[data-message-ref="${publicationId}"]`);
  await article.locator('blockquote p').first().waitFor();
  await article.screenshot({path:join(run,'evidence',`${phase}-${theme}.png`),scale:'css'});
  const style=await article.evaluate(article=>{
    const q=article.querySelector('blockquote'), p=q.querySelector('p');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const c=canvas.getContext('2d');
    const rgba=colour=>{c.clearRect(0,0,1,1);c.fillStyle=colour;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data];};
    const fg=rgba(getComputedStyle(p).color).slice(0,3), border=rgba(getComputedStyle(q).borderLeftColor).slice(0,3);
    const overlayAlpha=rgba(getComputedStyle(q).backgroundColor)[3]/255;
    const layers=[];for(let el=q;el;el=el.parentElement)layers.unshift(getComputedStyle(el).backgroundColor);
    c.clearRect(0,0,1,1);c.fillStyle='#fff';c.fillRect(0,0,1,1);
    for(const colour of layers){c.fillStyle=colour;c.fillRect(0,0,1,1);}
    const bg=[...c.getImageData(0,0,1,1).data].slice(0,3);
    const lum=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const a=lum(fg),b=lum(bg);
    return {foreground:fg,border,background:bg,overlayAlpha,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),fontStyle:getComputedStyle(p).fontStyle,heading:getComputedStyle(article.querySelector('h2')).color};
  });
  const colours={dark:[205,189,234],light:[122,95,166]};
  const borders={dark:[128,100,158],light:[106,74,139]};
  assert.equal(style.foreground.join(','),colours[theme].join(','));
  assert.equal(style.border.join(','),(phase==='after'?borders[theme]:colours[theme]).join(','));
  assert.equal(style.fontStyle,'italic');
  assert(Math.abs(style.overlayAlpha-.06)<.005);
  assert(style.contrast>=4.5,`contrast ${style.contrast} must meet AA`);
  await article.getByRole('button',{name:'Copy quote',exact:true}).click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'The release notes are ready for review. Please check the small changes before publishing.\n\nThank you for taking a look.');
  await article.getByRole('button',{name:'Reply to Neo’s message',exact:true}).click();
  const bar=page.locator('[data-quote-bar]');await bar.waitFor();
  const reference=await bar.evaluate(el=>({colour:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor,accent:getComputedStyle(el.querySelector('[aria-hidden]')).backgroundColor}));
  const controls={heading:style.heading,reference};
  if(baseline)assert.equal(JSON.stringify(controls),JSON.stringify(baseline.controls),'gold heading and message-reference quote stay unchanged');
  await page.screenshot({path:join(run,'evidence',`overview-${phase}-${theme}.png`),scale:'css'});
  assert.deepEqual(errors,[]);
  const result={phase,theme,style,controls,copyPreserved:true,pageErrors:errors};
  await writeFile(join(run,'evidence',`${phase}-${theme}.json`),JSON.stringify(result,null,2));
  return result;
}
