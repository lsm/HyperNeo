import { test, expect } from '../../fixtures';

const IPAD_PORTRAIT = { width: 820, height: 1180 } as const;
const IPAD_MINI_PORTRAIT = { width: 744, height: 1133 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

test.describe('iPad portrait (820×1180)', () => {
  test.use({ viewport: IPAD_PORTRAIT, hasTouch: true, isMobile: false });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
  });

  test('root container uses h-safe-screen class', async ({ page }) => {
    const rootContainer = page.locator('.h-safe-screen').first();
    await expect(rootContainer).toBeAttached();
    const classes = await rootContainer.getAttribute('class');
    expect(classes).toContain('h-safe-screen');
  });

  test('header element is visible within the viewport bounds', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Neo Lobby' }).first();
    await expect(heading).toBeVisible();
    const box = await heading.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeGreaterThan(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(IPAD_PORTRAIT.height);
  });
});

test.describe('iPad Mini portrait (744×1133)', () => {
  test.use({ viewport: IPAD_MINI_PORTRAIT, hasTouch: true, isMobile: false });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
  });

  test('root container uses h-safe-screen class', async ({ page }) => {
    const rootContainer = page.locator('.h-safe-screen').first();
    await expect(rootContainer).toBeAttached();
    const classes = await rootContainer.getAttribute('class');
    expect(classes).toContain('h-safe-screen');
  });

  test('header element is visible within the viewport bounds', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Neo Lobby' }).first();
    await expect(heading).toBeVisible();
    const box = await heading.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeGreaterThan(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(IPAD_MINI_PORTRAIT.height);
  });

  test('bottom tab bar is visible at narrow width', async ({ page }) => {
    const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
    await expect(bottomTabBar).toBeVisible();
  });

  test('main content area is above bottom tab bar (BottomTabBar is inline)', async ({ page }) => {
    const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
    await expect(bottomTabBar).toBeVisible();

    const position = await bottomTabBar.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe('static');
  });
});

test.describe('Desktop (1280×800)', () => {
  test.use({ viewport: DESKTOP });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
  });

  test('root container uses h-safe-screen class', async ({ page }) => {
    const rootContainer = page.locator('.h-safe-screen').first();
    await expect(rootContainer).toBeAttached();
    const classes = await rootContainer.getAttribute('class');
    expect(classes).toContain('h-safe-screen');
  });

  test('bottom tab bar is hidden at desktop width', async ({ page }) => {
    const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
    await expect(bottomTabBar).not.toBeVisible();
  });

  test('main content area has no bottom padding (BottomTabBar is not present)', async ({
    page,
  }) => {
    const hasPbBottomBar = await page.evaluate(() => !!document.querySelector('.pb-bottom-bar'));
    expect(hasPbBottomBar).toBe(false);
  });
});
