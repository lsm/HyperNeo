import { expect, type Page } from '@playwright/test';

const openMenuButton = (page: Page) => page.locator('button[aria-label="Open navigation menu"]');

const closePanelButton = (page: Page) => page.locator('button[title="Close panel"]');

async function isPanelOpen(page: Page): Promise<boolean> {
  const box = await closePanelButton(page)
    .boundingBox()
    .catch(() => null);
  if (!box) return false;
  return box.x >= 0;
}

export async function openMobilePanel(page: Page): Promise<void> {
  if (await isPanelOpen(page)) {
    return;
  }

  await openMenuButton(page).click();

  await expect(closePanelButton(page)).toBeInViewport({ timeout: 5000 });
}

export async function closeMobilePanel(page: Page): Promise<void> {
  if (!(await isPanelOpen(page))) {
    return;
  }

  await closePanelButton(page).first().click({ force: true, timeout: 5000 });

  const closeBtn = closePanelButton(page);
  await expect(closeBtn).not.toBeInViewport({ timeout: 5000 });
}
