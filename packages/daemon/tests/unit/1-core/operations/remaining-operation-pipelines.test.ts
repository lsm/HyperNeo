import { describe, expect, test, vi } from 'vitest';
import { createConnectionList } from '../../../../src/lib/connections/list-operation';
import {
  createDaemonExtensionsOperation,
  type DaemonExtensions,
} from '../../../../src/lib/extensions/contract';
import { createCodingHumanMergeOperation } from '../../../../src/lib/neo/packs/coding/human-merge-operation';
import {
  createNeoReorganizeOperation,
  type NeoReorganizeRuntime,
} from '../../../../src/lib/neo/reorganize-operation';
import { createSendSessionMessageOperation } from '../../../../src/lib/messaging/session-message-send';

const entered = vi.hoisted(() => [] as string[]);
vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const fail = () => {
  throw new Error('store unavailable');
};
const operations = [
  createConnectionList(fail),
  createDaemonExtensionsOperation({ manifest: fail } as unknown as DaemonExtensions),
  createCodingHumanMergeOperation(),
  createNeoReorganizeOperation({ getBinding: fail } as unknown as NeoReorganizeRuntime),
  createSendSessionMessageOperation({ getSessionRow: fail, getLiveSession: fail }),
];

describe('remaining operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters its named pipeline',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve()
        .then(() =>
          operation.execute(
            {
              url: 'https://github.com/example/example/pull/1',
              enabled: true,
              spaceId: 'missing',
              sessionId: 'missing',
              message: 'hello',
            },
            { source: 'mcp', sessionId: 'missing' }
          )
        )
        .catch(() => undefined);
      expect(entered).toContain(operation.name);
    }
  );
});
