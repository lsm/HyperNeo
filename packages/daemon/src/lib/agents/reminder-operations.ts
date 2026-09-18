import type {
  CreateSpaceLongHorizonAgentReminderParams,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentReminder,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitAgentCaller,
  AGENT_MUTATE_POLICY,
  AGENT_READ_POLICY,
  AgentRejectionSchema,
  AgentSpaceScopeSchema,
  rejectAgent,
  type AgentOperationDeps,
  type AgentRejection,
} from './operation-contracts.ts';

const ReminderStateSchema = z.enum(['active', 'paused', 'done', 'cancelled']);

export const ReminderRecordSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    message: z.string(),
    body: z.string(),
    state: ReminderStateSchema,
    remindAt: z.number().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

type ReminderRecord = z.infer<typeof ReminderRecordSchema>;

const createInputSchema = AgentSpaceScopeSchema.extend({
  agentId: z.string().min(1).describe('Long-horizon agent ID'),
  message: z.string().min(1).describe('Reminder text delivered to the agent'),
  remindAt: z.number().int().describe('Delivery time, milliseconds since the epoch'),
}).strict();

const listInputSchema = AgentSpaceScopeSchema.extend({
  agentId: z.string().min(1).describe('Long-horizon agent ID'),
  state: ReminderStateSchema.optional().describe('Keep only reminders in this state'),
}).strict();

type CreateInput = z.infer<typeof createInputSchema>;
type ListInput = z.infer<typeof listInputSchema>;
type CreateResult = { reminder: ReminderRecord } | AgentRejection;
type ListResult = { reminders: ReminderRecord[] } | AgentRejection;
type Gate = { value: string } | { reason: AgentRejection };

export interface AgentReminderDependencies extends AgentOperationDeps {
  readonly getAgent: (agentId: string) => SpaceLongHorizonAgent | null;
  readonly createReminder: (
    params: CreateSpaceLongHorizonAgentReminderParams
  ) => SpaceLongHorizonAgentReminder;
  readonly listReminders: (agentId: string) => SpaceLongHorizonAgentReminder[];
  readonly audit: (
    operationName: string,
    summary: Record<string, unknown>,
    caller: OperationCaller,
    spaceId: string
  ) => void;
}

export function reminderRecord(reminder: SpaceLongHorizonAgentReminder): ReminderRecord {
  return {
    id: reminder.id,
    agentId: reminder.agentId,
    message: reminder.title,
    body: reminder.body,
    state: reminder.status === 'fired' ? 'done' : reminder.status,
    remindAt: reminder.runAt ?? reminder.nextRunAt ?? null,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
  };
}

export function gateReminderAgent(
  spaceId: string,
  input: { agentId: string },
  deps: AgentReminderDependencies
): Gate {
  return deps.getAgent(input.agentId)?.spaceId === spaceId
    ? { value: spaceId }
    : {
        reason: rejectAgent('agent_not_found', `Long-horizon agent not found: ${input.agentId}`),
      };
}

export function persistReminder(
  spaceId: string,
  input: CreateInput,
  caller: OperationCaller,
  deps: AgentReminderDependencies
): CreateResult {
  const reminder = deps.createReminder({
    spaceId,
    agentId: input.agentId,
    title: input.message,
    triggerType: 'at',
    runAt: input.remindAt,
    nextRunAt: input.remindAt,
    status: 'active',
    createdBySession: caller.sessionId ?? null,
  });
  deps.audit(
    'agent.reminders.create',
    { agentId: input.agentId, remindAt: input.remindAt },
    caller,
    spaceId
  );
  return { reminder: reminderRecord(reminder) };
}

export function selectReminders(
  _spaceId: string,
  input: ListInput,
  deps: AgentReminderDependencies
): ListResult {
  const dueTime = (reminder: ReminderRecord) => reminder.remindAt ?? 0;
  const reminders = deps
    .listReminders(input.agentId)
    .map(reminderRecord)
    .filter((reminder) => !input.state || reminder.state === input.state)
    .sort((left, right) => dueTime(left) - dueTime(right));
  return { reminders };
}

const SCOPE_DOC =
  'Human (RPC) callers pass spaceId; agent callers act in their own Space. Rejects agent_not_found when the agent belongs to another Space.';

const CREATE_DESCRIPTION = `Schedule a one-shot reminder delivered to a long-horizon agent at remindAt, a millisecond epoch timestamp, and return the created reminder. The reminder starts in the active state and moves to done once it fires. ${SCOPE_DOC} Admitted for ad-hoc members and long-term agents whose session is active in the owning Space. Read-only and worker sessions are refused by the operations door with forbidden before the call runs; an admitted role whose session is not active in that Space is rejected with agent_denied.`;

const LIST_DESCRIPTION = `List the reminders of a long-horizon agent, soonest due first, each with its message, state, and delivery time. Pass state to keep only reminders in that state: active, paused, done, or cancelled. ${SCOPE_DOC} Read access is admitted for ad-hoc members and long-term agents; other sessions are refused by the operations door with forbidden before the call runs.`;

export function createCreateAgentReminderOperation(deps: AgentReminderDependencies) {
  const access = 'mutate' as const;
  const create = (superpipe({ deps, access })('create-agent-reminder') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(gateReminderAgent, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(persistReminder, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (input: CreateInput, caller: OperationCaller) => Promise<CreateResult>;
  return defineOperation({
    name: 'agent.reminders.create',
    policy: { ...AGENT_MUTATE_POLICY, audit: { selfAudited: true } },
    description: CREATE_DESCRIPTION,
    inputSchema: createInputSchema,
    resultSchema: z.union([
      z.object({ reminder: ReminderRecordSchema }).strict(),
      AgentRejectionSchema,
    ]),
    execute: async (input, caller) => create(input, caller),
  });
}

export function createListAgentRemindersOperation(deps: AgentReminderDependencies) {
  const access = 'read' as const;
  const list = (superpipe({ deps, access })('list-agent-reminders') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(gateReminderAgent, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(selectReminders, ['outcome', 'input', 'deps'], 'outcome')
    .end('outcome') as (input: ListInput, caller: OperationCaller) => ListResult;
  return defineOperation({
    name: 'agent.reminders.list',
    policy: AGENT_READ_POLICY,
    description: LIST_DESCRIPTION,
    inputSchema: listInputSchema,
    resultSchema: z.union([
      z.object({ reminders: z.array(ReminderRecordSchema) }).strict(),
      AgentRejectionSchema,
    ]),
    execute: async (input, caller) => list(input, caller),
  });
}
