import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { createDriverHealthMonitor } from './driver-health.ts';
import { createDriverHealthProbe, LOCAL_HEALTH_DRIVERS } from './driver-health-probes.ts';
import { WorkDriverHealthSchema } from './work-operations.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isLocalUser } from '../operations/caller.ts';
import { isNeoConversationSession } from '../neo/publication-read-operation.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { globalSettingsWrites } from '../../storage/repositories/global-settings-writes.ts';
import type { FamilyOperationContext } from '../rpc-handlers/family-operations/context.ts';
import type { WorkAdapter } from './types.ts';

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check') }),
  z.object({
    action: z.literal('verified'),
    adapter: z.enum(LOCAL_HEALTH_DRIVERS),
    journey: z.string().trim().min(1),
    clientVersions: z
      .record(z.string(), z.string())
      .refine((versions) => Object.keys(versions).length > 0),
  }),
]);
type Denied = { ok: false; reason: 'human_or_neo_only' };

export function createDriverHealthRuntime(
  context: FamilyOperationContext,
  adapters: () => readonly WorkAdapter[]
) {
  const { db, jobQueue, jobProcessor } = context.deps;
  const read = () => db.gateway.call(globalSettingsWrites, 'readDriverHealth');
  const monitor = createDriverHealthMonitor({
    ids: LOCAL_HEALTH_DRIVERS,
    now: Date.now,
    read,
    save: async (id, health) => {
      await db.gateway.call(globalSettingsWrites, 'driverHealth', id, health);
    },
    probe: createDriverHealthProbe({ home: homedir(), adapters }),
    notify: (id, text) => context.driverHealthNotice?.(id, text) ?? Promise.resolve(false),
  });
  const check = (superpipe({})('scheduled-driver-health') as PipelineAPI)
    .input('startup')
    .pipe((startup: boolean) => monitor.check(startup), 'startup')
    .endAsync() as (startup: boolean) => Promise<void>;
  const queue = 'work.driver.health';
  jobProcessor.register(queue, async (job) => {
    try {
      await check(job.payload.startup === true);
    } finally {
      const runAt = Math.max(Date.now() + 1_000, await monitor.nextCheckAt());
      const pending = jobQueue
        .listActiveByPayload(queue, { scope: 'local' })
        .find((job) => job.status === 'pending');
      if (pending) jobQueue.reschedulePending(pending.id, Math.min(pending.runAt, runAt));
      else
        jobQueue.enqueueUniquePending({
          queue,
          payload: { scope: 'local' },
          matchPayload: { scope: 'local' },
          activeStatuses: ['pending'],
          runAt,
        });
    }
    return { checked: true };
  });
  if (process.env.NODE_ENV !== 'test')
    jobQueue.enqueue({ queue, payload: { scope: 'local', startup: true }, runAt: Date.now() });
  const execute = (superpipe({})('driver-health-command') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (
        input: z.infer<typeof Input>,
        caller: OperationCaller
      ): { value: z.infer<typeof Input> } | { reason: Denied } => {
        const binding =
          caller.source === 'mcp' && caller.role === 'neo' && caller.sessionId
            ? new NeoRepository(db.getDatabase()).getBindingBySession(caller.sessionId)
            : null;
        return isLocalUser(caller) || isNeoConversationSession(caller, binding)
          ? { value: input }
          : { reason: { ok: false, reason: 'human_or_neo_only' } };
      },
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      async (input: z.infer<typeof Input>) => {
        if (input.action === 'verified')
          await monitor.verified(input.adapter, input.journey, input.clientVersions);
        else await monitor.check(true);
        return { ok: true as const, health: await read() };
      },
      'admission',
      'admission'
    )
    .endAsync('admission') as (
    input: z.infer<typeof Input>,
    caller: OperationCaller
  ) => Promise<{ ok: true; health: Awaited<ReturnType<typeof read>> } | Denied>;
  return {
    read,
    operation: defineOperation({
      name: 'work.health',
      description:
        'Check local driver health without starting work, or record a passed driver verify journey. Requires the local human or a bound Neo MCP session. action check refreshes all local checks. action verified requires the adapter, the journey that actually passed, and its exact tested clientVersions; a changed version is rejected. Unverified versions remain usable when status is ok. Read saved status through work.adapters.',
      inputSchema: Input,
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          health: z.record(z.string(), WorkDriverHealthSchema),
        }),
        z.object({ ok: z.literal(false), reason: z.literal('human_or_neo_only') }),
      ]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute,
    }),
  };
}
