/**
 * Event-based wait helpers to replace arbitrary timeouts
 *
 * These helpers wait for specific conditions or events instead of fixed timeouts,
 * making tests more reliable and faster.
 *
 * NOTE: Window augmentation for test types is in packages/e2e/global.d.ts
 * The global Window interface is extended there with test-specific properties.
 */

import { expect, type Page, type Locator } from '@playwright/test';
import { CHAT_INPUT_SELECTOR } from './selectors';

/**
 * Wait for WebSocket connection to be established
 * @param page - Playwright page
 * @param timeout - Optional timeout in ms (default 60000 for CI, 10000 for local)
 */
export async function waitForWebSocketConnected(page: Page, timeout?: number): Promise<void> {
  // Use longer timeout in CI (60s) vs local (10s) since CI environments
  // can be slower to establish WebSocket connections
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
    // Log diagnostic information to help debug connection failures
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

/**
 * Wait for WebSocket connection with a longer timeout for mobile CI environments.
 *
 * Mobile viewports may take longer to initialize due to:
 * - Different rendering behavior on mobile browsers
 * - Additional hydration/rendering steps for responsive layouts
 * - Potential CSS/JS loading differences
 *
 * Uses 30s timeout for better reliability in CI.
 */
export async function waitForWebSocketConnectedMobile(page: Page): Promise<void> {
  await waitForWebSocketConnected(page, 30000);
}

/**
 * Get the workspace root path from the system state
 */
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

/**
 * Create a new session through the UI modal
 * This helper uses RPC directly to create sessions for reliability,
 * then navigates to the session via URL.
 */
export async function createSessionViaUI(page: Page): Promise<string> {
  // Ensure WebSocket is connected before making RPC calls
  await waitForWebSocketConnected(page);

  // Get the workspace root path
  const workspaceRoot = await getWorkspaceRoot(page);

  // Create session via RPC (more reliable than UI modal)
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

  // Navigate to the session using the correct path format
  await page.goto(`/session/${sessionId}`);

  // Wait for session to be loaded
  return await waitForSessionCreated(page);
}

/**
 * Wait for session to be created and loaded
 */
export async function waitForSessionCreated(page: Page): Promise<string> {
  // Wait for session to be created and loaded
  await page.waitForTimeout(1500);

  // Verify we're NOT on the lobby/home screen
  await page.waitForFunction(
    () => !document.querySelector('h2')?.textContent?.includes('Neo Lobby'),
    { timeout: 10000 }
  );

  // Verify we're in a chat view (message input should be visible).
  // Uses CHAT_INPUT_SELECTOR to match the standalone session textarea.
  const messageInput = page.locator(CHAT_INPUT_SELECTOR).first();
  await expect(messageInput).toBeVisible({ timeout: 15000 });
  await expect(messageInput).toBeEnabled({ timeout: 5000 });

  // Get and return the session ID - try multiple methods for robustness
  const sessionId = await page.evaluate(() => {
    // 1. From URL path (format: /{sessionId} or /session/{id})
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const pathId = pathParts[0] === 'session' ? pathParts[1] : pathParts[0];
    if (pathId && pathId !== 'undefined' && pathId !== 'null') return pathId;

    // 2. From currentSessionIdSignal (if exposed)
    const currentSessionId = window.currentSessionIdSignal?.value;
    if (currentSessionId) return currentSessionId;

    // 3. From sessionStore (if exposed)
    const sessionStoreId = window.sessionStore?.activeSessionId?.value;
    if (sessionStoreId) return sessionStoreId;

    // 4. From localStorage
    const localStorageId = localStorage.getItem('currentSessionId');
    if (localStorageId) return localStorageId;

    // 5. From latest session in globalStore sessions list
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

/**
 * Wait for user message to be sent
 */
export async function waitForMessageSent(page: Page, messageText: string): Promise<void> {
  // Wait for user message to appear in the chat area specifically
  // Scoping to [data-message-role="user"] avoids false positives from sidebar titles
  await page
    .locator('[data-message-role="user"]')
    .filter({ hasText: messageText })
    .first()
    .waitFor({
      state: 'visible',
      timeout: 10000,
    });
}

/**
 * Wait for new assistant response to appear
 * Uses simpler approach matching the passing chat-flow.e2e.ts pattern
 * @param options.containsText - Optional text that should be in the response
 * @param options.timeout - Custom timeout (default 90s for CI reliability)
 */
export async function waitForAssistantResponse(
  page: Page,
  options: { containsText?: string; timeout?: number } = {}
): Promise<void> {
  // Use longer timeout for CI reliability (90s default)
  // CI environments can be significantly slower due to xvfb, network latency,
  // and Claude API response times that can exceed 50s
  const timeout = options.timeout || 90000;

  // Count existing assistant messages before waiting
  const initialCount = await page.locator('[data-message-role="assistant"]').count();

  // Wait for a new assistant message to appear
  // Use waitForFunction for more reliable detection of new messages
  await page.waitForFunction(
    (expectedCount) => {
      const messages = document.querySelectorAll('[data-message-role="assistant"]');
      return messages.length > expectedCount;
    },
    initialCount,
    { timeout }
  );

  // If text matching is requested, verify it
  if (options.containsText) {
    const lastAssistant = page.locator('[data-message-role="assistant"]').last();
    await expect(lastAssistant).toContainText(options.containsText, {
      timeout: 10000,
    });
  }

  // Wait for input to be enabled again (processing complete)
  // Uses CHAT_INPUT_SELECTOR to match the standalone session textarea.
  const messageInput = page.locator(CHAT_INPUT_SELECTOR).first();
  await expect(messageInput).toBeEnabled({ timeout: 20000 });
}

/**
 * Wait for message to be sent and get a response
 * Convenience wrapper around waitForMessageSent + waitForAssistantResponse
 */
export async function waitForMessageProcessed(page: Page, messageText: string): Promise<void> {
  await waitForMessageSent(page, messageText);
  await waitForAssistantResponse(page);
}

/**
 * Wait for SDK system:init message to be received
 * This indicates the SDK has accepted the message and started processing
 *
 * Uses UI element: the "Session info" button (circle with "i" icon) that appears
 * next to the user message when system:init is received.
 *
 * Use this instead of arbitrary timeouts to ensure proper synchronization
 */
export async function waitForSDKSystemInitMessage(
  page: Page,
  timeout: number = 10000
): Promise<void> {
  // Wait for the "Session info" button to appear - this indicates system:init was received
  // The button appears next to the user message when sessionInfo is attached
  // Use locator.waitFor() for better retry logic with async signal-based rendering
  // Use .last() to wait for the most recent button (handles multiple messages)
  await page.locator('button[title="Session info"]').last().waitFor({ state: 'visible', timeout });
}

/**
 * Returns a Locator for modal dialogs.
 *
 * Use this instead of repeating `page.locator('[role="dialog"]')` whenever you
 * need to target an application modal dialog.
 */
export function getModal(page: Page): Locator {
  return page.locator('[role="dialog"]');
}

/**
 * Wait for UI element with retry logic
 */
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

/**
 * Setup page for testing - navigate to home and wait for connection
 */
export async function setupMessageHubTesting(page: Page): Promise<void> {
  // Navigate to home page
  await page.goto('/');

  // Wait for WebSocket connection
  await waitForWebSocketConnected(page);
}

/**
 * Helper to clean up after tests
 * IMPORTANT: E2E tests must test the actual UI, not bypass it
 *
 * For parallel execution, this helper uses RPC as primary method for reliability.
 * ALWAYS uses RPC cleanup - UI cleanup is completely removed for better reliability.
 */
export async function cleanupTestSession(page: Page, sessionId: string): Promise<void> {
  if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
    return; // Nothing to clean up
  }

  try {
    // Use MessageHub RPC for reliable cleanup (works even if page is in bad state)
    // Generous timeout: manual deletion takes ~3ms, but may take longer during agent processing
    const result = await page.evaluate(async (sid) => {
      try {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub || !hub.request) {
          return { success: false, error: 'MessageHub not available' };
        }

        // 10s timeout - if it takes longer, something is likely stuck/deadlocked
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
      // Successfully deleted via RPC
      // Navigate home if we're still on the deleted session
      try {
        await page.waitForTimeout(500);
        if (page.url().includes(sessionId)) {
          await page.goto('/').catch(() => {}); // Ignore navigation errors
          await page.waitForTimeout(300);
        }
      } catch {
        // Ignore navigation errors
      }
    } else {
      // RPC deletion failed after retries, log warning but don't throw
      console.warn(`⚠️  Failed to cleanup session ${sessionId}: ${result.error}`);
    }
  } catch (error) {
    // page.evaluate itself failed (page might be closed/crashed)
    console.warn(`⚠️  Cleanup error for session ${sessionId}:`, (error as Error).message || error);
  }

  // Never throw errors from cleanup - just log warnings
}
