import assert from 'node:assert/strict';

export async function verifyOpenControls(page, fixture, { theme, touch = false, evidence }) {
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  if(touch) await use(page.getByRole('button',{name:/^Your work/}));
  const readColors=element=>{
      const rgb=color=>{const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,1,1);return Array.from(context.getImageData(0,0,1,1).data);};
      const luminance=values=>values.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      let parent=element;const layers=[];
      while(parent){layers.push(rgb(getComputedStyle(parent).backgroundColor));parent=parent.parentElement;}
      const backgroundValues=layers.reverse().reduce((base,layer)=>base.map((v,i)=>v*(1-layer[3]/255)+layer[i]*layer[3]/255),[255,255,255]);
      const background=`rgb(${backgroundValues.map(Math.round).join(', ')})`;
      const logo=getComputedStyle(element.querySelector('svg')).color,text=getComputedStyle(element).color;
      const contrast=color=>{const a=luminance(rgb(color)),b=luminance(rgb(background));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
      return {logo,text,background,logoContrast:contrast(logo),textContrast:contrast(text)};
  };
  const observed=[];
  for(const source of fixture.sessions) {
    const card=page.locator(`[data-ask="open-${source.id}"]:visible`);
    const question=card.locator('[data-question-source] button');
    const todo=card.locator('[data-ask-todo] button[aria-label^="Open "]');
    await question.locator('svg').waitFor();
    assert.equal(await card.locator('[data-ask-focused-session] button').count(),0);
    for(const control of [question,todo]) {
      assert.equal((await control.innerText()).trim(),'Open');
      assert.equal(await control.locator('svg').count(),1);
    }
    const colors=await question.evaluate(readColors);
    assert(colors.logoContrast>=3 && colors.textContrast>=4.5,JSON.stringify({theme,source:source.adapter,...colors}));
    const todoColor=await todo.locator('svg').evaluate(e=>getComputedStyle(e).color);
    assert.equal(todoColor,colors.logo);
    await card.evaluate(element=>element.scrollIntoView({block:'center'}));
    await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));});
    await card.screenshot({path:`${evidence}/${theme}-${touch?'touch':'desktop'}-${source.adapter}.png`,scale:'css'});
    observed.push({adapter:source.adapter,headerOpeners:0,questionAndTodoLogos:true,...colors});
  }
  const focusedCases=[];
  for(const id of ['retired-focus','start-focus']) {
  const retired=page.locator(`[data-ask="${id}"]:visible`);
  const retainedOpen=retired.getByRole('button',{name:'Open session: Local worker',exact:true});
  await retainedOpen.waitFor();
  assert.equal(await retired.locator('[data-ask-focused-session] button').count(),0);
  assert.equal(await retired.getByRole('button',{name:/^Open /}).count(),1);
  assert.equal((await retainedOpen.innerText()).trim(),'Open');
  assert.equal(await retainedOpen.locator('svg').count(),1);
  const retiredColors=await retainedOpen.evaluate(readColors);
  assert(retiredColors.logoContrast>=3 && retiredColors.textContrast>=4.5);
  await retired.evaluate(element=>element.scrollIntoView({block:'center'}));
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));});
  await retired.screenshot({path:`${evidence}/${theme}-${touch?'touch':'desktop'}-${id}.png`,scale:'css'});
  await use(retainedOpen);
  await page.locator('.neo-session-pane').getByRole('heading',{name:/Local worker/}).waitFor();
  await use(page.locator('.neo-session-pane').getByRole('button',{name:'Back to Neo',exact:true}));
  await retainedOpen.waitFor();
  focusedCases.push({id,navigation:true,...retiredColors});
  }
  const local=page.locator('[data-ask="open-local-worker"]:visible');
  for(const control of [local.locator('[data-question-source] button'),local.locator('[data-ask-todo] button[aria-label^="Open "]')]) {
    await use(control);
    const pane=page.locator('.neo-session-pane');
    await pane.getByRole('heading',{name:/Local worker/}).waitFor();
    await use(pane.getByRole('button',{name:'Back to Neo',exact:true}));
    await local.getByRole('button',{name:'Continue',exact:true}).waitFor();
  }
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  return {theme,touch,observed,focusedCases,localQuestionAndTodoNavigation:true,answerControlsPreserved:true};
}
