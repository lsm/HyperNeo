import { generateUUID } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SessionSchedule } from '../../storage/repositories/session-schedule-repository.ts';
import { WorkRefSchema } from '../drivers/types.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { requireValidCadence, type SessionScheduler } from './session-schedules.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

const Cadence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every'), everyMs: z.number().int().positive() }),
  z.object({
    kind: z.literal('cron'),
    cron: z.string().min(1),
    timezone: z.string().default('UTC'),
  }),
]);
const Create = z.object({
  target: WorkRefSchema,
  cadence: Cadence,
  note: z.string().trim().min(1).max(2000),
  nudgeEvery: z.number().int().min(1).max(100).default(1),
});
const List = z.object({ target: WorkRefSchema.optional() });
const ById = z.object({ scheduleId: z.string().min(1) });

const ScheduleShape = z.object({ id: z.string(), status: z.string() }).passthrough();
const ScheduleResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), schedule: ScheduleShape }),
]);
const ListResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), schedules: z.array(ScheduleShape) }),
]);

export function admitScheduleCaller(caller: OperationCaller): Gate<OperationCaller> {
  return isLocalUser(caller) || caller.role === 'neo'
    ? { value: caller }
    : fail('This action belongs to Neo or the user.');
}

export function requireScheduleStatus(
  schedule: SessionSchedule | null,
  status: SessionSchedule['status'] | null
): Gate<SessionSchedule> {
  if (!schedule) return fail('not_found: no such schedule.');
  return status === null || schedule.status === status
    ? { value: schedule }
    : fail(`wrong_status: the schedule is ${schedule.status}, not ${status}.`);
}

export function createSessionScheduleOperations(scheduler: SessionScheduler) {
  const byId = (name: string, status: SessionSchedule['status'] | null) =>
    (superpipe({})(name) as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(admitScheduleCaller, 'caller', 'result:outcome')
      .pipe(
        (input: z.infer<typeof ById>) =>
          requireScheduleStatus(scheduler.repo.get(input.scheduleId), status),
        'input',
        'result:outcome'
      );

  const create = (superpipe({})('schedule.session.create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitScheduleCaller, 'caller', 'result:outcome')
    .pipe(
      (input: z.infer<typeof Create>) => {
        const cadence = requireValidCadence(input.cadence);
        return 'reason' in cadence ? fail(cadence.reason) : { value: input };
      },
      'input',
      'result:outcome'
    )
    .pipe(
      (input: z.infer<typeof Create>, caller: OperationCaller) => ({
        ok: true as const,
        schedule: scheduler.create({
          target: input.target,
          sourceKind: 'reminder',
          sourceId: generateUUID(),
          note: input.note,
          cadence: input.cadence,
          nudgeEvery: input.nudgeEvery,
          createdBySession: caller.sessionId ?? null,
        }),
      }),
      ['outcome', 'caller'],
      'outcome'
    )
    .end('outcome');

  const list = (superpipe({})('schedule.session.list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitScheduleCaller, 'caller', 'result:outcome')
    .pipe(
      (_caller: OperationCaller, input: z.infer<typeof List>) => ({
        ok: true as const,
        schedules: scheduler.repo.list(input.target),
      }),
      ['outcome', 'input'],
      'outcome'
    )
    .end('outcome');

  const changed = (
    name: string,
    status: SessionSchedule['status'] | null,
    act: (s: SessionSchedule) => SessionSchedule
  ) =>
    byId(name, status)
      .pipe(
        (schedule: SessionSchedule) => ({ ok: true as const, schedule: act(schedule) }),
        'outcome',
        'outcome'
      )
      .end('outcome');

  const pause = changed('schedule.session.pause', 'active', (s) => scheduler.pause(s));
  const resume = changed('schedule.session.resume', 'paused', (s) => scheduler.resume(s));
  const remove = byId('schedule.session.delete', null)
    .pipe(
      (schedule: SessionSchedule) =>
        scheduler.delete(schedule)
          ? { ok: true as const, schedule }
          : { ok: false as const, reason: 'busy: the schedule is firing; try again.' },
      'outcome',
      'outcome'
    )
    .end('outcome');

  type Run = (input: unknown, caller: OperationCaller) => unknown;
  const policy = (safetyClass: 'read' | 'mutate' | 'destructive') => ({
    safetyClass,
    roles: ['neo' as const],
  });
  return [
    defineOperation({
      name: 'schedule.session.create',
      description:
        'Wake a session on a cadence with a reminder note: cadence every (everyMs, at least one minute) or cron (cron, timezone). The target is a work ref from work.find. Neo or the user only.',
      inputSchema: Create,
      resultSchema: ScheduleResult,
      policy: policy('mutate'),
      execute: async (input, caller) =>
        (create as Run)(input, caller) as z.infer<typeof ScheduleResult>,
    }),
    defineOperation({
      name: 'schedule.session.list',
      description:
        "List session schedules, or only a target session's, with cadence, next run, last run and last outcome.",
      inputSchema: List,
      resultSchema: ListResult,
      policy: policy('read'),
      execute: async (input, caller) => (list as Run)(input, caller) as z.infer<typeof ListResult>,
    }),
    defineOperation({
      name: 'schedule.session.pause',
      description: 'Pause an active session schedule.',
      inputSchema: ById,
      resultSchema: ScheduleResult,
      policy: policy('mutate'),
      execute: async (input, caller) =>
        (pause as Run)(input, caller) as z.infer<typeof ScheduleResult>,
    }),
    defineOperation({
      name: 'schedule.session.resume',
      description: 'Resume a paused session schedule from now.',
      inputSchema: ById,
      resultSchema: ScheduleResult,
      policy: policy('mutate'),
      execute: async (input, caller) =>
        (resume as Run)(input, caller) as z.infer<typeof ScheduleResult>,
    }),
    defineOperation({
      name: 'schedule.session.delete',
      description: 'Delete a session schedule.',
      inputSchema: ById,
      resultSchema: ScheduleResult,
      policy: policy('destructive'),
      execute: async (input, caller) =>
        (remove as Run)(input, caller) as z.infer<typeof ScheduleResult>,
    }),
  ];
}
