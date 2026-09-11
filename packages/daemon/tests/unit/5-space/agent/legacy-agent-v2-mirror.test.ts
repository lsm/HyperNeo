import { describe, expect, test } from 'bun:test';
import type { SpaceAgent } from '@hyperneo/shared';
import { publishSpaceAgentV2Mirror } from '../../../../src/lib/space/agents/unified-agent-events';

function makeBus() {
  const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const bus = {
    publish: async (topic: string, payload: Record<string, unknown>) => {
      published.push({ topic, payload });
    },
  };
  return { bus, published };
}

const agent = { id: 'a1', spaceId: 'space-1', handle: 'alpha' } as SpaceAgent;
const owned = { getOwnedById: (id: string) => (id === 'a1' ? agent : null) };

type Bus = Parameters<typeof publishSpaceAgentV2Mirror>[0];

describe('publishSpaceAgentV2Mirror', () => {
  test('mirrors a created agent onto the v2 topic', async () => {
    const { bus, published } = makeBus();
    await publishSpaceAgentV2Mirror(bus as unknown as Bus, owned, 'space-1', 'a1', 'created');
    expect(published).toEqual([
      {
        topic: 'spaceAgentV2.created',
        payload: { sessionId: 'space:space-1', spaceId: 'space-1', agent },
      },
    ]);
  });

  test('mirrors an updated agent', async () => {
    const { bus, published } = makeBus();
    await publishSpaceAgentV2Mirror(bus as unknown as Bus, owned, 'space-1', 'a1', 'updated');
    expect(published[0]?.topic).toBe('spaceAgentV2.updated');
  });

  test('mirrors a delete without needing the row', async () => {
    const { bus, published } = makeBus();
    await publishSpaceAgentV2Mirror(bus as unknown as Bus, owned, 'space-1', 'gone', 'deleted');
    expect(published).toEqual([
      {
        topic: 'spaceAgentV2.deleted',
        payload: { sessionId: 'space:space-1', spaceId: 'space-1', agentId: 'gone' },
      },
    ]);
  });

  test('publishes nothing for a row the v2 view does not own', async () => {
    const { bus, published } = makeBus();
    await publishSpaceAgentV2Mirror(bus as unknown as Bus, owned, 'space-1', 'mirror', 'created');
    expect(published).toEqual([]);
  });

  test('publishes nothing when no lookup is supplied', async () => {
    const { bus, published } = makeBus();
    await publishSpaceAgentV2Mirror(bus as unknown as Bus, undefined, 'space-1', 'a1', 'created');
    expect(published).toEqual([]);
  });
});
