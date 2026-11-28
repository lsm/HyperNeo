import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoMemoryRepository } from '../../storage/repositories/neo-memory-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

type Denied = { ok: false; reason: 'memory_not_authorized' };
type Gate = { value: OperationCaller } | { reason: Denied };

const denied: { reason: Denied } = { reason: { ok: false, reason: 'memory_not_authorized' } };

function isNeo(caller: OperationCaller, neoSession: boolean): boolean {
  return (
    caller.role === 'neo' &&
    (caller.source === 'internal' || (caller.source === 'mcp' && neoSession))
  );
}

export function admitMemoryWriter(caller: OperationCaller, neoSession: boolean): Gate {
  return isNeo(caller, neoSession) ? { value: caller } : denied;
}

export function admitMemoryReader(caller: OperationCaller, neoSession: boolean): Gate {
  return isNeo(caller, neoSession) || isLocalUser(caller) ? { value: caller } : denied;
}

const Key = z.string().trim().min(1).max(200);
const SaveInput = z.object({ key: Key, content: z.string().trim().min(1).max(10_000) });
const SearchInput = z.object({
  query: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(20).optional(),
});
const KeyInput = z.object({ key: Key });
const Memory = z.object({
  key: z.string(),
  content: z.string(),
  createdBySession: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const DeniedSchema = z.object({ ok: z.literal(false), reason: z.literal('memory_not_authorized') });

export function createMemoryOperations(
  store: NeoMemoryRepository,
  isNeoSession: (sessionId: string) => boolean
) {
  const neoSession = (caller: OperationCaller) =>
    !!caller.sessionId && isNeoSession(caller.sessionId);
  const save = (superpipe({})('memory.save') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(neoSession, 'caller', 'neoSession')
    .pipe(admitMemoryWriter, ['caller', 'neoSession'], 'result:caller')
    .pipe(
      async (input: z.infer<typeof SaveInput>, caller: OperationCaller) => ({
        ok: true as const,
        key: (await store.save({ ...input, sessionId: caller.sessionId })).key,
      }),
      ['input', 'caller'],
      'caller'
    )
    .endAsync('caller') as (
    input: z.infer<typeof SaveInput>,
    caller: OperationCaller
  ) => Promise<{ ok: true; key: string } | Denied>;
  const search = (superpipe({})('memory.search') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(neoSession, 'caller', 'neoSession')
    .pipe(admitMemoryReader, ['caller', 'neoSession'], 'result:caller')
    .pipe(
      async (input: z.infer<typeof SearchInput>) => ({
        ok: true as const,
        memories: await store.search(input.query, input.limit ?? 10),
      }),
      'input',
      'caller'
    )
    .endAsync('caller') as (
    input: z.infer<typeof SearchInput>,
    caller: OperationCaller
  ) => Promise<{ ok: true; memories: z.infer<typeof Memory>[] } | Denied>;
  const read = (superpipe({})('memory.read') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(neoSession, 'caller', 'neoSession')
    .pipe(admitMemoryReader, ['caller', 'neoSession'], 'result:caller')
    .pipe(
      async (input: z.infer<typeof KeyInput>) => ({
        ok: true as const,
        memory: await store.read(input.key),
      }),
      'input',
      'caller'
    )
    .endAsync('caller') as (
    input: z.infer<typeof KeyInput>,
    caller: OperationCaller
  ) => Promise<{ ok: true; memory: z.infer<typeof Memory> | null } | Denied>;
  const remove = (superpipe({})('memory.delete') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(neoSession, 'caller', 'neoSession')
    .pipe(admitMemoryWriter, ['caller', 'neoSession'], 'result:caller')
    .pipe(
      async (input: z.infer<typeof KeyInput>) => ({
        ok: true as const,
        deleted: await store.delete(input.key),
      }),
      'input',
      'caller'
    )
    .endAsync('caller') as (
    input: z.infer<typeof KeyInput>,
    caller: OperationCaller
  ) => Promise<{ ok: true; deleted: boolean } | Denied>;
  return [
    defineOperation({
      name: 'memory.save',
      description:
        "Save or replace Neo's durable memory under key: a human preference, decision, environment constraint or reusable lesson. Neo only.",
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: SaveInput,
      resultSchema: z.union([z.object({ ok: z.literal(true), key: z.string() }), DeniedSchema]),
      execute: save,
    }),
    defineOperation({
      name: 'memory.search',
      description:
        "Search Neo's memories; any query word can match and the best matches come first.",
      policy: { safetyClass: 'read', roles: ['neo'] },
      inputSchema: SearchInput,
      resultSchema: z.union([
        z.object({ ok: z.literal(true), memories: z.array(Memory) }),
        DeniedSchema,
      ]),
      execute: search,
    }),
    defineOperation({
      name: 'memory.read',
      description: "Read one of Neo's memories by key; memory is null when none exists.",
      policy: { safetyClass: 'read', roles: ['neo'] },
      inputSchema: KeyInput,
      resultSchema: z.union([
        z.object({ ok: z.literal(true), memory: Memory.nullable() }),
        DeniedSchema,
      ]),
      execute: read,
    }),
    defineOperation({
      name: 'memory.delete',
      description:
        "Delete one of Neo's memories by key when it is wrong, obsolete or withdrawn. Neo only.",
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: KeyInput,
      resultSchema: z.union([
        z.object({ ok: z.literal(true), deleted: z.boolean() }),
        DeniedSchema,
      ]),
      execute: remove,
    }),
  ];
}
