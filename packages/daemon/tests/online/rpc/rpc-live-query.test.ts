import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { LiveQuerySnapshotEvent } from '@hyperneo/shared';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

const SNAPSHOT_WAIT_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 50;

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = SNAPSHOT_WAIT_TIMEOUT_MS,
  label = 'condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

describe('LiveQuery RPC handlers', () => {
  let daemon: DaemonServerContext;

  beforeAll(async () => {
    daemon = await createDaemonServer();
  }, 30_000);

  afterAll(async () => {
    await daemon?.waitForExit();
  }, 15_000);

  test('active live queries still deliver an initial snapshot', async () => {
    const snapshots: LiveQuerySnapshotEvent[] = [];
    const subscriptionId = `sub-mcp-global-${Date.now()}`;
    const unsubscribeEvent = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
      'liveQuery.snapshot',
      (ev) => {
        if (ev.subscriptionId === subscriptionId) snapshots.push(ev);
      }
    );

    try {
      const result = (await daemon.messageHub.request('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId,
      })) as { ok: boolean };

      expect(result.ok).toBe(true);
      await waitFor(() => snapshots.length > 0, SNAPSHOT_WAIT_TIMEOUT_MS, 'snapshot arrival');
      expect(snapshots[0].subscriptionId).toBe(subscriptionId);
      expect(Array.isArray(snapshots[0].rows)).toBe(true);
      expect(typeof snapshots[0].version).toBe('number');
    } finally {
      unsubscribeEvent();
      await daemon.messageHub.request('liveQuery.unsubscribe', { subscriptionId });
    }
  }, 20_000);

  test('retired Room live-query names are not registered', async () => {
    for (const queryName of [
      'tasks.byRoom',
      'tasks.byRoom.all',
      'goals.byRoom',
      'mcpEnablement.byRoom',
      'skills.byRoom',
    ]) {
      await expect(
        daemon.messageHub.request('liveQuery.subscribe', {
          queryName,
          params: ['legacy-room-id'],
          subscriptionId: `legacy-${queryName}`,
        })
      ).rejects.toThrow(`Unknown query name: "${queryName}"`);
    }
  });
});
