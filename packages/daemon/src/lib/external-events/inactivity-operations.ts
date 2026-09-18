import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfig,
  SpaceAgentInactivityConfigRepository,
} from '../../storage/repositories/space-agent-inactivity-repository.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationCallerRole,
  type OperationDefinition,
} from '../operations/registry.ts';
import {
  admitEventCallerSpace,
  callerSessionActiveIn,
  type EventCallerDependencies,
} from './operation-admission.ts';

export const DEFAULT_INACTIVITY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const INACTIVITY_ROLES: readonly OperationCallerRole[] = ['long_term_agent'];

const InactivityConfigSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  agentId: z.string(),
  enabled: z.boolean(),
  thresholdMs: z.number().nullable(),
  prompt: z.string().nullable(),
  configRevision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const targetFields = {
  spaceId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
};
const ReadInput = z.object(targetFields).strict();
const SetEnabledInput = z.object({ ...targetFields, enabled: z.boolean() }).strict();
const SetInput = z
  .object({
    ...targetFields,
    thresholdMs: z.number().int().positive().optional(),
    prompt: z.string().optional(),
  })
  .strict();

type Target = { spaceId?: string; agentId?: string };
type Rejection = 'caller_denied' | 'agent_unknown' | 'session_inactive';
interface Scope {
  spaceId: string;
  agentId: string;
}

export interface InactivityDependencies extends EventCallerDependencies {
  configRepo: Pick<SpaceAgentInactivityConfigRepository, 'getByAgent' | 'setEnabled' | 'upsert'>;
  claimRepo: Pick<SpaceAgentInactivityClaimRepository, 'getByAgent' | 'clearDegraded'>;
  runNow: (spaceId: string, agentId: string) => Promise<void>;
}

export function admitInactivityCaller(
  input: Target,
  caller: OperationCaller,
  agents: InactivityDependencies
): { value: Scope } | { reason: Rejection } {
  const space = admitEventCallerSpace(input, caller, INACTIVITY_ROLES);
  if ('reason' in space) return { reason: 'caller_denied' };
  const agentId = caller.source === 'mcp' ? caller.agentId : input.agentId;
  if (!agentId) return { reason: 'caller_denied' };
  if (caller.source === 'mcp' && input.agentId !== undefined && input.agentId !== agentId) {
    return { reason: 'caller_denied' };
  }
  const agent = agents.longHorizonAgentRepo.getById(agentId);
  if (!agent || agent.spaceId !== space.value) return { reason: 'agent_unknown' };
  return { value: { spaceId: space.value, agentId } };
}

export function admitInactivityWriter(
  scope: Scope,
  caller: OperationCaller,
  agents: InactivityDependencies
): { value: Scope } | { reason: Rejection } {
  return callerSessionActiveIn(caller, scope.spaceId, agents)
    ? { value: scope }
    : { reason: 'session_inactive' };
}

function readConfig(scope: Scope, _input: unknown, agents: InactivityDependencies) {
  return {
    config: agents.configRepo.getByAgent(scope.spaceId, scope.agentId),
    degraded: agents.claimRepo.getByAgent(scope.spaceId, scope.agentId)?.degraded ?? false,
  };
}

function applyEnabled(
  scope: Scope,
  input: z.infer<typeof SetEnabledInput>,
  agents: InactivityDependencies
): SpaceAgentInactivityConfig {
  const config = agents.configRepo.setEnabled(scope.spaceId, scope.agentId, input.enabled);
  if (!input.enabled) return config;
  agents.claimRepo.clearDegraded(scope.spaceId, scope.agentId);
  return config.thresholdMs === null
    ? agents.configRepo.upsert({
        spaceId: scope.spaceId,
        agentId: scope.agentId,
        thresholdMs: DEFAULT_INACTIVITY_THRESHOLD_MS,
      })
    : config;
}

function applyConfig(
  scope: Scope,
  input: z.infer<typeof SetInput>,
  agents: InactivityDependencies
): SpaceAgentInactivityConfig {
  return agents.configRepo.upsert({
    spaceId: scope.spaceId,
    agentId: scope.agentId,
    thresholdMs: input.thresholdMs,
    prompt: input.prompt,
  });
}

