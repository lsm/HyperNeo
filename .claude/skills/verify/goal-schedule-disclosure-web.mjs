import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifyGoalSchedule(page, { port, run, width, phase }) {
  const after = phase === 'after';
  const seed = JSON.parse(await readFile(`${run}/evidence/goal-detail-seed.json`, 'utf8'));
  const dir = `${run}/evidence/${phase}`;
  await mkdir(dir, { recursive: true });
  const observations = [];
  await page.setViewportSize({ width, height: 1000 });
  for (const entrypoint of ['schedule', 'goals']) {
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (entrypoint === 'goals' && width === 390) await page.getByRole('button', { name: /Your work/ }).click();
    const root = entrypoint === 'schedule' ? page.locator(`[data-session-schedules="${seed.root}"]`) : page.getByRole('region', { name: 'Goals', exact: true });
    await root.waitFor();
    const result = { width, entrypoint, phase };
    if (entrypoint === 'schedule') {
      await root.getByText('Schedules', { exact: true }).click();
      result.stripBodyOpens = await root.getAttribute('open') !== null;
      if (after) { assert.equal(result.stripBodyOpens, false); await root.getByRole('button', { name: 'more — Schedules', exact: true }).click(); }
    }
    const title = root.getByText('Publish useful guide', { exact: true });
    await title.click();
    const control = () => root.getByRole('button', { name: /(?:more|less).*Publish useful guide/ });
    if (after) {
      assert.equal(await root.getByText('Guide for adopters', { exact: true }).count(), 0);
      await control().focus(); await page.keyboard.press('Enter');
    }
    await root.getByText('Concrete examples work', { exact: true }).waitFor();
    for (const value of ['Guide for adopters','readers: 30','useful: true','Write examples']) await root.getByText(value,{exact:true}).waitFor();
    const mandate = root.getByRole('link',{name:'mandate.md#adoption',exact:true});
    assert.equal(await mandate.getAttribute('href'),`https://github.com/example/synthetic-neo-home/blob/${seed.rev}/mandate.md#adoption`);
    const journal = root.getByRole('region',{name:'Journal',exact:true});
    const latest = journal.locator(`[data-journal-entry="${seed.ids[0]}"]`);
    await latest.waitFor();
    await root.getByText('Guide for adopters',{exact:true}).scrollIntoViewIfNeeded();
    await settle(page); await page.screenshot({path:`${dir}/definition-${entrypoint}-${width}.png`,scale:'css'});
    await latest.locator('summary').click();
    result.journalBodyOpens = await latest.getAttribute('open') !== null;
    if(after) {assert.equal(result.journalBodyOpens,false);await latest.getByRole('button',{name:'more — Effect 21',exact:true}).click();}
    const evidence = latest.getByRole('link',{name:'Guide PR 21',exact:true});
    assert.equal(await evidence.getAttribute('href'),'https://github.com/example/synthetic-repo/pull/21');
    await journal.getByRole('button',{name:'Older entries',exact:true}).click();
    await journal.locator('[data-journal-entry]').nth(20).waitFor();
    result.ids=await journal.locator('[data-journal-entry]').evaluateAll(rows=>rows.map(r=>r.getAttribute('data-journal-entry')));
    assert.equal(JSON.stringify(result.ids),JSON.stringify(seed.ids));
    assert.equal(await latest.getAttribute('open'),'');
    if(after) {
      await latest.getByText('Published draft 21',{exact:true}).click();
      assert.equal(await latest.getAttribute('open'),'');
      result.journalControl=await bounds(latest.getByRole('button',{name:'less — Effect 21',exact:true}));
    }
    await evidence.scrollIntoViewIfNeeded(); await settle(page);
    await page.screenshot({path:`${dir}/journal-${entrypoint}-${width}.png`,scale:'css'});
    if(after) {
      await root.getByText('Guide for adopters',{exact:true}).click();
      assert.equal(await control().getAttribute('aria-expanded'),'true');
      result.goalControl=await bounds(control());
      await control().scrollIntoViewIfNeeded();await settle(page);
      await page.screenshot({path:`${dir}/footer-${entrypoint}-${width}.png`,scale:'css'});
      await control().press('Space');
      assert.equal(await root.getByText('Guide for adopters',{exact:true}).count(),0);
      if(entrypoint==='schedule') {
        const less=root.getByRole('button',{name:'less — Schedules',exact:true});
        result.stripControl=await bounds(less);await less.click();assert.equal(await root.getAttribute('open'),null);
      }
      for(const c of [result.goalControl,result.journalControl,result.stripControl].filter(Boolean)) assert(Math.abs(c.parentRight-c.right)<=18);
    }
    result.viewport=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
    assert.equal(result.viewport.width,result.viewport.scrollWidth);
    observations.push(result);
  }
  await writeFile(`${dir}/observed-${width}.json`,JSON.stringify(observations,null,2));
  return observations;
}
async function bounds(button) {return button.evaluate(b=>{const r=b.getBoundingClientRect(),p=b.parentElement.getBoundingClientRect();return {name:b.getAttribute('aria-label'),right:r.right,bottom:r.bottom,parentRight:p.right,parentBottom:p.bottom};});}
async function settle(page) {await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))) ;}

export async function changeGoalSchedule(page, { port, run, paused }) {
  const seed=JSON.parse(await readFile(`${run}/evidence/goal-detail-seed.json`,'utf8'));
  await page.goto(`http://127.0.0.1:${port}/neo`);
  const strip=page.locator(`[data-session-schedules="${seed.root}"]`);
  await strip.getByRole('button',{name:'more — Schedules',exact:true}).click();
  const row=strip.locator('[data-schedule]').filter({hasText:'Publish useful guide'});
  await row.getByRole('button',{name:paused?'Pause':'Resume',exact:true}).click();
  await row.getByRole('button',{name:paused?'Resume':'Pause',exact:true}).waitFor();
  assert.equal(await row.getByText('Guide for adopters',{exact:true}).count(),0);
  await settle(page);
  await page.screenshot({path:`${run}/evidence/schedule-${paused?'paused':'active'}.png`,scale:'css'});
  return {paused,text:await row.innerText()};
}
