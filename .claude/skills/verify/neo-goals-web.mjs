import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const seed = JSON.parse(readFileSync(`${run}/evidence/neo-goals-seed.json`, 'utf8'));
function rpc(name,input) {
  const response = JSON.parse(execFileSync('bun',['.claude/skills/verify/rpc.ts',name,JSON.stringify(input)], {
    env:{ ...process.env, VERIFY_PORT:port }, encoding:'utf8',
  }));
  assert(!response.reply.error,JSON.stringify(response));
  return response.reply;
}
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless:true,
  ...(process.env.VERIFY_BROWSER ? { executablePath:process.env.VERIFY_BROWSER } : {}),
});
const observed=[];
try {
  const page = await browser.newPage({ viewport:{ width:1280,height:1000 }, locale:'en-US' });
  for (const width of [1280,390]) {
    await page.setViewportSize({ width,height:1000 });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width === 390) await page.getByRole('button',{ name:'Your work',exact:true }).click();
    const section=page.getByRole('region',{ name:'Goals',exact:true });
    await section.getByText('Reached thirty readers',{ exact:true }).waitFor();
    assert.equal(await section.locator('[data-neo-goal]').count(),2);
    for (const title of ['Other private goal','Already shipped','Old draft effect'])
      assert.equal(await section.getByText(title,{ exact:true }).count(),0);
    const progress=section.getByRole('progressbar',{ name:'Publish guide',exact:true });
    assert.equal(await progress.getAttribute('aria-valuenow'),'30');
    await section.getByText('Release is public',{ exact:true }).waitFor();
    await section.getByText('No wake scheduled',{ exact:true }).waitFor();
    const schedules=rpc('schedule.session.list',{ target:{ adapter:'hyperneo',id:seed.root } }).schedules;
    const next=schedules.find(row => row.sourceId === seed.measured).nextRunAt;
    assert.equal(await section.locator('time').getAttribute('datetime'),new Date(next).toISOString());
    const effect=`Updated journal effect at ${width}`;
    assert(rpc('goal.journal.append',{ ownerSessionId:seed.root,goalId:seed.measured,
      done:'Checked synthetic readers',effect,worked:'Keep useful examples',evidence:[] }).accepted);
    await section.getByRole('button',{ name:'Refresh goals',exact:true }).click();
    await section.getByText(effect,{ exact:true }).waitFor();
    const box=await section.boundingBox();
    assert(box && box.x >= 0 && box.x+box.width <= width+1,JSON.stringify(box));
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForFunction(() => document.getAnimations().every(animation =>
      animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
    await page.screenshot({ path:`${run}/evidence/neo-goals-${width}.png`,fullPage:true });
    observed.push({ width,text:await section.innerText(),count:2,nextWakeMatchesRPC:true,journalRefreshed:true });
    assert(rpc('goal.journal.append',{ ownerSessionId:seed.root,goalId:seed.measured,
      done:'Reset synthetic fixture label',effect:'Reached thirty readers',worked:'Keep examples',evidence:[] }).accepted);
  }
  for (const goalId of [seed.measured,seed.paused]) assert(rpc('goal.session.update',{
    ownerSessionId:seed.root,goalId,status:'completed',
  }).accepted);
  const section=page.getByRole('region',{ name:'Goals',exact:true });
  await section.getByRole('button',{ name:'Refresh goals',exact:true }).click();
  await section.getByText('No goals yet',{ exact:true }).waitFor();
  assert.equal(await section.locator('[data-neo-goal]').count(),0);
  await page.screenshot({ path:`${run}/evidence/neo-goals-empty.png`,fullPage:true });
  observed.push({ state:'completed goals removed',empty:await section.innerText() });
  writeFileSync(`${run}/evidence/neo-goals-web.json`,JSON.stringify(observed,null,2));
  console.log(`PASS: scoped desktop/mobile goal list, actual schedule time, latest journal, refresh and closed-goal removal. ${run}/evidence/neo-goals-web.json`);
} finally { await browser.close(); }
