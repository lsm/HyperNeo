import type { AgentModelPoolEntry, SpaceAgent, UpdateSpaceAgentParams } from '@hyperneo/shared';
import superpipe, { type Dependencies, type PipelineAPI } from 'superpipe';
import { RESERVED_SPACE_AGENT_HANDLES, validateSlug } from '../slug.ts';
import {
  type BindableSession,
  type Gate,
  gateModel,
  gateModelPool,
  gateTools,
  rejectSpaceAgent as reject,
  type SpaceAgentRejection,
} from './create-space-agent-pipeline.ts';

export interface UpdateSpaceAgentInput extends UpdateSpaceAgentParams {
  id: string;
}

export interface UpdateSpaceAgentDeps extends Dependencies {
  getAgent(id: string): SpaceAgent | null;
  getSession(sessionId: string): BindableSession | null;
  sessionOwner(sessionId: string): string | null;
  listHandles(spaceId: string): string[];
  listDisplayNames(spaceId: string): string[];
  applyUpdate(id: string, changes: UpdateSpaceAgentParams): SpaceAgent | null;
  publishUpdated(agent: SpaceAgent): Promise<void>;
  validateTools(tools: string[]): string | null;
  validateModel(model: string, provider: string | null): Promise<string | null>;
  validateModelPool(pool: AgentModelPoolEntry[]): Promise<string | null>;
}

export interface AdmittedUpdate {
  agent: SpaceAgent;
  changes: UpdateSpaceAgentParams;
}

function isBlankString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() === '';
}

function isReservedHandle(handle: string): boolean {
  return (RESERVED_SPACE_AGENT_HANDLES as readonly string[]).includes(handle);
}

export function gateTarget(
  input: UpdateSpaceAgentInput,
  getAgent: UpdateSpaceAgentDeps['getAgent']
): Gate<AdmittedUpdate> {
  if (!input.id) return reject('invalid_request', 'id is required');
  const agent = getAgent(input.id);
  if (!agent) return reject('agent_not_found', `Agent not found: ${input.id}`);
  const { id: _id, ...changes } = input;
  return { value: { agent, changes } };
}

export function gateChanges(admitted: AdmittedUpdate): Gate<AdmittedUpdate> {
  const { changes } = admitted;
  if (isBlankString(changes.displayName)) {
    return reject('invalid_request', 'displayName cannot be blank');
  }
  if (isBlankString(changes.handle)) {
    return reject('invalid_request', 'handle cannot be blank');
  }
  if (isBlankString(changes.model)) {
    return reject('invalid_request', 'model cannot be blank — use null to clear it');
  }
  if (isBlankString(changes.provider)) {
    return reject('invalid_request', 'provider cannot be blank — use null to clear it');
  }
  return { value: admitted };
}

export function gateSessionChange(
  admitted: AdmittedUpdate,
  getSession: UpdateSpaceAgentDeps['getSession'],
  sessionOwner: UpdateSpaceAgentDeps['sessionOwner']
): Gate<AdmittedUpdate> {
  const sessionId = admitted.changes.sessionId;
  if (sessionId === undefined || sessionId === null) return { value: admitted };
  if (sessionId === admitted.agent.sessionId) return { value: admitted };

  const session = getSession(sessionId);
  if (!session) return reject('session_invalid', `Session not found: ${sessionId}`);
  if (session.spaceId !== admitted.agent.spaceId) {
    return reject(
      'session_invalid',
      `Session ${sessionId} does not belong to space ${admitted.agent.spaceId}`
    );
  }
  if (session.type === 'space_task_agent') {
    return reject('session_invalid', 'Task agent sessions cannot be bound to a space agent');
  }

  const owner = sessionOwner(sessionId);
  if (owner && owner !== admitted.agent.id) {
    return reject('session_taken', `Session ${sessionId} is already bound to agent ${owner}`);
  }
  return { value: admitted };
}

