import type { SpaceGoalEventSource } from '@hyperneo/shared';
import type {
  GoalJournalDraft,
  SessionGoal,
  SessionGoalPatch,
} from '@hyperneo/shared/types/session-goal';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SessionGoalRepository } from '../../storage/repositories/session-goal-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { GOAL_READ_POLICY, GOAL_WRITE_POLICY } from './goal-operation-scope.ts';
import { SessionScheduleCadenceSchema } from '../scheduler/operations.ts';
import { requireValidCadence } from '../scheduler/session-schedules.ts';
import type { SessionGoalSchedules } from './session-goal-schedules.ts';
import {
  GoalMetricsSchema,
  GoalPrioritySchema,
  GoalStatusSchema,
  GoalTypeSchema,
} from './goal-result-schemas.ts';

type Rejection = { accepted: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };

const refuse = (reason: string): { reason: Rejection } => ({ reason: { accepted: false, reason } });

const Owner = {
  ownerSessionId: z
    .string()
    .min(1)
    .optional()
    .describe('Session that owns the goal. Agents act only on their own session and may omit it.'),
};

const Fields = {
  description: z.string().optional(),
  type: GoalTypeSchema.optional(),
  priority: GoalPrioritySchema.optional(),
  metrics: GoalMetricsSchema.optional().describe('Measured values, e.g. { adopters: 3 }'),
  doneTest: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Written test that says when the goal is met. Required when metrics are empty.'),
  summary: z.string().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  nextSteps: z.array(z.string()).optional(),
  mandateRef: z
    .string()
    .nullable()
    .optional()
    .describe('Mandate section that defines the goal, e.g. "mandate.md#adoption"'),
  mandateRev: z.string().nullable().optional().describe('Home repo commit the goal matches'),
};

const Create = z
  .object({
    ...Owner,
    ...Fields,
    title: z.string().min(1),
    cadence: SessionScheduleCadenceSchema.default({ kind: 'every', everyMs: 3_600_000 }),
    nudgeEvery: z
      .number()
      .int()
      .positive()
      .default(4)
      .describe('Legacy compatibility only; never forces a turn when facts are unchanged.'),
  })
  .strict();
const Get = z.object({ ...Owner, goalId: z.string().min(1) }).strict();
const List = z.object({ ...Owner, includeClosed: z.boolean().default(false) }).strict();
const Update = z
  .object({
    ...Owner,
    ...Fields,
    goalId: z.string().min(1),
    title: z.string().min(1).optional(),
    status: GoalStatusSchema.optional(),
    worksNote: z
      .string()
      .optional()
      .describe(
        'Rewrite what worked from the journal; retains all entries and advances the compaction cursor.'
      ),
  })
  .strict();

const Evidence = z.object({
  kind: z.enum(['pr', 'todo', 'metric', 'url', 'commit', 'text']),
  ref: z.string().min(1),
  note: z.string().optional(),
});
const Append = z
  .object({
    ...Owner,
    goalId: z.string().min(1),
    runId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Scheduler run that woke this cycle; a second entry for the same run replaces the first'
      ),
    done: z.string().min(1).describe('What this cycle did'),
    effect: z.string().min(1).describe('What changed because of it'),
    evidence: z.array(Evidence).default([]),
    worked: z.string().min(1).describe('What to repeat next cycle'),
    failed: z.string().min(1).optional().describe('What to stop doing'),
  })
  .strict();
const Journal = z
  .object({
    ...Owner,
    goalId: z.string().min(1),
    before: z
      .string()
      .min(1)
      .optional()
      .describe('Entry id: return the entries older than it, for paging'),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
const EntrySchema = z.object({
  id: z.string(),
  goalId: z.string(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  done: z.string(),
  effect: z.string(),
  evidence: z.array(Evidence),
  worked: z.string(),
  failed: z.string().nullable(),
  createdAt: z.number(),
});

const GoalSchema = z.object({
  id: z.string(),
  ownerSessionId: z.string(),
  title: z.string(),
  description: z.string(),
  status: GoalStatusSchema,
  type: GoalTypeSchema,
  priority: GoalPrioritySchema,
  metrics: GoalMetricsSchema,
  doneTest: z.string().nullable(),
  summary: z.string(),
  worksNote: z.string().nullable(),
  progress: z.number(),
  nextSteps: z.array(z.string()),
  mandateRef: z.string().nullable(),
  mandateRev: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  revision: z.number(),
});
const RejectionSchema = z.object({ accepted: z.literal(false), reason: z.string() });
const GoalResult = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), goal: GoalSchema }),
  RejectionSchema,
]);

export function resolveGoalOwner(
  caller: OperationCaller,
  input: { ownerSessionId?: string }
): Gate<string> {
  if (caller.source !== 'mcp')
    return input.ownerSessionId
      ? { value: input.ownerSessionId }
      : refuse('owner_unresolved: ownerSessionId is required for this caller.');
  if (!caller.sessionId)
    return refuse('owner_denied: a session caller needs its session id to own goals.');
  return { value: input.ownerSessionId ?? caller.sessionId };
}

