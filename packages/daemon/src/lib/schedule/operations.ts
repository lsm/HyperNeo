import type { Session, TaskSchedule } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  defineOperation,
  type OperationCaller,
  type OperationCallerRole,
  type OperationDefinition,
  type OperationPolicy,
} from '../operations/registry.ts';
import {
  admitSpaceCaller,
  type SpaceCallerAdmission,
  type SpaceCallerRejection,
} from '../operations/space-caller-admission.ts';
import type { ScheduleService } from './schedule-service.ts';

export interface ScheduleAuditEntry {
  readonly toolName: string;
  readonly spaceId: string;
  readonly caller: OperationCaller;
  readonly paramsSummary: Record<string, unknown>;
}

export interface ScheduleOperationDependencies {
  readonly schedules: Pick<
    ScheduleService,
    | 'createSchedule'
    | 'listSchedules'
    | 'getSchedule'
    | 'pauseSchedule'
    | 'resumeSchedule'
    | 'deleteSchedule'
  >;
  readonly getSession: (sessionId: string) => Session | null;
  readonly sessionSpaceId: (session: Session) => string | undefined;
  readonly audit?: (entry: ScheduleAuditEntry) => void;
}

const TaskScheduleSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string(),
  description: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  preferredWorkflowId: z.string().nullable(),
  labels: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  triggerType: z.enum(['cron', 'at']),
  cronExpression: z.string().nullable(),
  runAt: z.number().nullable(),
  timezone: z.string(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastCreatedTaskId: z.string().nullable(),
  pendingJobId: z.string().nullable(),
  status: z.enum(['active', 'paused', 'completed']),
  createdByAgent: z.string().nullable(),
  createdBySession: z.string().nullable(),
  createdAt: z.number(),
  goalId: z.string().nullable().optional(),
  updatedAt: z.number(),
}) satisfies z.ZodType<TaskSchedule>;

const ScheduleRejectionSchema = z.object({
  ok: z.literal(false),
  reason: z.enum([
    'space_scope_required',
    'space_mismatch',
    'denied',
    'schedule_not_found',
    'modified_concurrently',
    'rejected',
  ]),
  message: z.string(),
});

const ScheduleResultSchema = z.union([
  z.object({ ok: z.literal(true), schedule: TaskScheduleSchema }),
  ScheduleRejectionSchema,
]);

const ScheduleListResultSchema = z.union([
  z.object({ ok: z.literal(true), schedules: z.array(TaskScheduleSchema) }),
  ScheduleRejectionSchema,
]);

const ScheduleDeleteResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  ScheduleRejectionSchema,
]);

type ScheduleRejection = z.infer<typeof ScheduleRejectionSchema>;
type ScheduleResult = z.infer<typeof ScheduleResultSchema>;
type ScheduleListResult = z.infer<typeof ScheduleListResultSchema>;
type ScheduleDeleteResult = z.infer<typeof ScheduleDeleteResultSchema>;

const SpaceScopeSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Space to act in. Ignored for agents, whose Space comes from their session.');

