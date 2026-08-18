import type { Page } from '../fixtures';
import { closeWebSocket, restoreWebSocket } from './connection-helpers';

export async function simulateNetworkFailure(page: Page): Promise<void> {
  await closeWebSocket(page);
}

export async function restoreNetwork(page: Page): Promise<void> {
  await restoreWebSocket(page);
}
