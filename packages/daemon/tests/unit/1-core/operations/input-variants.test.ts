import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { createCodingWritePlanOperation } from '../../../../src/lib/neo/packs/coding/stage-preferences.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { parseOperationInput } from '../../../../src/lib/operations/invoke.ts';
import fixtures from './fixtures/refused-inputs.json';

const invoke = async (schema: z.ZodType, input: unknown) => {
  const handler = createOperationMcpHandler(
    createOperationRegistry([
      defineOperation({
        name: 'fixture.echo',
        description: 'Echo parsed input',
        inputSchema: schema,
        resultSchema: z.unknown(),
        execute: async (input) => input,
      }),
    ]),
    () => ({})
  );
  const result = await handler({ name: 'fixture.echo', input });
  return { error: result.isError === true, value: JSON.parse(result.content[0].text) };
};

describe('operation input variants through the MCP door', () => {
  test('replays sanitized historical aliases against the real operation schemas', async () => {
    const db = new Database(':memory:');
    try {
      const operations = [
        createCodingWritePlanOperation(() => db),
        ...createNeoQuestionOperations(
          new NeoAskTodoRepository(db),
          async () => {},
          async () => ({ ok: true })
        ),
      ];
      for (const fixture of fixtures) {
        const operation = operations.find((op) => op.name === fixture.operation)!;
        expect(await parseOperationInput(operation, fixture.input)).toEqual(
          await parseOperationInput(operation, fixture.canonical)
        );
      }
    } finally {
      db.close();
    }
  });
  test('normalizes finite scalar variants inside objects, arrays and records', async () => {
    const schema = z.object({
      id: z.string(),
      count: z.number().int().min(1).max(20),
      rows: z.array(z.object({ score: z.number().optional() })),
      labels: z.record(z.string(), z.string()),
    });
    expect(
      await invoke(schema, { id: 12, count: ' 2 ', rows: [{ score: '3.5' }], labels: { a: 4 } })
    ).toEqual({
      error: false,
      value: { id: '12', count: 2, rows: [{ score: 3.5 }], labels: { a: '4' } },
    });
  });
  test.each(['', ' ', '0x10', 'Infinity', 'NaN', '2 cats', '1.5', '21', '0'])(
    'keeps number constraints for %j',
    async (count) => {
      expect(
        (await invoke(z.object({ count: z.number().int().min(1).max(20) }), { count })).error
      ).toBe(true);
    }
  );
  test('preserves valid unions and converts an unambiguous branch', async () => {
    const schema = z.object({
      value: z.union([z.string(), z.number()]),
      target: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), count: z.number() }),
        z.object({ kind: z.literal('b'), id: z.string() }),
      ]),
    });
    expect(
      (await invoke(schema, { value: '12', target: { kind: 'a', count: '2' } })).value
    ).toEqual({ value: '12', target: { kind: 'a', count: 2 } });
  });
  test('refuses conflicts, unknown aliases and boolean/array variants', async () => {
    const schema = z.strictObject({
      count: z.number().meta({ aliases: ['total'] }),
      flag: z.boolean(),
      rows: z.array(z.string()),
    });
    for (const input of [
      { count: 1, total: 2, flag: true, rows: [] },
      { amount: 1, flag: true, rows: [] },
      { count: true, flag: true, rows: [] },
      { count: 1, flag: 'true', rows: [] },
      { count: 1, flag: true, rows: 'hello' },
    ]) {
      expect((await invoke(schema, input)).error).toBe(true);
    }
  });
});
