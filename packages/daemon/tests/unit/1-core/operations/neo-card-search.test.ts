import { describe, expect, test } from 'bun:test';
import { createNeoCardSearchOperation } from '../../../../src/lib/neo/card-search-operation.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { NeoCardSearchPage } from '../../../../src/storage/neo-card-search.ts';

const neoCaller: OperationCaller = { source: 'mcp', sessionId: 'neo:c', role: 'neo' };
const admitAll = () => ({ value: neoCaller });

describe('neo.ask.search operation', () => {
  test('passes query, cursor and limit through and returns pointer rows', async () => {
    const page: NeoCardSearchPage = {
      results: [
        {
          askId: 'ask-1',
          todoId: null,
          questionId: null,
          field: 'title',
          score: -1.5,
          snippet: 'Release the garden catalog',
        },
      ],
      nextCursor: '2',
    };
    const calls: unknown[][] = [];
    const op = createNeoCardSearchOperation(async (query, cursor, limit) => {
      calls.push([query, cursor, limit]);
      return page;
    }, admitAll);
    const result = await op.execute({ query: 'catalog', cursor: '1', limit: 5 }, neoCaller);
    expect(calls).toEqual([['catalog', '1', 5]]);
    expect(result).toEqual({ ok: true, results: page.results, nextCursor: '2' });
  });

  test('admission refusals surface as typed rejections', async () => {
    const op = createNeoCardSearchOperation(
      async () => ({ results: [], nextCursor: null }),
      () => ({ reason: { ok: false, reason: 'This operation belongs to Neo.' } })
    );
    expect(await op.execute({ query: 'catalog' }, { source: 'rpc' } as OperationCaller)).toEqual({
      ok: false,
      reason: 'This operation belongs to Neo.',
    });
  });

  test.each(['a bc', '!!!'])(
    'rejects an unsearchable query %s before reading cards',
    async (query) => {
      let reads = 0;
      const op = createNeoCardSearchOperation(async () => {
        reads++;
        return { results: [], nextCursor: null };
      }, admitAll);
      const result = await invokeOperation(
        createOperationRegistry([op]),
        'neo.ask.search',
        { query },
        neoCaller
      );
      expect(result).toMatchObject({
        kind: 'failed',
        code: 'invalid_input',
        message: expect.stringContaining('query_too_short'),
      });
      expect(reads).toBe(0);
    }
  );

  test.each(['a', 'ab', '中文', '%', '_', '\\'])(
    'accepts the single short literal %s',
    async (query) => {
      const op = createNeoCardSearchOperation(
        async () => ({ results: [], nextCursor: null }),
        admitAll
      );
      expect(
        await invokeOperation(createOperationRegistry([op]), 'neo.ask.search', { query }, neoCaller)
      ).toMatchObject({ kind: 'completed', value: { ok: true } });
    }
  );

  test('accepts a searchable term beside short words', async () => {
    const op = createNeoCardSearchOperation(
      async () => ({ results: [], nextCursor: null }),
      admitAll
    );
    expect(
      await invokeOperation(
        createOperationRegistry([op]),
        'neo.ask.search',
        { query: 'a catalog' },
        neoCaller
      )
    ).toMatchObject({ kind: 'completed', value: { ok: true } });
  });

  test('rejects blank and oversized queries at the schema', async () => {
    const op = createNeoCardSearchOperation(
      async () => ({ results: [], nextCursor: null }),
      admitAll
    );
    const inputSchema = op.inputSchema;
    expect(inputSchema.safeParse({ query: '   ' }).success).toBe(false);
    expect(inputSchema.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
    expect(inputSchema.safeParse({ query: 'catalog', limit: 51 }).success).toBe(false);
    expect(inputSchema.safeParse({ query: 'catalog', limit: 20 }).success).toBe(true);
  });
});
