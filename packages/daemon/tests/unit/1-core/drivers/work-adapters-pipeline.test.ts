import { describe, expect, test, vi } from 'vitest';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';

const entered = vi.hoisted(() => [] as string[]);

vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

describe('work.adapters', () => {
  test('returns the adapter catalog through its named pipeline', async () => {
    const operation = createWorkVerbOperations({
      adapters: () => [],
      daemonName: 'local',
      remote: { list: () => [], invoke: async () => ({}) },
    }).find((entry) => entry.name === 'work.adapters');
    expect(operation).toBeDefined();
    entered.length = 0;
    expect(await operation?.execute({}, { source: 'rpc' })).toEqual({ ok: true, value: [] });
    expect(entered).toEqual(['work.adapters']);
  });
});
