import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../helpers/neo-service.ts';
import {
  NeoGithubQuery,
  planNeoGithubQuery,
} from '../../../../src/lib/neo/packs/coding/github-query.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
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

describe('pack-owned Neo operation registration', () => {
  test('installed pack operations retain Neo admission before their implementation runs', async () => {
    const db = await createTestDb();
    const service = createNeoService(
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
      db.updateGlobalSettings({ neo: { packs: ['synthetic-pack'] } });
      const pack = service.filePacks[0];
      const invalid = { ...pack.operations![0] };
      Reflect.set(invalid, 'pipelineRunner', async () => ({ ok: true }));
      service.filePacks = [{ ...pack, operations: [invalid] }];
      expect(() => createNeoOperations(service)).toThrow(
        'Invalid pack pipeline runner for verify.pack.echo'
      );
      service.filePacks = [pack];
      const registry = createOperationRegistry(createNeoOperations(service));
      const codingResult = service
        .installedPacks()
        .find((pack) => pack.id === 'coding')
        ?.operations?.find((operation) => operation.name === 'neo.coding.result');
      expect(codingResult && Reflect.has(codingResult, 'pipelineRunner')).toBe(true);
      const registeredResult = registry.get('neo.coding.result');
      expect(registeredResult && Reflect.has(registeredResult, 'pipelineRunner')).toBe(false);
      expect(
        await registeredResult!.execute(
          {},
          { source: 'mcp', sessionId: 'unbound-worker', role: 'neo' }
        )
      ).toEqual({ ok: false, reason: 'This operation belongs to Neo.' });
      const retry = registry.get('neo.coding.merge.retry');
      if (!retry) throw new Error('Expected coding merge retry operation');
      expect(Reflect.has(retry.execute, 'pipeline')).toBe(false);
      expect(
        await retry.execute({}, { source: 'mcp', sessionId: 'unbound-worker', role: 'neo' })
      ).toEqual({ ok: false, reason: 'This operation belongs to Neo.' });
      expect(await retry.execute({}, { source: 'rpc', principal: 'local' })).toEqual({
        accepted: false,
        reason: 'Only Neo can accept a stopped daemon merge report.',
      });
      expect(registry.get('verify.pack.echo')).toBeDefined();
      const direct = registry.get('verify.pack.echo');
      if (!direct) throw new Error('Expected synthetic pack operation');
      expect(Reflect.has(direct.execute, 'pipeline')).toBe(true);
      expect(
        await direct.execute(
          { text: 'Synthetic bytes' },
          { source: 'mcp', sessionId: 'unbound-worker', role: 'neo' }
        )
      ).toEqual({ ok: false, reason: 'This operation belongs to Neo.' });
      expect(calls).toBe(0);
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
});
