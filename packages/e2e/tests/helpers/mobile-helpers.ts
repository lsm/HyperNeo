/**
 * Mobile-specific test helpers for sidebar/panel interactions.
 *
 * These replace fragile waitForTimeout-based sidebar toggling with
 * event-based waits that detect panel open/close via DOM state.
 */

import { expect, type Page } from '@playwright/test';

/** Locator for the mobile menu (hamburger) button that opens the context panel. */
const openMenuButton = (page: Page) => page.locator('button[aria-label="Open navigation menu"]');

/** Locator for the close button inside the context panel (mobile only). */
const closePanelButton = (page: Page) => page.locator('button[title="Close panel"]');

/**
 * Check whether the mobile context panel is currently open.
 *
 * Uses boundingBox() instead of isVisible() because the panel uses CSS
 * translate-x for show/hide — translated-off elements are still "visible"
 * per Playwright but are outside the viewport.
 */
async function isPanelOpen(page: Page): Promise<boolean> {
  const box = await closePanelButton(page)
    .boundingBox()
    .catch(() => null);
  if (!box) return false;
  // When the panel is open, the close button is within the viewport (x >= 0).
  // When closed via -translate-x-full, the button is off-screen (x < -200).
  return box.x >= 0;
}

/**
 * Open the mobile context panel (sidebar/drawer) and wait for it to be ready.
 * If already open, this is a no-op.
 */
export async function openMobilePanel(page: Page): Promise<void> {
  if (await isPanelOpen(page)) {
    return;
  }

  await openMenuButton(page).click();

  // Wait for close button to be in viewport — confirms panel finished its open animation
  await expect(closePanelButton(page)).toBeInViewport({ timeout: 5000 });
}

/**
 * Close the mobile context panel (sidebar/drawer) and wait for it to finish.
 * If already closed, this is a no-op.
 */
export async function closeMobilePanel(page: Page): Promise<void> {
  if (!(await isPanelOpen(page))) {
    return;
  }

  // Use force: true because the BottomTabBar (z-50) overlaps the panel (z-40)
  // on mobile, causing Playwright's actionability check to report click interception.
  // Use .first() for robustness in case multiple elements match the selector.
  await closePanelButton(page).first().click({ force: true, timeout: 5000 });

  // Wait for close button to leave the viewport — confirms panel finished closing
  const closeBtn = closePanelButton(page);
  await expect(closeBtn).not.toBeInViewport({ timeout: 5000 });
}
