import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import type { NeoService } from './service.ts';

const Concern = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  context: z.string(),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const Work = z.object({
  id: z.string(),
  requestKey: z.string(),
  concernId: z.string().nullable(),
  originSessionId: z.string(),
  title: z.string(),
  instruction: z.string(),
  sessionId: z.string().nullable(),
  status: z.enum(['proposed', 'queued', 'reported', 'failed', 'cancelled']),
  report: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const Failure = z.object({ ok: z.literal(false), reason: z.string() });
const Snapshot = z.union([
  Failure,
  z.object({
    ok: z.literal(true),
    sessionId: z.string().nullable(),
    concerns: z.array(Concern),
    work: z.array(Work),
  }),
]);
const WorkResult = z.union([Failure, z.object({ ok: z.literal(true), work: Work })]);
const Scope = z.object({ concernId: z.string().min(1).optional() }).default({});
const Save = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(160),
  summary: z.string().max(1000),
  context: z.string().max(16000),
  expectedRevision: z.number().int().min(0),
});
const Propose = z.object({
  requestKey: z.string().min(1).max(160),
  concernId: z.string().min(1).nullable().default(null),
  title: z.string().trim().min(1).max(160),
  instruction: z.string().trim().min(1).max(16000),
});
const WorkId = z.object({ id: z.string().min(1) });
type Rejection = { ok: false; reason: string };

export function admitNeoCaller(
  service: NeoService,
  caller: OperationCaller,
  name: string,
  concernId?: string | null
): { value: OperationCaller } | { reason: Rejection } {
  if (caller.source === 'rpc' && caller.principal === 'local') return { value: caller };
  const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
  if (caller.source !== 'mcp' || !binding || binding.kind === 'worker')
    return { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
  if (['neo.open', 'neo.work.start', 'neo.work.cancel'].includes(name))
    return { reason: { ok: false, reason: 'This action needs the user.' } };
  if (binding.kind === 'concern' && concernId !== undefined && concernId !== binding.concernId)
    return { reason: { ok: false, reason: 'This context holder cannot access another concern.' } };
  return { value: caller };
}

export function createNeoOperations(service: NeoService) {
  function path<I, O>(
    name: string,
    scope: (input: I) => string | null | undefined,
    action: (input: I, caller: OperationCaller) => O | Promise<O>
  ) {
    return (superpipe({})(name) as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(
        (input: I, caller: OperationCaller) => admitNeoCaller(service, caller, name, scope(input)),
        ['input', 'caller'],
        'result:admission'
      )
      .pipe(action, ['input', 'admission'], 'admission')
      .endAsync('admission') as (input: I, caller: OperationCaller) => Promise<O | Rejection>;
  }
  function snapshot(caller: OperationCaller, requested?: string) {
    const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
    const scope = binding?.kind === 'concern' ? binding.concernId : requested;
    const concerns = service.repo.listConcerns().filter((item) => !scope || item.id === scope);
    return {
      ok: true as const,
      sessionId: service.repo.getBindingForConcern(scope ?? null)?.sessionId ?? null,
      concerns: concerns.map((item) => ({
        ...item,
        context: caller.source === 'rpc' || scope ? item.context : '',
      })),
      work: service.repo
        .listWork(scope === undefined ? undefined : scope)
        .slice(0, caller.source === 'rpc' ? 50 : 10)
        .map((item) =>
          caller.source === 'rpc'
            ? item
            : {
                ...item,
                instruction: scope ? item.instruction.slice(0, 1000) : '',
                report: scope ? (item.report?.slice(0, 3000) ?? null) : null,
              }
        ),
    };
  }
  const read = path(
    'neo.snapshot',
    (input: z.infer<typeof Scope>) => input.concernId,
    (input, caller) => snapshot(caller, input.concernId)
  );
  const open = path(
    'neo.open',
    (input: z.infer<typeof Scope>) => input.concernId,
    async (input, caller) => {
      if (input.concernId && !service.repo.getConcern(input.concernId))
        return { ok: false as const, reason: 'Concern not found.' };
      return { ...snapshot(caller), sessionId: await service.open(input.concernId ?? null) };
    }
  );
  const save = path(
    'neo.concern.save',
    (input: z.infer<typeof Save>) => input.id,
    (input) => {
      const concern = service.repo.saveConcern(input, input.expectedRevision);
      return concern
        ? { ok: true as const, concern }
        : {
            ok: false as const,
            reason: 'superseded: read the current concern before saving again',
          };
    }
  );
  const propose = path(
    'neo.work.propose',
    (input: z.infer<typeof Propose>) => input.concernId,
    (input, caller) => {
      if (input.concernId && !service.repo.getConcern(input.concernId))
        return { ok: false as const, reason: 'Concern not found.' };
      const originSessionId =
        caller.sessionId ?? service.repo.getBindingForConcern(input.concernId)?.sessionId;
      if (!originSessionId) return { ok: false as const, reason: 'Open Neo first.' };
      const work = service.repo.proposeWork({
        ...input,
        requestKey: `${originSessionId}:${input.requestKey}`,
        id: crypto.randomUUID(),
        originSessionId,
      });
      return { ok: true as const, work };
    }
  );
  const start = path(
    'neo.work.start',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }) => {
      if (!service.repo.getWork(id)) return { ok: false as const, reason: 'Work not found.' };
      await service.start(id);
      return { ok: true as const, work: service.repo.getWork(id)! };
    }
  );
  const cancel = path(
    'neo.work.cancel',
    (_input: z.infer<typeof WorkId>) => undefined,
    async ({ id }) => {
      if (!service.repo.getWork(id)) return { ok: false as const, reason: 'Work not found.' };
      await service.cancel(id);
      return { ok: true as const, work: service.repo.getWork(id)! };
    }
  );
  return [
    defineOperation({
      name: 'neo.open',
      description: 'Open the human Neo or concern conversation.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'human_only' },
      execute: open,
    }),
    defineOperation({
      name: 'neo.snapshot',
      description:
        'Read durable concern summaries and execution receipts. Pass concernId to load that concern’s full context.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: read,
    }),
    defineOperation({
      name: 'neo.concern.save',
      description:
        'Create a continuing context only when needed, or update an existing context with revision protection. Never one concern per message.',
      inputSchema: Save,
      resultSchema: z.union([Failure, z.object({ ok: z.literal(true), concern: Concern })]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: save,
    }),
    defineOperation({
      name: 'neo.work.propose',
      description:
        'Propose work for user approval. Reuse requestKey to avoid duplicate proposals. This does not start execution.',
      inputSchema: Propose,
      resultSchema: WorkResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: propose,
    }),
    defineOperation({
      name: 'neo.work.start',
      description: 'Start a user-approved delegation through the existing session runtime.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'human_only' },
      execute: start,
    }),
    defineOperation({
      name: 'neo.work.cancel',
      description: 'Cancel a proposal or interrupt its execution.',
      inputSchema: WorkId,
      resultSchema: WorkResult,
      policy: { safetyClass: 'human_only' },
      execute: cancel,
    }),
  ];
}
