import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  NeoGithubQuery,
  planNeoGithubQuery,
  presentNeoGithubQuery,
} from '../../../../src/lib/neo/packs/coding/github-query.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { operationSignature } from '../../../../src/lib/operations/discovery.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { z } from 'zod';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

const since = '2026-10-15T10:00:00Z';
const until = '2026-10-15T12:00:00Z';
const pr = (number: number, mergedAt: string | null) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/lsm/HyperNeo/pull/${number}`,
  state: mergedAt ? 'MERGED' : 'OPEN',
  createdAt: '2026-10-15T09:00:00Z',
  updatedAt: mergedAt ?? '2026-10-15T09:00:00Z',
  mergedAt,
  closedAt: mergedAt,
});

describe('planNeoGithubQuery', () => {
  test('lists merged pull requests in a window by their merge time', () => {
    const plan = planNeoGithubQuery(
      NeoGithubQuery.parse({ repo: 'lsm/HyperNeo', state: 'merged', since, until, limit: 20 })
    );
    expect(plan).toMatchObject({
      value: {
        by: 'merged',
        search: `merged:${since}..${until}`,
        args: [
          'gh',
          'pr',
          'list',
          '--repo',
          'lsm/HyperNeo',
          '--state',
          'merged',
          '--limit',
          '21',
          '--json',
          'number,title,url,state,createdAt,updatedAt,mergedAt,closedAt',
          '--search',
          `merged:${since}..${until}`,
        ],
      },
    });
  });

  test('turns "the last N hours" into a window that ends now, and refuses mixing it with dates', () => {
    const now = Date.parse('2026-10-15T03:55:00Z');
    expect(
      planNeoGithubQuery(
        NeoGithubQuery.parse({ repo: 'lsm/neo-ios', state: 'merged', withinHours: 6 }),
        now
      )
    ).toMatchObject({
      value: {
        query: { since: '2026-10-14T21:55:00.000Z' },
        search: 'merged:>=2026-10-14T21:55:00.000Z',
      },
    });
    expect(
      planNeoGithubQuery(NeoGithubQuery.parse({ repo: 'o/r', withinHours: 6, since }), now)
    ).toMatchObject({ reason: { ok: false, reason: expect.stringContaining('one_window') } });
  });

  test('refuses a merged issue list and an inverted window', () => {
    expect(
      planNeoGithubQuery(NeoGithubQuery.parse({ repo: 'o/r', kind: 'issue', state: 'merged' }))
    ).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('issues_do_not_merge') },
    });
    expect(
      planNeoGithubQuery(NeoGithubQuery.parse({ repo: 'o/r', since: until, until: since }))
    ).toMatchObject({ reason: { ok: false, reason: expect.stringContaining('empty_window') } });
  });
});

describe('presentNeoGithubQuery', () => {
  const plan = planNeoGithubQuery(
    NeoGithubQuery.parse({ repo: 'lsm/HyperNeo', state: 'merged', since, limit: 2 })
  ) as { value: Parameters<typeof presentNeoGithubQuery>[0] };

  test('orders matches newest first, says when more matched than the limit, and reports the window up to the read', () => {
    const at = '2026-10-15T12:34:00.000Z';
    expect(
      presentNeoGithubQuery(plan.value, {
        data: [pr(1, '2026-10-15T10:05:00Z'), pr(3, '2026-10-15T11:30:00Z'), pr(2, since)],
        at,
      })
    ).toMatchObject({
      value: {
        ok: true,
        kind: 'list',
        items: [{ number: 3 }, { number: 1 }],
        truncated: true,
        window: { by: 'merged', since, until: at },
      },
    });
  });

  test('orders an updated-time list by when each item was last updated', () => {
    const updated = planNeoGithubQuery(
      NeoGithubQuery.parse({ repo: 'lsm/HyperNeo', by: 'updated', since, limit: 1 })
    ) as { value: Parameters<typeof presentNeoGithubQuery>[0] };
    expect(
      presentNeoGithubQuery(updated.value, {
        data: [
          { ...pr(1, null), updatedAt: '2026-10-15T11:59:00Z' },
          { ...pr(2, null), createdAt: '2026-10-15T09:30:00Z', updatedAt: since },
        ],
        at: until,
      })
    ).toMatchObject({ value: { items: [{ number: 1 }], truncated: true } });
  });

  test('reports an unreadable list instead of an empty one', () => {
    expect(presentNeoGithubQuery(plan.value, { data: null, at: until })).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('unreadable') },
    });
  });
});

describe('neo.github.read list form', () => {
  test("shows both forms' fields in Neo's operation signature", async () => {
    const db = await createTestDb();
    try {
      const service = new NeoService(
        db,
        { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
        { event: mock(() => {}) } as unknown as MessageHub,
        new InternalEventBus<DaemonInternalEventMap>()
      );
      const read = createOperationRegistry(createNeoOperations(service)).get('neo.github.read')!;
      const signature = operationSignature(read);
      for (const field of ['url?', 'repo?', 'state?', 'by?', 'since?', 'until?', 'limit?'])
        expect(signature).toContain(field);
    } finally {
      db.close();
    }
  });

  test('returns every pull request gh finds in the window, with merge times', async () => {
    const db = await createTestDb();
    try {
      const service = new NeoService(
        db,
        { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
        { event: mock(() => {}) } as unknown as MessageHub,
        new InternalEventBus<DaemonInternalEventMap>()
      );
      const merged = Array.from({ length: 12 }, (_, index) =>
        pr(
          6931 + index,
          `2026-10-15T1${index < 6 ? 0 : 1}:${String(index * 4).padStart(2, '0')}:00Z`
        )
      );
      const list = mock(async (_args: string[]) => ({
        data: merged,
        at: new Date().toISOString(),
      }));
      service.listGithub = list;
      const result = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.github.read',
        { repo: 'lsm/HyperNeo', state: 'merged', since, until },
        { source: 'rpc', principal: 'local' }
      );
      expect(list.mock.calls[0]?.[0]).toContain(`merged:${since}..${until}`);
      const open = mock(async (_args: string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { data: [pr(1, new Date().toISOString())], at: new Date().toISOString() };
      });
      service.listGithub = open;
      const latest = (await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.github.read',
        { repo: 'lsm/HyperNeo', state: 'merged', since },
        { source: 'rpc', principal: 'local' }
      )) as {
        value: { window: { until: string }; items: { mergedAt: string }[] };
      };
      expect(Date.parse(latest.value.window.until)).toBeGreaterThanOrEqual(
        Date.parse(latest.value.items[0]!.mergedAt)
      );
      expect(result).toMatchObject({
        value: { ok: true, kind: 'list', truncated: false, window: { by: 'merged', since, until } },
      });
      const items = (result as { value: { items: { number: number; mergedAt: string }[] } }).value
        .items;
      expect(items.map((item) => item.number).sort()).toEqual(merged.map((item) => item.number));
      expect(items[0]?.mergedAt).toBe(merged.at(-1)!.mergedAt);
    } finally {
      db.close();
    }
  });
});

describe('pack-owned Neo operation registration', () => {
  test('installed pack operations retain Neo admission before their implementation runs', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    let calls = 0;
    try {
      service.filePacks = [
        {
          id: 'synthetic-pack',
          describe: 'Synthetic operation owner',
          instructions: () => null,
          operations: [
            defineOperation({
              name: 'verify.pack.echo',
              description: 'Return synthetic input',
              inputSchema: z.object({ text: z.string() }),
              resultSchema: z.union([
                z.object({ ok: z.literal(true), text: z.string() }),
                z.object({ ok: z.literal(false), reason: z.string() }),
              ]),
              policy: { safetyClass: 'read', roles: ['neo'] },
              execute: async ({ text }) => {
                calls++;
                return { ok: true as const, text };
              },
            }),
          ],
        },
      ];
      const registry = createOperationRegistry(createNeoOperations(service));
      expect(registry.get('verify.pack.echo')).toBeDefined();
      expect(
        await invokeOperation(
          registry,
          'verify.pack.echo',
          { text: 'Synthetic bytes' },
          {
            source: 'mcp',
            sessionId: 'unbound-worker',
            role: 'neo',
          }
        )
      ).toMatchObject({ value: { ok: false, reason: 'This operation belongs to Neo.' } });
      expect(calls).toBe(0);
      expect(
        await invokeOperation(
          registry,
          'verify.pack.echo',
          { text: 'Synthetic bytes' },
          {
            source: 'rpc',
            principal: 'local',
          }
        )
      ).toMatchObject({ value: { ok: true, text: 'Synthetic bytes' } });
      expect(calls).toBe(1);
    } finally {
      service.dispose();
      db.close();
    }
  });

  test('disabling coding work guidance keeps the existing GitHub read operation available', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    try {
      db.updateGlobalSettings({ neo: { packs: [] } });
      expect(service.packs().some((pack) => pack.id === 'coding')).toBe(false);
      expect(
        createOperationRegistry(createNeoOperations(service)).get('neo.github.read')
      ).toBeDefined();
    } finally {
      service.dispose();
      db.close();
    }
  });
});
