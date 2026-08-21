import { expect, type Page } from '@playwright/test';

export async function closeWebSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const cm = (window as any).connectionManager;
    if (cm?.simulatePermanentDisconnect) {
      cm.simulatePermanentDisconnect();
    }
  });

  await page.waitForTimeout(200);
}

export async function restoreWebSocket(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const cm = (window as any).connectionManager;
    if (cm?.reconnect) {
      await cm.reconnect();
    }
  });
}

export async function waitForOfflineStatus(page: Page, timeout: number = 5000): Promise<void> {
  await expect(page.locator('button[aria-label="Daemon: Offline"]').first()).toBeVisible({
    timeout,
  });
}

export async function waitForOnlineStatus(page: Page, timeout?: number): Promise<void> {
  const isCI = process.env.CI === 'true';
  const effectiveTimeout = timeout ?? (isCI ? 60000 : 10000);

  const offlineIndicator = page.locator('button[aria-label="Daemon: Offline"]').first();
  const wasVisible = await offlineIndicator.isVisible().catch(() => false);

  if (wasVisible) {
    await expect(offlineIndicator)
      .toBeHidden({ timeout: 2000 })
      .catch(() => {});
  }

  try {
    await page.waitForFunction(
      () => {
        const hub = window.__messageHub || window.appState?.messageHub;
        return hub?.getState && hub.getState() === 'connected';
      },
      { timeout: effectiveTimeout }
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const hub = window.__messageHub || window.appState?.messageHub;
      return {
        hasHub: !!hub,
        hubType: hub?.constructor?.name,
        state: hub?.getState?.(),
        hasWindowMessageHub: !!window.__messageHub,
        windowMessageHubReady: window.__messageHubReady,
        hasConnectionManager: !!(window as any).connectionManager,
        connectionManagerState: (window as any).connectionManager?.getConnectionState?.(),
        hasAppState: !!window.appState,
        connectionState: (window as any).connectionState?.value,
        locationHref: window.location.href,
      };
    });
    console.error('WebSocket reconnection failed. Diagnostic info:', diagnostic);
    throw error;
  }
}
