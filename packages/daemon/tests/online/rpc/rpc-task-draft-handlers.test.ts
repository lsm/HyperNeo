import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Task Draft RPC Handlers', () => {
  let daemon: DaemonServerContext;

  beforeAll(async () => {
    daemon = await createDaemonServer();
  }, 15_000);

  afterAll(async () => {
    await daemon?.waitForExit();
  }, 15_000);

  test('legacy task draft RPC is not registered', async () => {
    await expect(
      daemon.messageHub.request('task.updateDraft', {
        roomId: 'legacy-room-id',
        taskId: 'legacy-task-id',
        draft: 'retired surface',
      })
    ).rejects.toThrow('No handler for method: task.updateDraft');
  });

  test('legacy task read/write RPCs are not registered', async () => {
    for (const method of ['task.create', 'task.get', 'task.list']) {
      await expect(
        daemon.messageHub.request(method, {
          roomId: 'legacy-room-id',
          taskId: 'legacy-task-id',
          title: 'retired surface',
        })
      ).rejects.toThrow(`No handler for method: ${method}`);
    }
  });

  test('legacy inbox compatibility RPCs are not registered', async () => {
    for (const method of ['inbox.reviewTasks', 'task.approve', 'task.reject']) {
      await expect(daemon.messageHub.request(method, {})).rejects.toThrow(
        `No handler for method: ${method}`
      );
    }
  });
});
