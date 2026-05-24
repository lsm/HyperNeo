/**
 * Interruption and Error Handling Test Helpers
 *
 * Shared utility functions for interruption and error handling E2E tests.
 * Extracted from interruption-error.e2e.ts for reusability.
 */

import type { Page } from '../fixtures';
import { closeWebSocket, restoreWebSocket } from './connection-helpers';

/**
 * Simulate network failure by closing WebSocket connection
 */
export async function simulateNetworkFailure(page: Page): Promise<void> {
  await closeWebSocket(page);
}

/**
 * Restore network by allowing WebSocket to reconnect
 */
export async function restoreNetwork(page: Page): Promise<void> {
  await restoreWebSocket(page);
}
