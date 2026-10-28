import assert from 'node:assert/strict';

export function micMetrics(value) {
  const radius = value.radiusCss.includes('infinity')
    ? Math.min(value.width, value.height) / 2
    : parseFloat(value.radiusCss);
  return { ...value, radius };
}

export async function verifyMicRadiusSerialization(page) {
  await page.setContent('<button style="width:48px;height:44px;border-radius:calc(infinity * 1px)">Mic</button>');
  const values = await page.locator('button').evaluate(e => ({
    width: e.offsetWidth, height: e.offsetHeight,
    authored: e.style.borderTopRightRadius,
    computed: getComputedStyle(e).borderTopRightRadius,
  }));
  for (const radiusCss of [values.authored, values.computed])
    assert(micMetrics({ ...values, radiusCss }).radius >= 22, radiusCss);
  return values;
}

export async function verifyMicShape(page, fixture, { phase, theme, touch = false, evidence }) {
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  const observed = [];
  for (const surface of ['neo', 'session']) {
    if (surface === 'session') {
      if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
      await use(page.getByRole('button', { name: 'Open session: Synthetic mic chat', exact: true }));
    }
    const scope = surface === 'neo' ? page.locator('.neo-shell > .neo-composer-dock') : page.locator('.neo-session-pane');
    const form = scope.locator('form.neo-composer-input');
    const mic = form.getByRole('button', { name: 'Start voice input', exact: true });
    await mic.waitFor();
    await page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== 'running'), null, { timeout: 10000 });
    const metrics = () => mic.evaluate(e => {
      const style = getComputedStyle(e), box = e.getBoundingClientRect();
      return { width: box.width, height: box.height, targetWidth: e.offsetWidth, targetHeight: e.offsetHeight, radiusCss: style.borderTopRightRadius, background: style.backgroundColor, shadow: style.boxShadow, outline: style.outlineStyle };
    }).then(micMetrics);
    const check = value => {
      assert(value.targetWidth >= 44 && value.targetHeight >= 44);
      assert.equal(value.radius >= Math.min(value.width, value.height) / 2, phase === 'after', JSON.stringify(value));
    };
    const states = [];
    if (!touch) {
      await mic.hover();
      await page.waitForTimeout(180);
      states.push({ name: 'hover', ...await metrics() });
      check(states.at(-1));
      await form.screenshot({ path: `${evidence}/${phase}-${theme}-${surface}-hover.png`, scale: 'css' });
    }
    await mic.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.press('Tab');
    await mic.focus();
    states.push({ name: 'focus', ...await metrics() });
    check(states.at(-1));
    await form.screenshot({ path: `${evidence}/${phase}-${theme}-${touch ? 'touch' : 'desktop'}-${surface}-focus.png`, scale: 'css' });
    const pressed = mic.evaluate(e => new Promise(resolve => e.addEventListener('pointerdown', () => {
      const style = getComputedStyle(e), box = e.getBoundingClientRect();
      resolve({ width: box.width, height: box.height, targetWidth: e.offsetWidth, targetHeight: e.offsetHeight, radiusCss: style.borderTopRightRadius });
    }, { once: true }))).then(micMetrics);
    await use(mic);
    states.push({ name: 'pressed', ...await pressed });
    check(states.at(-1));
    await form.getByRole('button', { name: 'Stop recording and keep the text as a draft', exact: true }).waitFor();
    await form.screenshot({ path: `${evidence}/${phase}-${theme}-${touch ? 'touch' : 'desktop'}-${surface}-recording.png`, scale: 'css' });
    await use(form.getByRole('button', { name: /Cancel recording/ }));
    await mic.waitFor();
    await mic.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await mic.press('Enter');
    await form.getByRole('button', { name: 'Stop recording and keep the text as a draft', exact: true }).waitFor();
    await use(form.getByRole('button', { name: /Cancel recording/ }));
    await mic.waitFor();
    observed.push({ surface, states, keyboardStartsRecording: true, firstPressStartsRecording: true, cancelledWithoutSending: true });
  }
  return { theme, touch, observed };
}
