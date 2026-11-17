import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createSessionInspectionOperation } from '../../../../src/lib/inventory/session-inspection';
import { createDaemonSnapshotOperation } from '../../../../src/lib/inventory/snapshot-operation';
import { createAttachDaemonOperation } from '../../../../src/lib/remote-daemons/attach-operation';
import {
  createDetachDaemonOperation,
  createListDaemonsOperation,
  createProbeDaemonOperation,
} from '../../../../src/lib/remote-daemons/manage-operations';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const caller: OperationCaller = { source: 'rpc', principal: 'local' };
const operations = [
  createSessionInspectionOperation({} as never),
  createDaemonSnapshotOperation({} as never),
  createAttachDaemonOperation({} as never),
  createListDaemonsOperation({} as never),
  createDetachDaemonOperation({} as never),
  createProbeDaemonOperation({} as never),
];

describe('daemon operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(
        operation.execute(
          {
            sessionId: 'missing',
            daemonId: 'missing',
            url: 'ws://127.0.0.1:1/ws',
            limit: 1,
          } as never,
          caller
        )
      ).catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
    }
  );
});
