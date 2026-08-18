import { test as base, type Page } from '@playwright/test';

const sessionsToCleanup = new Set<string>();

export function trackSession(sessionId: string): void {
  if (sessionId && sessionId !== 'undefined' && sessionId !== 'null') {
    sessionsToCleanup.add(sessionId);
  }
}

export function untrackSession(sessionId: string): void {
  sessionsToCleanup.delete(sessionId);
}

export function getTrackedSessions(): string[] {
  return Array.from(sessionsToCleanup);
}

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

export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
  },
});

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

export { expect } from '@playwright/test';
