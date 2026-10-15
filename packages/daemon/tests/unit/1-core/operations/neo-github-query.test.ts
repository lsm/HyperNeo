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
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
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
          'number,title,url,state,createdAt,mergedAt,closedAt',
          '--search',
          `merged:${since}..${until}`,
        ],
      },
    });
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

  test('orders matches newest first and says when more matched than the limit', () => {
    expect(
      presentNeoGithubQuery(plan.value, {
        data: [pr(1, '2026-10-15T10:05:00Z'), pr(3, '2026-10-15T11:30:00Z'), pr(2, since)],
      })
    ).toMatchObject({
      value: { ok: true, kind: 'list', items: [{ number: 3 }, { number: 1 }], truncated: true },
    });
  });

  test('reports an unreadable list instead of an empty one', () => {
    expect(presentNeoGithubQuery(plan.value, { data: null })).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('unreadable') },
    });
  });
});

describe('neo.github.read list form', () => {
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
      const list = mock(async (_args: string[]) => merged);
      service.listGithub = list;
      const result = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.github.read',
        { repo: 'lsm/HyperNeo', state: 'merged', since, until },
        { source: 'rpc', principal: 'local' }
      );
      expect(list.mock.calls[0]?.[0]).toContain(`merged:${since}..${until}`);
      expect(result).toMatchObject({
        value: { ok: true, kind: 'list', truncated: false },
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