async function runScanNow(scope: Scope, _input: unknown, agents: InactivityDependencies) {
  await agents.runNow(scope.spaceId, scope.agentId);
  return { started: true as const };
}

const REJECTIONS = z.enum(['caller_denied', 'agent_unknown', 'session_inactive']);

function readPipeline<Result>(
  name: string,
  agents: InactivityDependencies,
  apply: (scope: Scope, input: never, agents: InactivityDependencies) => Result | Promise<Result>
) {
  return (superpipe({ agents })(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitInactivityCaller, ['input', 'caller', 'agents'], 'result:outcome')
    .pipe(apply, ['outcome', 'input', 'agents'], 'outcome')
    .endAsync('outcome') as (
    input: unknown,
    caller: OperationCaller
  ) => Promise<Result | Rejection>;
}

function writePipeline<Result>(
  name: string,
  agents: InactivityDependencies,
  apply: (scope: Scope, input: never, agents: InactivityDependencies) => Result | Promise<Result>
) {
  return (superpipe({ agents })(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitInactivityCaller, ['input', 'caller', 'agents'], 'result:outcome')
    .pipe(admitInactivityWriter, ['outcome', 'caller', 'agents'], 'result:outcome')
    .pipe(apply, ['outcome', 'input', 'agents'], 'outcome')
    .endAsync('outcome') as (
    input: unknown,
    caller: OperationCaller
  ) => Promise<Result | Rejection>;
}

const SCOPE_DOC =
  'The watchdog is per long-term agent: an MCP caller always addresses its own agent in its own Space, and an RPC caller names spaceId and agentId explicitly. Rejects caller_denied when the caller is not an admitted long-term agent or names another agent, agent_unknown when the agent is not registered in that Space';

export function createInactivityOperations(agents: InactivityDependencies): OperationDefinition[] {
  return [
    defineOperation({
      name: 'inactivity.config.get',
      policy: { safetyClass: 'read', roles: INACTIVITY_ROLES },
      description: `Read an agent inactivity watchdog configuration (enabled, idle threshold, nag prompt) and whether its claim is degraded. ${SCOPE_DOC}.`,
      inputSchema: ReadInput,
      resultSchema: z.union([
        z.object({ config: InactivityConfigSchema.nullable(), degraded: z.boolean() }),
        REJECTIONS,
      ]),
      execute: readPipeline('inactivity-config-get', agents, readConfig),
    }),
    defineOperation({
      name: 'inactivity.config.setEnabled',
      policy: { safetyClass: 'mutate', roles: INACTIVITY_ROLES },
      description: `Enable, pause, or resume an agent inactivity watchdog. Pausing keeps the threshold and prompt but stops new nags until resumed; resuming clears the degraded flag and restores the default threshold when none is set. ${SCOPE_DOC}, and session_inactive when the calling MCP session is not active in that Space.`,
      inputSchema: SetEnabledInput,
      resultSchema: z.union([InactivityConfigSchema, REJECTIONS]),
      execute: writePipeline('inactivity-config-set-enabled', agents, applyEnabled),
    }),
    defineOperation({
      name: 'inactivity.config.set',
      policy: { safetyClass: 'mutate', roles: INACTIVITY_ROLES },
      description: `Adjust an agent inactivity watchdog threshold (ms of idleness before a nag) or nag prompt; an empty prompt clears it. Changing either bumps the config revision so a pending nag revalidates against the new settings. ${SCOPE_DOC}, and session_inactive when the calling MCP session is not active in that Space.`,
      inputSchema: SetInput,
      resultSchema: z.union([InactivityConfigSchema, REJECTIONS]),
      execute: writePipeline('inactivity-config-set', agents, applyConfig),
    }),
    defineOperation({
      name: 'inactivity.runNow',
      policy: { safetyClass: 'mutate', roles: INACTIVITY_ROLES },
      description: `Run an agent inactivity watchdog scan immediately, through the same admission gates as the periodic scan. The scan is scheduled in the background, so this returns as soon as it is started. ${SCOPE_DOC}, and session_inactive when the calling MCP session is not active in that Space.`,
      inputSchema: ReadInput,
      resultSchema: z.union([z.object({ started: z.literal(true) }), REJECTIONS]),
      execute: writePipeline('inactivity-run-now', agents, runScanNow),
    }),
  ];
}
