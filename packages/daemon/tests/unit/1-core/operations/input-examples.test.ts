import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function failure(schema: z.ZodType, input: unknown) {
  const operation = defineOperation({
    name: 'example.operation',
    description: 'Example',
    inputSchema: schema,
    resultSchema: z.unknown(),
    execute: async () => {
      throw new Error('must not execute');
    },
  });
  const handler = createOperationMcpHandler(createOperationRegistry([operation]), () => ({}));
  const result = await handler({ name: operation.name, input });
  expect(result.isError).toBe(true);
  const error = JSON.parse(result.content[0].text) as { code: string; message: string };
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('\nExample input: ');
  const example = JSON.parse(error.message.split('\nExample input: ')[1]);
  expect((await schema.safeParseAsync(example)).success).toBe(true);
  return { example, message: error.message };
}

describe('operation validation examples through MCP', () => {
  test('a throwing async refinement retains its error and gets a valid example', async () => {
    const schema = z
      .object({ text: z.string() })
      .superRefine(async (input) => {
        if (input.text === 'bad') throw new Error('Invalid example text');
      })
      .meta({ examples: [{ text: 'bad' }, { text: 'good' }] });
    const { example, message } = await failure(schema, { text: 'bad' });
    expect(example).toEqual({ text: 'good' });
    expect(message).toContain('Invalid example text');
  });
  test('all advertised daemon operations have one schema-valid example', () => {
    const run = mkdtempSync(join(tmpdir(), 'operation-example-audit-'));
    try {
      mkdirSync(join(run, 'home'));
      mkdirSync(join(run, 'tmp'));
      const script = resolve(
        import.meta.dirname,
        '../../../../../../.claude/skills/verify/operation-input-catalog-audit.ts'
      );
      const output = execFileSync('bun', [script, run], {
        env: {
          PATH: process.env.PATH,
          HOME: join(run, 'home'),
          TMPDIR: join(run, 'tmp'),
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'warn',
        },
        timeout: 30000,
        encoding: 'utf8',
      });
      const result = JSON.parse(output.trim().split('\n').at(-1)!);
      expect(result.schemas).toBeGreaterThan(0);
      expect(result.missing).toEqual([]);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 30000);
  test('generates a valid input with nested unions, constraints and defaults', async () => {
    const schema = z.object({
      name: z.string().min(10).max(12),
      count: z.number().int().min(2).max(4),
      target: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), ids: z.array(z.uuid()).min(2) }),
        z.object({ kind: z.literal('b'), url: z.url() }),
      ]),
      ignored: z.string().default('default'),
    });
    await failure(schema, { name: 3 });
  });
  test('returns one validated metadata example, without exposing invalid examples', async () => {
    const schema = z
      .object({ count: z.number().min(1) })
      .meta({ examples: [{ count: 0 }, { count: 2 }, { count: 3 }] });
    const { example, message } = await failure(schema, {});
    expect(example).toEqual({ count: 2 });
    expect(message).not.toContain('Valid examples:');
  });
  test('shows input values before a schema transform', async () => {
    const schema = z
      .object({ amount: z.string().min(1).transform(Number) })
      .meta({ examples: [{ amount: '2' }] });
    expect((await failure(schema, {})).example).toEqual({ amount: '2' });
  });
  test('retains custom validity errors and supplies a correct todo.add input', async () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      createTables(db);
      const controls = {
        start: async () => ({ ok: false as const, reason: 'unused' }),
        proceed: async () => ({ ok: false as const, reason: 'unused' }),
        retry: async () => ({ ok: false as const, reason: 'unused' }),
        recompute: async (
          todo: Parameters<Parameters<typeof createNeoTodoOperations>[2]['recompute']>[0]
        ) => todo,
        stop: async () => null,
      };
      const operation = createNeoTodoOperations(
        new NeoAskTodoRepository(db),
        new NeoTodoSessionRepository(db),
        controls,
        () => [],
        () => null
      ).find((op) => op.name === 'neo.todo.add')!;
      const { message } = await failure(operation.inputSchema, {
        askId: 'synthetic',
        title: 'Example',
        doneWhen: 'Finished',
        check: { pack: 'coding', kind: 'pr_merged', params: {} },
        instruction: 'Perform work',
      });
      expect(message).toContain('needs a target');
    } finally {
      db.close();
    }
  });
});
