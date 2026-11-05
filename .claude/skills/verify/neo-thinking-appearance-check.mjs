import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const levels = ['off', 'think8k', 'think16k', 'think24k', 'think32k', 'think48k', 'think64k'];

export async function verifyThinkingAppearance(page, fixture, { evidence, touch = false, repo, bunPath }) {
  const trigger = page.getByRole('button', { name: 'Model and thinking', exact: true });
  const use = control => touch ? control.tap() : control.click();
  const observations = [];
  for (const [step, level] of levels.entries()) {
    const reply = JSON.parse(execFileSync(bunPath, ['.claude/skills/verify/rpc.ts', 'neo.preferences.set',
      JSON.stringify({ model: 'glm-5', provider: 'glm', thinkingLevel: level })],
      { cwd: repo, encoding: 'utf8', env: { VERIFY_PORT: String(fixture.port) } })).reply;
    assert(reply.ok, JSON.stringify(reply));
    await page.goto(fixture.url);
    await page.getByRole('textbox', { name: 'Message Neo', exact: true }).focus();
    await page.waitForFunction(expected => document.querySelector('[data-thinking-level]')?.dataset.thinkingLevel === expected, level, { timeout: 5000 });
    await trigger.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished));
    });
    const observed = await trigger.evaluate(button => {
      const icon = button.querySelector('[data-thinking-level]');
      const rect = icon.querySelector('clipPath rect');
      const style = getComputedStyle(button), bounds = button.getBoundingClientRect();
      return { text: button.textContent, level: icon.dataset.thinkingLevel,
        border: style.borderWidth, background: style.backgroundColor,
        fillHeight: rect ? Number(rect.getAttribute('height')) : 0,
        fillY: rect ? Number(rect.getAttribute('y')) : null,
        glow: icon.querySelector('svg').style.filter,
        circles: icon.querySelectorAll('circle').length,
        fits: bounds.x >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight };
    });
    assert.equal(observed.level, level);
    assert.equal(observed.border, '0px');
    assert(!observed.text.includes('·'));
    assert.equal(observed.circles, 0);
    assert.equal(observed.fillHeight, 10 * step / 6);
    assert.equal(observed.glow.includes('drop-shadow'), step === 6);
    assert(observed.fits);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await trigger.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-${level}.png`, scale: 'css' });
    observations.push(observed);
    await use(trigger);
    assert.equal(await page.getByRole('slider', { name: 'Thinking', exact: true }).inputValue(), String(step));
    await page.getByRole('slider', { name: 'Thinking', exact: true }).press('Escape');
    await page.getByRole('group', { name: 'Model and thinking settings', exact: true }).waitFor({ state: 'detached' });
  }
  await page.reload();
  await page.getByRole('textbox', { name: 'Message Neo', exact: true }).focus();
  await page.waitForFunction(() => document.querySelector('[data-thinking-level]')?.dataset.thinkingLevel === 'think64k', undefined, { timeout: 5000 });
  await use(trigger);
  await page.getByRole('slider', { name: 'Thinking', exact: true }).press('Home');
  await page.waitForFunction(() => document.querySelector('[data-thinking-level]')?.dataset.thinkingLevel === 'off', undefined, { timeout: 5000 });
  await page.getByRole('textbox', { name: 'Message Neo', exact: true }).focus();
  if (await page.getByRole('button', { name: 'Close model settings', exact: true }).isVisible())
    await use(page.getByRole('button', { name: 'Close model settings', exact: true }));
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-off-final.png`, scale: 'css' });
  return { touch, observations, reloadKeepsUltra: true, menuReturnsToOff: true, escapeCloses: true };
}
