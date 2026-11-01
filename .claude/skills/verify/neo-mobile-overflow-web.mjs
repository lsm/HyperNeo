import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const run = process.argv[2], fixture = JSON.parse(readFileSync(`${run}/fixture.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const cases = [];
try {
  for (const [width, theme] of [[390, 'light'], [360, 'light'], [390, 'dark'], [360, 'dark'], [700, 'light'], [700, 'dark'], [1280, 'light']]) {
    const context = await browser.newContext({ viewport: { width, height: width === 700 ? 400 : width === 360 ? 800 : 844 }, hasTouch: width < 720, isMobile: width < 720, locale: 'en-US', reducedMotion: 'reduce' });
    const page = await context.newPage(), observations = [];
    try {
      await page.addInitScript(theme => localStorage.setItem('theme', theme), theme);
      await page.goto(fixture.url);
      await page.locator(`[data-message-ref="${fixture.publicationId}"] table`).waitFor();
      const measure = async (view) => {
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
        const sizes = await page.evaluate((view) => {
          const viewport = document.documentElement.clientWidth;
          const selector = view === 'all-work' ? '[data-testid="neo-ask-all-overflow-work"]' : view === 'work' ? '.neo-scene-list' : view === 'drawer' ? '.neo-drawer' : view === 'session' ? '.neo-session-pane' : '.neo-scroll, .neo-composer-dock, .neo-float-dock';
          const roots = [...document.querySelectorAll(selector)];
          const nodes = [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll('*')]))].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
          const boxes = nodes.map(el => { const rect = el.getBoundingClientRect(); let clipped = false; for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) { if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowX)) { clipped = true; break; } } return { node: el.tagName, class: el.className, width: rect.width, client: el.clientWidth, scroll: el.scrollWidth, left: rect.left, right: rect.right, overflowX: getComputedStyle(el).overflowX, clipped, allowed: !!el.closest('pre, .prose-table-wrapper, textarea, input, [aria-hidden="true"], [inert]') }; });
          const offenders = boxes.filter(b => !b.allowed && ((!b.clipped && (b.right > viewport + 1 || b.left < -1)) || (/auto|scroll/.test(b.overflowX) && b.scroll > b.client + 1)));
          return { viewport, document: document.documentElement.scrollWidth, boxes, offenders };
        }, view);
        observations.push({ view, ...sizes });
        await page.screenshot({ path: `${run}/evidence/${fixture.phase}-${width}-${theme}-${view}.png`, animations: 'disabled' });
      };
      await measure('conversation');
      const human = page.locator(`[data-message-ref="${fixture.humanId}"]`);
      const expand = human.getByRole('button', { name: 'Show more', exact: true });
      if (await expand.count()) await expand.press('Enter');
      assert.equal(await human.locator('[data-clamped]').count(), 0);
      await measure('human-expanded');
      const publication = page.locator(`[data-message-ref="${fixture.publicationId}"]`);
      await publication.getByRole('button', { name: 'more', exact: true }).click();
      await publication.locator('[data-publication-details] table').waitFor();
      await measure('publication-details');
      const composer = page.getByRole('textbox', { name: 'Message Neo', exact: true });
      await composer.fill(fixture.longLink);
      await measure('composer');
      await composer.fill('');
      await page.getByRole('button', { name: 'Settings and connection', exact: true }).click();
      await page.getByRole('dialog', { name: 'Settings and connection' }).waitFor();
      await measure('drawer');
      await page.locator('[data-testid="neo-drawer-backdrop"]').click({ position: { x: width - 5, y: 200 }, force: true });
      if (width < 1120) await page.getByRole('button', { name: /^Your work/ }).click();
      const card = page.locator('[data-ask="overflow-work"]');
      await card.waitFor({ state: 'visible' });
      await card.locator('table').waitFor();
      await measure('work');
      await card.locator('[data-ask-details-toggle]').click();
      await page.getByTestId('neo-ask-all-overflow-work').waitFor();
      await measure('all-work');
      if (fixture.phase === 'after' && width < 720) await page.getByRole('button', { name: 'Close modal', exact: true }).tap({ timeout: 3000 });
      else await page.keyboard.press('Escape');
      if (width < 1120) await page.getByRole('button', { name: 'Close work list', exact: true }).click();
      await page.locator(`[data-message-ref="${fixture.publicationId}"]`).getByRole('button', { name: /^Open session:/ }).click();
      await page.locator('.neo-session-pane table').waitFor();
      await measure('session');
      await page.getByRole('button', { name: 'Back to Neo', exact: true }).click();
      const scrollables = await page.locator('.neo-message .prose-table-wrapper, .neo-message pre').evaluateAll(nodes => nodes.map(el => { el.scrollLeft = 60; return { tag: el.tagName, width: el.clientWidth, scroll: el.scrollWidth, moved: el.scrollLeft > 0 }; }));
      assert(scrollables.some(s => s.tag === 'PRE' && s.moved));
      assert(scrollables.some(s => s.tag === 'DIV' && s.moved));
      cases.push({ width, theme, observations, scrollables });
    } finally { await context.close(); }
  }
  const desktopComparison = [];
  if (fixture.desktopBaseline) {
    const baseline = JSON.parse(readFileSync(fixture.desktopBaseline, 'utf8')).cases.find(c => c.width === 1280);
    const current = cases.find(c => c.width === 1280);
    for (const before of baseline.observations) {
      const after = current.observations.find(o => o.view === before.view);
      for (const prefix of ['neo-chat-rail', 'neo-composer-input', 'neo-scene-list', 'text-sm font-semibold text-fg']) {
        const select = o => o.boxes.find(b => typeof b.class === 'string' && b.class.startsWith(prefix));
        const b = select(before), a = select(after);
        if (b && a) { assert(Math.abs(a.width - b.width) <= 1, `${before.view}: desktop ${prefix} changed`); desktopComparison.push({ view: before.view, prefix, before: b.width, after: a.width }); }
      }
    }
    assert(desktopComparison.length);
  }
  const violations = cases.flatMap(c => c.observations.filter(o => o.document > o.viewport || o.offenders.length).map(o => ({ width: c.width, theme: c.theme, view: o.view, document: o.document, viewport: o.viewport, offenders: o.offenders })));
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify({ phase: fixture.phase, passed: !violations.some(v => v.width < 720), cases, violations, desktopComparison }, null, 2));
  if (fixture.phase === 'before') assert(violations.length, 'Expected a real overflow reproduction');
  else assert.equal(violations.filter(v => v.width < 720).length, 0, JSON.stringify(violations));
  console.log(JSON.stringify({ passed: true, phase: fixture.phase, violations: violations.length }));
} finally { await browser.close(); }
