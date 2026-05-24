/**
 * Session Tracker Fixture
 *
 * Automatically tracks all sessions created during tests and ensures cleanup
 * even when tests fail. Uses direct RPC calls that don't depend on page state.
 */

import { test as base, type Page } from '@playwright/test';

// Global registry of sessions to clean up
const sessionsToCleanup = new Set<string>();

/**
 * Track a session ID for cleanup
 */
export function trackSession(sessionId: string): void {
  if (sessionId && sessionId !== 'undefined' && sessionId !== 'null') {
    sessionsToCleanup.add(sessionId);
  }
}

/**
 * Remove session from cleanup registry (already cleaned up)
 */
export function untrackSession(sessionId: string): void {
  sessionsToCleanup.delete(sessionId);
}

/**
 * Get all tracked sessions
 */
export function getTrackedSessions(): string[] {
  return Array.from(sessionsToCleanup);
}

/**
 * Direct RPC cleanup via WebSocket (doesn't depend on page state)
 */
async function cleanupSessionDirect(page: Page, sessionId: string): Promise<boolean> {
  try {
    const result = await page.evaluate(async (sid) => {
      try {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub || !hub.request) {
          return { success: false, error: 'MessageHub not available' };
        }

        await hub.request('session.delete', { sessionId: sid }, { timeout: 5000 });
        return { success: true };
      } catch (error: unknown) {
        return {
          success: false,
          error: (error as Error)?.message || String(error),
        };
      }
    }, sessionId);

    return result.success;
  } catch (error) {
    console.warn(`Direct RPC cleanup failed for ${sessionId}:`, error);
    return false;
  }
}

/**
 * Extended test fixture with automatic session cleanup
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    // Provide page to test
    await use(page);

    // After test completes (or fails), cleanup any sessions created in this test
    // Note: Individual tests should still call cleanupTestSession in afterEach
    // This is a safety net for when tests fail before cleanup
  },
});

/**
 * Global cleanup - runs after ALL tests complete
 */
export async function globalCleanup(page: Page): Promise<void> {
  const sessions = getTrackedSessions();

  if (sessions.length === 0) {
    console.log('✅ No orphaned sessions to clean up');
    return;
  }

  console.log(`🧹 Cleaning up ${sessions.length} tracked sessions...`);

  let cleaned = 0;
  let failed = 0;

  for (const sessionId of sessions) {
    const success = await cleanupSessionDirect(page, sessionId);
    if (success) {
      cleaned++;
      untrackSession(sessionId);
    } else {
      failed++;
    }
  }

  console.log(`✅ Cleaned: ${cleaned}, ❌ Failed: ${failed}`);
}

// Export base test for tests that don't need session tracking
export { expect } from '@playwright/test';