export function requireGoalChange(goal: SessionGoal, patch: SessionGoalPatch): Gate<SessionGoal> {
  return Object.keys(patch).length
    ? { value: goal }
    : refuse('nothing_to_update: name at least one field to change.');
}

export function requireJournalCursor(goal: SessionGoal, known: boolean): Gate<SessionGoal> {
  return known
    ? { value: goal }
    : refuse('cursor_not_found: before names no entry of this goal; list again without it.');
}

export function requireKnownOwner(owner: string, known: boolean): Gate<string> {
  return known ? { value: owner } : refuse(`owner_unknown: no session ${owner}.`);
}

export function requireExistingGoal(goal: SessionGoal | null): Gate<SessionGoal> {
  return goal ? { value: goal } : refuse('goal_not_found');
}

export function requireGoalDoneTest<T>(
  value: T,
  goal: { metrics?: Record<string, unknown>; doneTest?: string | null }
): Gate<T> {
  return goal.doneTest || Object.keys(goal.metrics ?? {}).length
    ? { value }
    : refuse('done_test_required: give the goal metrics or a written doneTest.');
}

function eventSource(caller: OperationCaller): SpaceGoalEventSource {
  return caller.source === 'mcp' ? 'neo' : 'human';
}

function patchOf(input: z.infer<typeof Update>): SessionGoalPatch {
  const { goalId: _goalId, ownerSessionId: _owner, ...patch } = input;
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as SessionGoalPatch;
}

export interface SessionGoalDependencies {
  readonly goals: SessionGoalRepository;
  readonly schedules: SessionGoalSchedules;
  readonly sessionExists: (sessionId: string) => boolean;
  readonly audit: (caller: OperationCaller, toolName: string, summary: object) => void;
}

