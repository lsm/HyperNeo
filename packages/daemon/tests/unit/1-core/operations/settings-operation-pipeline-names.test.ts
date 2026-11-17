import { describe, expect, test, vi } from 'vitest';
import {
  createDefaultModelOperations,
  createProviderUsageOperations,
} from '../../../../src/lib/rpc-handlers/family-operations/settings';

const entered = vi.hoisted(() => [] as string[]);

vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const fail = () => {
  throw new Error('store unavailable');
};
const operations = [
  ...createDefaultModelOperations({ read: fail, write: fail, models: fail }),
  ...createProviderUsageOperations({ provider: fail }),
];

describe('settings operations', () => {
  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters its pipeline when the store fails',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve()
        .then(() =>
          operation.execute({ model: 'missing', providerId: 'missing' }, { source: 'rpc' })
        )
        .catch(() => undefined);
      expect(entered).toEqual([operation.name]);
    }
  );
});