export function gateIdentityChange(
  admitted: AdmittedUpdate,
  listHandles: UpdateSpaceAgentDeps['listHandles'],
  listDisplayNames: UpdateSpaceAgentDeps['listDisplayNames']
): Gate<AdmittedUpdate> {
  const { agent, changes } = admitted;

  if (changes.handle !== undefined && changes.handle !== agent.handle) {
    const slugError = validateSlug(changes.handle);
    if (slugError) return reject('invalid_identity', slugError);
    if (isReservedHandle(changes.handle)) {
      return reject('invalid_identity', `Handle "${changes.handle}" is reserved`);
    }
    const taken = listHandles(agent.spaceId).filter((handle) => handle !== agent.handle);
    if (taken.includes(changes.handle)) {
      return reject(
        'invalid_identity',
        `Handle "${changes.handle}" is already in use in this space`
      );
    }
  }

  if (changes.displayName !== undefined && changes.displayName !== agent.displayName) {
    const target = changes.displayName.trim().toLowerCase();
    const taken = listDisplayNames(agent.spaceId).filter(
      (name) => name.trim().toLowerCase() !== agent.displayName.trim().toLowerCase()
    );
    if (taken.some((name) => name.trim().toLowerCase() === target)) {
      return reject(
        'invalid_identity',
        `Agent name "${changes.displayName}" is already used by another agent in this space`
      );
    }
  }

  return { value: admitted };
}

export function gateUpdateTools(
  admitted: AdmittedUpdate,
  validateTools: UpdateSpaceAgentDeps['validateTools']
): Gate<AdmittedUpdate> {
  const outcome = gateTools(admitted.changes, validateTools);
  return 'reason' in outcome ? outcome : { value: admitted };
}

export async function gateUpdateModel(
  admitted: AdmittedUpdate,
  validateModel: UpdateSpaceAgentDeps['validateModel']
): Promise<Gate<AdmittedUpdate>> {
  const merged = {
    ...admitted.changes,
    provider: admitted.changes.provider ?? admitted.agent.provider,
  };
  const outcome = await gateModel(merged, validateModel);
  return 'reason' in outcome ? outcome : { value: admitted };
}

export async function gateUpdateModelPool(
  admitted: AdmittedUpdate,
  validateModelPool: UpdateSpaceAgentDeps['validateModelPool']
): Promise<Gate<AdmittedUpdate>> {
  const outcome = await gateModelPool(admitted.changes, validateModelPool);
  return 'reason' in outcome ? outcome : { value: admitted };
}

export function applyUpdate(
  admitted: AdmittedUpdate,
  apply: UpdateSpaceAgentDeps['applyUpdate']
): Gate<SpaceAgent> {
  try {
    const updated = apply(admitted.agent.id, admitted.changes);
    if (!updated) {
      return reject('agent_not_found', `Agent not found: ${admitted.agent.id}`);
    }
    return { value: updated };
  } catch (error) {
    const collision = classifyUpdateCollision(error);
    if (collision) return collision;
    throw error;
  }
}

function classifyUpdateCollision(error: unknown): { reason: SpaceAgentRejection } | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('is already bound to agent')) return reject('session_taken', message);
  if (/UNIQUE constraint failed.*handle/i.test(message)) {
    return reject('invalid_identity', message);
  }
  if (message.includes('migrated worker mirror')) {
    return reject('invalid_request', message);
  }
  return null;
}

export async function publishUpdated(
  agent: SpaceAgent,
  publish: UpdateSpaceAgentDeps['publishUpdated']
): Promise<SpaceAgent> {
  await publish(agent);
  return agent;
}

export function buildUpdateSpaceAgentPipeline(
  deps: UpdateSpaceAgentDeps
): (input: UpdateSpaceAgentInput) => Promise<SpaceAgent | SpaceAgentRejection> {
  return (superpipe(deps)('updateSpaceAgent') as PipelineAPI)
    .input(['input'])
    .pipe(gateTarget, ['input', 'getAgent'], 'result:admitted')
    .pipe(gateChanges, 'admitted', 'result:admitted')
    .pipe(gateSessionChange, ['admitted', 'getSession', 'sessionOwner'], 'result:admitted')
    .pipe(gateIdentityChange, ['admitted', 'listHandles', 'listDisplayNames'], 'result:admitted')
    .pipe(gateUpdateTools, ['admitted', 'validateTools'], 'result:admitted')
    .pipe(gateUpdateModel, ['admitted', 'validateModel'], 'result:admitted')
    .pipe(gateUpdateModelPool, ['admitted', 'validateModelPool'], 'result:admitted')
    .pipe(applyUpdate, ['admitted', 'applyUpdate'], 'result:admitted')
    .pipe(publishUpdated, ['admitted', 'publishUpdated'], 'admitted')
    .endAsync('admitted') as (
    input: UpdateSpaceAgentInput
  ) => Promise<SpaceAgent | SpaceAgentRejection>;
}
