import { expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import {
  WorkRefSchema,
  WorkSummarySchema,
  type WorkSummary,
} from '../../../../src/lib/drivers/types.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

test.each([
  {
    links: { remoteLink: 'https://claude.ai/code/synthetic-bridge' },
    expected: 'https://claude.ai/code/synthetic-bridge',
  },
  {
    links: { link: 'javascript:refused', remoteLink: 'https://claude.ai/code/synthetic-bridge' },
    expected: 'https://claude.ai/code/synthetic-bridge',
  },
  {
    links: {
      link: 'claude://local/synthetic-worker',
      remoteLink: 'https://claude.ai/code/synthetic-bridge',
    },
    expected: 'claude://local/synthetic-worker',
  },
  { links: { remoteLink: 'javascript:refused' }, expected: null },
  { links: {}, expected: null },
])('question source retains a usable safe link: $expected', async ({ links, expected }) => {
  const db = await createTestDb();
  const ref = { adapter: 'claude-desktop', id: 'synthetic-worker' };
  const summary: WorkSummary = {
    ref,
    title: 'Review worker',
    place: { machine: 'local', name: 'Synthetic' },
    status: 'stopped',
    lastActivityAt: 1,
    ...links,
  };
  const registry = createOperationRegistry([
    defineOperation({
      name: 'work.status',
      description: 'Synthetic status',
      inputSchema: z.object({ ref: WorkRefSchema }),
      resultSchema: z.object({ ok: z.literal(true), value: WorkSummarySchema }),
      policy: { safetyClass: 'read' },
      execute: async () => ({ ok: true as const, value: summary }),
    }),
  ]);
  const service = createNeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  try {
    expect(await service.readQuestionSource(ref)).toMatchObject({
      ...ref,
      name: 'Review worker',
      provider: 'Claude',
      link: expected,
    });
  } finally {
    service.dispose();
    db.close();
  }
});
