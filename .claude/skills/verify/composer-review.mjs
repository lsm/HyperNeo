import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const cases = [], failures = [];
try {
  const made = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts','device.pair.create','{"kind":"human"}'], { encoding:'utf8' })).reply;
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, { headers:{origin:base}, data:{code:made.code,name:'Synthetic review browser'} });
  assert.equal(response.status(),200);
  const storageState = await pairing.storageState(); await pairing.close();
  for (const theme of ['light','dark']) for (const width of [390,1280]) {
    const context = await browser.newContext({ storageState, viewport:{width,height:900}, hasTouch:width===390, permissions:['microphone'] });
    await context.addInitScript(t=>localStorage.setItem('theme',t),theme);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await page.goto(`${base}/assets/composer-insets.html?pending`);
    const form = page.locator('form.neo-composer-input'); await form.waitFor();
    const pill = form.getByRole('button',{name:'Model and thinking',exact:true});
    const pillReceipt = await pill.evaluate(el=>{
      const column=el.querySelector('[data-pending-model-switch]').parentElement;
      return {height:el.getBoundingClientRect().height, display:getComputedStyle(column).display,
        direction:getComputedStyle(column).flexDirection, lineHeight:getComputedStyle(column).lineHeight,
        maximum:getComputedStyle(column).maxWidth};
    });
    if(pillReceipt.height>35.5 || pillReceipt.display!=='flex' || pillReceipt.maximum!=='none') failures.push(`${theme}/${width}: pending pill ${JSON.stringify(pillReceipt)}`);
    await page.keyboard.press('Tab');
    const send = form.getByRole('button',{name:'Send message',exact:true}); await send.focus();
    const outline = await send.evaluate(el=>({style:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth,color:getComputedStyle(el).outlineColor,visible:el.matches(':focus-visible'),class:el.className}));
    if(outline.style!=='none' && outline.width!=='0px' && outline.color!=='rgba(0, 0, 0, 0)') failures.push(`${theme}/${width}: send outline ${JSON.stringify(outline)}`);
    await page.screenshot({path:`${run}/evidence/review-${theme}-${width}-pending-focus.png`});
    await page.goto(`${base}/assets/composer-insets.html?pending&running`);
    await form.waitFor();
    const stop = form.getByRole('button',{name:'Stop',exact:true});
    const stopReceipt = await stop.evaluate(el=>{
      const face=el.firstElementChild, box=el.getBoundingClientRect(), f=face.getBoundingClientRect();
      return {width:box.width,height:box.height,faceWidth:f.width,faceHeight:f.height,radius:getComputedStyle(face).borderRadius};
    });
    if(stopReceipt.width!==44 || stopReceipt.height!==44 || stopReceipt.faceWidth!==44 || stopReceipt.faceHeight!==32 || stopReceipt.radius!=='10px') failures.push(`${theme}/${width}: stop ${JSON.stringify(stopReceipt)}`);
    await page.screenshot({path:`${run}/evidence/review-${theme}-${width}-running.png`});
    await page.goto(`${base}/neo`);
    const composer = page.locator('form.neo-composer-input');
    await composer.getByRole('button',{name:'Start voice input',exact:true}).click();
    await composer.getByRole('button',{name:'Cancel recording',exact:true}).waitFor();
    await page.evaluate(()=>document.activeElement?.blur()); await page.waitForTimeout(200);
    const padding = await composer.evaluate(el=>({collapsed:el.classList.contains('is-collapsed'),top:getComputedStyle(el).paddingTop,bottom:getComputedStyle(el).paddingBottom}));
    if(!padding.collapsed || padding.top!=='6px' || padding.bottom!=='6px') failures.push(`${theme}/${width}: recording padding ${JSON.stringify(padding)}`);
    await page.screenshot({path:`${run}/evidence/review-${theme}-${width}-collapsed-recording.png`});
    await composer.getByRole('button',{name:'Cancel recording',exact:true}).click();
    cases.push({theme,width,pill:pillReceipt,stop:stopReceipt,outline,padding});
    await context.close();
  }
  writeFileSync(`${run}/evidence/review-findings.json`,JSON.stringify({cases,failures},null,2));
  assert.equal(failures.length,0,failures.join('\n'));
  console.log('PASS: pending pill, keyboard focus, flat Stop and collapsed recording padding');
} finally {await browser.close();}
