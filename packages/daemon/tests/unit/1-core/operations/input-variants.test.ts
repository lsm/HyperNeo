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
import { SendWorkInputSchema } from '../../../../src/lib/drivers/work-operations.ts';
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
  test('converts scalar literals and enums only to declared values', async () => {
    const schema = z.object({
      version: z.literal(2),
      mode: z.enum(['1', '2']),
      kind: z.literal('3'),
    });
    expect((await invoke(schema, { version: '2', mode: 1, kind: 3 })).value).toEqual({
      version: 2,
      mode: '1',
      kind: '3',
    });
    expect((await invoke(schema, { version: '3', mode: 1, kind: 3 })).error).toBe(true);
  });
  test('preserves input objects and rejects ambiguous union conversions', async () => {
    const input = { total: '2' };
    expect(
      await invoke(z.object({ count: z.number().meta({ aliases: ['total'] }) }), input)
    ).toEqual({
      error: false,
      value: { count: 2 },
    });
    expect(input).toEqual({ total: '2' });
    expect(
      (await invoke(z.object({ value: z.union([z.number(), z.string().max(1)]) }), { value: 123 }))
        .error
    ).toBe(false);
    expect(
      (
        await invoke(
          z.object({
            value: z.union([
              z.object({ count: z.number(), a: z.string().default('a') }),
              z.object({ count: z.number(), b: z.string().default('b') }),
            ]),
          }),
          { value: { count: '2' } }
        )
      ).error
    ).toBe(true);
  });
  test('retains defaults, tuple bounds, transformations and null checks', async () => {
    const schema = z.object({
      rows: z.tuple([z.number(), z.string().transform((value) => value.toUpperCase())]),
      count: z.number().default(2),
      id: z.string().nullable(),
      label: z.string().readonly(),
    });
    expect((await invoke(schema, { rows: ['3', 4], id: null, label: 5 })).value).toEqual({
      rows: [3, '4'],
      count: 2,
      id: null,
      label: '5',
    });
    expect((await invoke(z.object({ id: z.string() }), { id: null })).error).toBe(true);
    expect((await invoke(z.object({ id: z.string() }), { id: Infinity })).error).toBe(true);
  });
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
        const operation =
          operations.find((op) => op.name === fixture.operation) ??
          defineOperation({
            name: fixture.operation,
            description: 'Reconstructed refused shape',
            inputSchema:
              fixture.operation === 'work.send'
                ? SendWorkInputSchema
                : z.object({ todoId: z.string().min(1), reason: z.string().min(1) }),
            resultSchema: z.unknown(),
            execute: async (input) => input,
          });
        expect(await parseOperationInput(operation, fixture.input)).toEqual(
          await parseOperationInput(operation, fixture.canonical)
        );
      }
    } finally {
      db.close();
    }
  });
  test('question lookup aliases do not spread to sibling operations or other text fields', async () => {
    const db = new Database(':memory:');
    try {
      const operations = createNeoQuestionOperations(
        new NeoAskTodoRepository(db),
        async () => {},
        async () => ({ ok: true })
      );
      for (const name of ['neo.question.retire', 'neo.question.answer']) {
        const operation = operations.find((op) => op.name === name)!;
        const canonical = name.endsWith('retire')
          ? { questionId: 'q', reason: 'reason' }
          : { questionId: 'q', answer: 'answer' };
        expect(await parseOperationInput(operation, { ...canonical, id: 'ignored' })).toMatchObject(
          { value: { input: canonical } }
        );
        const { questionId: _questionId, ...rest } = canonical;
        expect(await parseOperationInput(operation, { ...rest, id: 'q' })).toMatchObject({
          reason: { code: 'invalid_input' },
        });
      }
    } finally {
      db.close();
    }
  });
  test('does not reinterpret a canonical text field as a message alias', async () => {
    const schema = z.object({
      text: z.string(),
      message: z.object({ content: z.string() }).optional(),
    });
    expect((await invoke(schema, { text: 'Report' })).value).toEqual({ text: 'Report' });
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
