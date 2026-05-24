/**
 * Legacy Room task lifecycle RPC retirement tests.
 *
 * The Room task lifecycle is no longer an active product surface. The legacy
 * handlers remain in source only for preserved-data compatibility work and are
 * intentionally not registered on the daemon MessageHub.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Task Lifecycle RPC Integration', () => {
  let daemon: DaemonServerContext;

  beforeAll(async () => {
    daemon = await createDaemonServer();
  }, 20_000);

  afterAll(async () => {
    await daemon?.waitForExit();
  }, 15_000);

  test('legacy task lifecycle RPCs are not registered', async () => {
    for (const method of [
      'task.create',
      'task.get',
      'task.list',
      'task.setStatus',
      'task.archive',
      'task.fail',
      'task.sendHumanMessage',
    ]) {
      await expect(
        daemon.messageHub.request(method, {
          roomId: 'legacy-room-id',
          taskId: 'legacy-task-id',
          title: 'retired surface',
          status: 'completed',
        })
      ).rejects.toThrow(`No handler for method: ${method}`);
    }
  });
});
