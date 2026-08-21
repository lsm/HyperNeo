import { expect, type Page, type Locator } from '@playwright/test';
import { CHAT_INPUT_SELECTOR } from './selectors';

export async function waitForWebSocketConnected(page: Page, timeout?: number): Promise<void> {
  const isCI = process.env.CI === 'true';
  const effectiveTimeout = timeout ?? (isCI ? 60000 : 10000);

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
    console.error('WebSocket connection failed. Diagnostic info:', diagnostic);
    throw error;
  }
}

export async function waitForWebSocketConnectedMobile(page: Page): Promise<void> {
  await waitForWebSocketConnected(page, 30000);
}

export async function getWorkspaceRoot(page: Page): Promise<string> {
  const workspaceRoot = await page.evaluate(async () => {
    const hub = window.__messageHub || window.appState?.messageHub;
    if (!hub || !hub.request) {
      throw new Error('MessageHub not available');
    }

    const systemState = await hub.request('state.system', {});
    return (systemState as { workspaceRoot: string }).workspaceRoot;
  });

  if (!workspaceRoot) {
    throw new Error('Workspace root not found in system state');
  }

  return workspaceRoot;
}

export async function createSessionViaUI(page: Page): Promise<string> {
  await waitForWebSocketConnected(page);

  const workspaceRoot = await getWorkspaceRoot(page);

  const sessionId = await page.evaluate(async (workspacePath) => {
    const hub = window.__messageHub || window.appState?.messageHub;
    if (!hub || !hub.request) {
      throw new Error('MessageHub not available');
    }

    const response = await hub.request('session.create', {
      workspacePath,
      createdBy: 'human',
    });
    return (response as { sessionId: string }).sessionId;
  }, workspaceRoot);

  if (!sessionId) {
    throw new Error('Failed to create session');
  }

  await page.goto(`/session/${sessionId}`);

  return await waitForSessionCreated(page);
}

export async function waitForSessionCreated(page: Page): Promise<string> {
  await page.waitForTimeout(1500);

  await page.waitForFunction(
    () => !document.querySelector('h2')?.textContent?.includes('Neo Lobby'),
    { timeout: 10000 }
  );

  const messageInput = page.locator(CHAT_INPUT_SELECTOR).first();
  await expect(messageInput).toBeVisible({ timeout: 15000 });
  await expect(messageInput).toBeEnabled({ timeout: 5000 });

  const sessionId = await page.evaluate(() => {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const pathId = pathParts[0] === 'session' ? pathParts[1] : pathParts[0];
    if (pathId && pathId !== 'undefined' && pathId !== 'null') return pathId;

    const currentSessionId = window.currentSessionIdSignal?.value;
    if (currentSessionId) return currentSessionId;

    const sessionStoreId = window.sessionStore?.activeSessionId?.value;
    if (sessionStoreId) return sessionStoreId;

    const localStorageId = localStorage.getItem('currentSessionId');
    if (localStorageId) return localStorageId;

    const sessions = window.globalStore?.sessions?.value || [];
    const latestSession = sessions[sessions.length - 1] as { id?: string } | undefined;
    if (latestSession?.id) return latestSession.id;

    return null;
  });

  if (!sessionId) {
    throw new Error('Session ID not found after creation');
  }

  return sessionId;
}

export async function waitForMessageSent(page: Page, messageText: string): Promise<void> {
  await page
    .locator('[data-message-role="user"]')
    .filter({ hasText: messageText })
    .first()
    .waitFor({
      state: 'visible',
      timeout: 10000,
    });
}

export async function waitForAssistantResponse(
  page: Page,
  options: { containsText?: string; timeout?: number } = {}
): Promise<void> {
  const timeout = options.timeout || 90000;

  const initialCount = await page.locator('[data-message-role="assistant"]').count();

  await page.waitForFunction(
    (expectedCount) => {
      const messages = document.querySelectorAll('[data-message-role="assistant"]');
      return messages.length > expectedCount;
    },
    initialCount,
    { timeout }
  );

  if (options.containsText) {
    const lastAssistant = page.locator('[data-message-role="assistant"]').last();
    await expect(lastAssistant).toContainText(options.containsText, {
      timeout: 10000,
    });
  }

  const messageInput = page.locator(CHAT_INPUT_SELECTOR).first();
  await expect(messageInput).toBeEnabled({ timeout: 20000 });
}

export async function waitForMessageProcessed(page: Page, messageText: string): Promise<void> {
  await waitForMessageSent(page, messageText);
  await waitForAssistantResponse(page);
}

export async function waitForSDKSystemInitMessage(
  page: Page,
  timeout: number = 10000
): Promise<void> {
  await page.locator('button[title="Session info"]').last().waitFor({ state: 'visible', timeout });
}

export function getModal(page: Page): Locator {
  return page.locator('[role="dialog"]');
}

export async function waitForElement(
  page: Page,
  selector: string,
  options: {
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
    timeout?: number;
  } = {}
): Promise<Locator> {
  const element = page.locator(selector).first();
  await element.waitFor({
    state: options.state || 'visible',
    timeout: options.timeout || 10000,
  });
  return element;
}

export async function setupMessageHubTesting(page: Page): Promise<void> {
  await page.goto('/');

  await waitForWebSocketConnected(page);
}

export async function cleanupTestSession(page: Page, sessionId: string): Promise<void> {
  if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
    return;
  }

  try {
    const result = await page.evaluate(async (sid) => {
      try {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub || !hub.request) {
          return { success: false, error: 'MessageHub not available' };
        }

        await hub.request('session.delete', { sessionId: sid }, { timeout: 10000 });
        return { success: true, error: undefined };
      } catch (error: unknown) {
        return {
          success: false,
          error: (error as Error)?.message || String(error),
        };
      }
    }, sessionId);

    if (result.success) {
      try {
        await page.waitForTimeout(500);
        if (page.url().includes(sessionId)) {
          await page.goto('/').catch(() => {});
          await page.waitForTimeout(300);
        }
      } catch {}
    } else {
      console.warn(`⚠️  Failed to cleanup session ${sessionId}: ${result.error}`);
    }
  } catch (error) {
    console.warn(`⚠️  Cleanup error for session ${sessionId}:`, (error as Error).message || error);
  }
}