export function createSessionGoalOperations({
  goals,
  schedules,
  sessionExists,
  audit,
}: SessionGoalDependencies) {
  const owner = (pipeline: PipelineAPI) =>
    pipeline
      .input(['input', 'caller'])
      .pipe(resolveGoalOwner, ['caller', 'input'], 'result:outcome')
      .pipe(
        (owned: string) => requireKnownOwner(owned, sessionExists(owned)),
        'outcome',
        'result:outcome'
      );
  const owned = (pipeline: PipelineAPI) =>
    owner(pipeline)
      .pipe((input: { goalId: string }) => goals.get(input.goalId), 'input', 'goal')
      .pipe(requireExistingGoal, 'goal', 'result:outcome');
  const done = (result: SessionGoal) => ({ accepted: true as const, goal: result });

  const create = owner(superpipe({})('goal.session.create') as PipelineAPI)
    .pipe(requireGoalDoneTest, ['outcome', 'input'], 'result:outcome')
    .pipe(
      (owned: string, input: z.infer<typeof Create>) => {
        const cadence = requireValidCadence(input.cadence);
        return 'reason' in cadence ? refuse(cadence.reason) : { value: owned };
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (owned: string, input: z.infer<typeof Create>, caller: OperationCaller) => {
        const { ownerSessionId: _owner, cadence, nudgeEvery, ...draft } = input;
        const goal = goals.create(owned, draft, eventSource(caller), Date.now(), (created) =>
          schedules.sync(created, cadence, nudgeEvery)
        );
        audit(caller, 'goal.session.create', { goalId: goal.id, ownerSessionId: owned });
        return done(goal);
      },
      ['outcome', 'input', 'caller'],
      'outcome'
    )
    .endAsync('outcome');

  const get = owned(superpipe({})('goal.session.get') as PipelineAPI)
    .pipe(done, 'outcome', 'outcome')
    .endAsync('outcome');

  const list = owner(superpipe({})('goal.session.list') as PipelineAPI)
    .pipe(
      (owned: string, input: z.infer<typeof List>) => ({
        accepted: true as const,
        goals: goals.list(owned, input.includeClosed),
      }),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome');

  const update = owned(superpipe({})('goal.session.update') as PipelineAPI)
    .pipe(
      (goal: SessionGoal, input: z.infer<typeof Update>) => requireGoalChange(goal, patchOf(input)),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (goal: SessionGoal, input: z.infer<typeof Update>) =>
        requireGoalDoneTest(goal, { ...goal, ...patchOf(input) }),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (goal: SessionGoal, input: z.infer<typeof Update>, caller: OperationCaller) => {
        const patch = patchOf(input);
        audit(caller, 'goal.session.update', { goalId: goal.id, fields: Object.keys(patch) });
        return done(
          goals.update(goal, patch, eventSource(caller), Date.now(), (updated) => {
            if (patch.status) schedules.sync(updated);
          })
        );
      },
      ['outcome', 'input', 'caller'],
      'outcome'
    )
    .endAsync('outcome');

  const append = owned(superpipe({})('goal.journal.append') as PipelineAPI)
    .pipe(
      (goal: SessionGoal, input: z.infer<typeof Append>, caller: OperationCaller) => {
        const { goalId: _goalId, ownerSessionId: _owner, ...draft } = input;
        audit(caller, 'goal.journal.append', { goalId: goal.id, runId: input.runId ?? null });
        return {
          accepted: true as const,
          entry: goals.appendJournal(
            goal.id,
            caller.sessionId ?? null,
            draft as GoalJournalDraft,
            Date.now()
          ),
        };
      },
      ['outcome', 'input', 'caller'],
      'outcome'
    )
    .endAsync('outcome');

  const journal = owned(superpipe({})('goal.journal.list') as PipelineAPI)
    .pipe(
      (goal: SessionGoal, input: z.infer<typeof Journal>) =>
        requireJournalCursor(
          goal,
          !input.before || goals.journalEntry(goal.id, { id: input.before }) !== null
        ),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (goal: SessionGoal, input: z.infer<typeof Journal>) => ({
        accepted: true as const,
        entries: goals.listJournal(goal.id, input.before ?? null, input.limit),
      }),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome');

  const facts = owned(superpipe({})('goal.facts') as PipelineAPI)
    .pipe(
      async (goal: SessionGoal) => {
        const read = await schedules.facts(goal.id);
        return {
          accepted: true as const,
          facts: read ? { digest: read.digest, summary: read.summary, lines: read.lines } : null,
        };
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome');

  type Run = (input: unknown, caller: OperationCaller) => Promise<unknown>;
  return [
    defineOperation({
      name: 'goal.session.create',
      description:
        'Create a goal owned by a session (root Neo), with one fact-driven wake schedule. Give metrics or a written doneTest. cadence defaults to hourly. Unchanged facts stay quiet and back off; nudgeEvery is accepted for legacy compatibility only and never forces a turn. Returns { accepted, goal } or { accepted: false, reason }.',
      policy: GOAL_WRITE_POLICY,
      inputSchema: Create,
      resultSchema: GoalResult,
      execute: async (input, caller) => (create as Run)(input, caller) as never,
    }),
    defineOperation({
      name: 'goal.session.get',
      description: 'Read one goal owned by a session.',
      policy: GOAL_READ_POLICY,
      inputSchema: Get,
      resultSchema: GoalResult,
      execute: async (input, caller) => (get as Run)(input, caller) as never,
    }),
    defineOperation({
      name: 'goal.session.list',
      description: 'List a session’s goals, active and paused unless includeClosed.',
      policy: GOAL_READ_POLICY,
      inputSchema: List,
      resultSchema: z.discriminatedUnion('accepted', [
        z.object({ accepted: z.literal(true), goals: z.array(GoalSchema) }),
        RejectionSchema,
      ]),
      execute: async (input, caller) => (list as Run)(input, caller) as never,
    }),
    defineOperation({
      name: 'goal.session.update',
      description:
        'Update a session-owned goal: fields, progress, next steps, mandate link, or status. Paused pauses its schedule, active resumes it, completed or archived removes it. worksNote summarizes the journal, advances its cursor and records journal_compacted without deleting entries. Each change is recorded as a goal event.',
      policy: GOAL_WRITE_POLICY,
      inputSchema: Update,
      resultSchema: GoalResult,
      execute: async (input, caller) => (update as Run)(input, caller) as never,
    }),
    defineOperation({
      name: 'goal.facts',
      description:
        'Read the same goal facts and changed-line summary as its scheduler, without consuming the changes. Closed goals return null facts.',
      policy: GOAL_READ_POLICY,
      inputSchema: Get,
      resultSchema: z.discriminatedUnion('accepted', [
        z.object({
          accepted: z.literal(true),
          facts: z
            .object({ digest: z.string(), summary: z.string(), lines: z.array(z.string()) })
            .nullable(),
        }),
        RejectionSchema,
      ]),
      execute: async (input, caller) => (facts as Run)(input, caller) as never,
    }),
    defineOperation({
      name: 'goal.journal.append',
      description:
        'Append one entry to a session goal’s journal at the end of a work cycle: what was done, its effect with evidence, what worked and what to stop. Pass the runId from the wake message.',
      policy: GOAL_WRITE_POLICY,
      inputSchema: Append,
      resultSchema: z.discriminatedUnion('accepted', [
        z.object({ accepted: z.literal(true), entry: EntrySchema }),
        RejectionSchema,
      ]),
      execute: async (input, caller) => (append as Run)(input, caller) as never,
    }),
    defineOperation({
      name: 'goal.journal.list',
      description: 'Read a session goal’s journal, newest first.',
      policy: GOAL_READ_POLICY,
      inputSchema: Journal,
      resultSchema: z.discriminatedUnion('accepted', [
        z.object({ accepted: z.literal(true), entries: z.array(EntrySchema) }),
        RejectionSchema,
      ]),
      execute: async (input, caller) => (journal as Run)(input, caller) as never,
    }),
  ];
}