const CreateScheduleInputSchema = z
  .object({
    spaceId: SpaceScopeSchema,
    title: z.string().min(1),
    description: z.string(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    workflowId: z.string().min(1).optional(),
    labels: z.array(z.string()).optional(),
    triggerType: z.enum(['cron', 'at']),
    cronExpression: z.string().min(1).optional(),
    runAt: z.number().optional(),
    timezone: z.string().min(1).optional(),
  })
  .strict();

const ListSchedulesInputSchema = z
  .object({
    spaceId: SpaceScopeSchema,
    status: z.enum(['active', 'paused', 'completed']).optional(),
  })
  .strict();

const ScheduleRefInputSchema = z
  .object({ spaceId: SpaceScopeSchema, scheduleId: z.string().min(1) })
  .strict();

type CreateScheduleInput = z.infer<typeof CreateScheduleInputSchema>;
type ListSchedulesInput = z.infer<typeof ListSchedulesInputSchema>;
type ScheduleRefInput = z.infer<typeof ScheduleRefInputSchema>;

const SCOPE_MESSAGES: Record<SpaceCallerRejection, string> = {
  space_scope_required: 'A Space is required: pass spaceId, or call from a session inside a Space.',
  space_mismatch: 'The requested spaceId does not match the calling session Space.',
  denied: 'This caller may not use Space schedules.',
};

function reject(reason: ScheduleRejection['reason'], message: string): ScheduleRejection {
  return { ok: false, reason, message };
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordScheduleAudit(deps: ScheduleOperationDependencies, entry: ScheduleAuditEntry): void {
  try {
    deps.audit?.(entry);
  } catch {}
}

export function resolveScheduleScope(
  input: { spaceId?: string },
  caller: OperationCaller,
  deps: ScheduleOperationDependencies,
  admission: SpaceCallerAdmission
): { value: string } | { reason: ScheduleRejection } {
  const scope = admitSpaceCaller(caller, input.spaceId, {
    ...admission,
    getSession: deps.getSession,
    sessionSpaceId: deps.sessionSpaceId,
  });
  return 'value' in scope ? scope : { reason: reject(scope.reason, SCOPE_MESSAGES[scope.reason]) };
}

export function requireScheduleInSpace(
  spaceId: string,
  input: ScheduleRefInput,
  deps: ScheduleOperationDependencies
): { value: TaskSchedule } | { reason: ScheduleRejection } {
  const schedule = deps.schedules.getSchedule(input.scheduleId);
  return schedule && schedule.spaceId === spaceId
    ? { value: schedule }
    : { reason: reject('schedule_not_found', `Schedule not found: ${input.scheduleId}`) };
}

export function createScheduleRecord(
  spaceId: string,
  input: CreateScheduleInput,
  caller: OperationCaller,
  deps: ScheduleOperationDependencies
): ScheduleResult {
  let schedule: TaskSchedule;
  try {
    schedule = deps.schedules.createSchedule({
      spaceId,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority,
      preferredWorkflowId: input.workflowId ?? null,
      labels: input.labels,
      triggerType: input.triggerType,
      cronExpression: input.cronExpression ?? null,
      runAt: input.runAt ?? null,
      timezone: input.timezone,
      createdByAgent: caller.agentName ?? null,
      createdBySession: caller.sessionId ?? null,
    });
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
  recordScheduleAudit(deps, {
    toolName: 'schedule.create',
    spaceId,
    caller,
    paramsSummary: {
      title: input.title,
      trigger_type: input.triggerType,
      cron_expression: input.cronExpression,
      run_at: input.runAt,
      timezone: input.timezone,
    },
  });
  return { ok: true, schedule };
}

export function listScheduleRecords(
  spaceId: string,
  input: ListSchedulesInput,
  deps: ScheduleOperationDependencies
): ScheduleListResult {
  try {
    return { ok: true, schedules: deps.schedules.listSchedules(spaceId, input.status) };
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
}

export function readScheduleRecord(schedule: TaskSchedule): ScheduleResult {
  return { ok: true, schedule };
}

export function applyScheduleTransition(
  schedule: TaskSchedule,
  caller: OperationCaller,
  deps: ScheduleOperationDependencies,
  transition: 'pause' | 'resume'
): ScheduleResult {
  let updated: TaskSchedule;
  try {
    updated =
      transition === 'pause'
        ? deps.schedules.pauseSchedule(schedule.id)
        : deps.schedules.resumeSchedule(schedule.id);
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
  recordScheduleAudit(deps, {
    toolName: `schedule.${transition}`,
    spaceId: schedule.spaceId,
    caller,
    paramsSummary: { schedule_id: schedule.id },
  });
  return { ok: true, schedule: updated };
}

export function deleteScheduleRecord(
  schedule: TaskSchedule,
  caller: OperationCaller,
  deps: ScheduleOperationDependencies
): ScheduleDeleteResult {
  let deleted: boolean;
  try {
    deleted = deps.schedules.deleteSchedule(schedule.id);
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
  if (!deleted) {
    return reject(
      'modified_concurrently',
      'Schedule was modified concurrently (e.g. a fire job advanced it). Please retry.'
    );
  }
  recordScheduleAudit(deps, {
    toolName: 'schedule.delete',
    spaceId: schedule.spaceId,
    caller,
    paramsSummary: { schedule_id: schedule.id },
  });
  return { ok: true };
}

const READ_ADMISSION: SpaceCallerAdmission = { readOnly: true };
const WRITE_ADMISSION: SpaceCallerAdmission = { readOnly: false };

const READ_ROLES: readonly OperationCallerRole[] = [
  'ad_hoc_member',
  'long_term_agent',
  'universal_read',
  'workflow_worker',
];
const WRITE_ROLES: readonly OperationCallerRole[] = ['ad_hoc_member', 'long_term_agent'];

const READ_POLICY: OperationPolicy = { safetyClass: 'read', roles: READ_ROLES };
const MUTATE_POLICY: OperationPolicy = { safetyClass: 'mutate', roles: WRITE_ROLES };
const DESTRUCTIVE_POLICY: OperationPolicy = { safetyClass: 'destructive', roles: WRITE_ROLES };

const SCOPE_NOTE =
  'Human (RPC) callers pass spaceId; agent (MCP) callers inherit the Space of their own session and may not override it.';

function schedulePipeline<Input, Result>(
  label: string,
  injected: Record<string, unknown>,
  stages: (pipeline: PipelineAPI) => PipelineAPI
): (input: Input, caller: OperationCaller) => Promise<Result> {
  const scoped = (superpipe(injected)(label) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(resolveScheduleScope, ['input', 'caller', 'deps', 'admission'], 'result:outcome');
  return stages(scoped).endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<Result>;
}

export function createScheduleOperations(
  deps: ScheduleOperationDependencies
): OperationDefinition[] {
  const write = { deps, admission: WRITE_ADMISSION };
  const read = { deps, admission: READ_ADMISSION };

  const create = schedulePipeline<CreateScheduleInput, ScheduleResult>(
    'schedule-create',
    write,
    (pipeline) =>
      pipeline.pipe(createScheduleRecord, ['outcome', 'input', 'caller', 'deps'], 'outcome')
  );
  const list = schedulePipeline<ListSchedulesInput, ScheduleListResult>(
    'schedule-list',
    read,
    (pipeline) => pipeline.pipe(listScheduleRecords, ['outcome', 'input', 'deps'], 'outcome')
  );
  const get = schedulePipeline<ScheduleRefInput, ScheduleResult>('schedule-get', read, (pipeline) =>
    pipeline
      .pipe(requireScheduleInSpace, ['outcome', 'input', 'deps'], 'result:outcome')
      .pipe(readScheduleRecord, 'outcome', 'outcome')
  );
  const pause = schedulePipeline<ScheduleRefInput, ScheduleResult>(
    'schedule-pause',
    { ...write, transition: 'pause' },
    (pipeline) =>
      pipeline
        .pipe(requireScheduleInSpace, ['outcome', 'input', 'deps'], 'result:outcome')
        .pipe(applyScheduleTransition, ['outcome', 'caller', 'deps', 'transition'], 'outcome')
  );
  const resume = schedulePipeline<ScheduleRefInput, ScheduleResult>(
    'schedule-resume',
    { ...write, transition: 'resume' },
    (pipeline) =>
      pipeline
        .pipe(requireScheduleInSpace, ['outcome', 'input', 'deps'], 'result:outcome')
        .pipe(applyScheduleTransition, ['outcome', 'caller', 'deps', 'transition'], 'outcome')
  );
  const remove = schedulePipeline<ScheduleRefInput, ScheduleDeleteResult>(
    'schedule-delete',
    write,
    (pipeline) =>
      pipeline
        .pipe(requireScheduleInSpace, ['outcome', 'input', 'deps'], 'result:outcome')
        .pipe(deleteScheduleRecord, ['outcome', 'caller', 'deps'], 'outcome')
  );

  return [
    defineOperation({
      name: 'schedule.create',
      policy: { ...MUTATE_POLICY, audit: { selfAudited: true } },
      description: `Create a recurring (cron) or one-shot (at) schedule that spawns a real Space task each time it fires. ${SCOPE_NOTE} Returns the created schedule, or a rejection: denied for callers without Space write access, space_scope_required or space_mismatch for scope problems, rejected when the trigger is invalid or the Space is not active.`,
      inputSchema: CreateScheduleInputSchema,
      resultSchema: ScheduleResultSchema,
      execute: (input, caller) => create(input, caller),
    }),
    defineOperation({
      name: 'schedule.list',
      policy: READ_POLICY,
      description: `List every task schedule in a Space with its trigger, next run time, and status. ${SCOPE_NOTE} Workflow workers may read schedules. Returns the schedules, or a rejection.`,
      inputSchema: ListSchedulesInputSchema,
      resultSchema: ScheduleListResultSchema,
      execute: (input, caller) => list(input, caller),
    }),
    defineOperation({
      name: 'schedule.get',
      policy: READ_POLICY,
      description: `Inspect one schedule including its last spawned task and next run time. ${SCOPE_NOTE} Workflow workers may read schedules. Returns the schedule, or schedule_not_found when it is absent or owned by another Space.`,
      inputSchema: ScheduleRefInputSchema,
      resultSchema: ScheduleResultSchema,
      execute: (input, caller) => get(input, caller),
    }),
    defineOperation({
      name: 'schedule.pause',
      policy: { ...MUTATE_POLICY, audit: { selfAudited: true } },
      description: `Pause a schedule so it stops creating tasks until resumed. ${SCOPE_NOTE} Returns the paused schedule, schedule_not_found, or rejected when the schedule is not active.`,
      inputSchema: ScheduleRefInputSchema,
      resultSchema: ScheduleResultSchema,
      execute: (input, caller) => pause(input, caller),
    }),
    defineOperation({
      name: 'schedule.resume',
      policy: { ...MUTATE_POLICY, audit: { selfAudited: true } },
      description: `Resume a paused schedule, recomputing the next run time and re-enqueueing the fire job. ${SCOPE_NOTE} Returns the resumed schedule, schedule_not_found, or rejected when the schedule is not paused.`,
      inputSchema: ScheduleRefInputSchema,
      resultSchema: ScheduleResultSchema,
      execute: (input, caller) => resume(input, caller),
    }),
    defineOperation({
      name: 'schedule.delete',
      policy: { ...DESTRUCTIVE_POLICY, audit: { selfAudited: true } },
      description: `Permanently delete a schedule and cancel its pending fire job. ${SCOPE_NOTE} Documented autonomy requirement: level 4 (destructive); autonomy enforcement is a later subsystem and is not applied here. Returns ok, schedule_not_found, or modified_concurrently when a fire job advanced the schedule — retry in that case.`,
      inputSchema: ScheduleRefInputSchema,
      resultSchema: ScheduleDeleteResultSchema,
      execute: (input, caller) => remove(input, caller),
    }),
  ];
}
