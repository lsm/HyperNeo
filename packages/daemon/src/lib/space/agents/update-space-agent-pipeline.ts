import type { AgentModelPoolEntry, SpaceAgent, UpdateSpaceAgentParams } from '@hyperneo/shared';
import superpipe, { type Dependencies, type PipelineAPI } from 'superpipe';
import { RESERVED_SPACE_AGENT_HANDLES, validateSlug } from '../slug.ts';
import { firstAgentFieldError } from './agent-field-validation.ts';
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
  listDisplayNames(spaceId: string, excludeAgentId: string): string[];
  applyUpdate(id: string, changes: UpdateSpaceAgentParams): SpaceAgent | null;
  publishUpdated(agent: SpaceAgent): Promise<void>;
  applyRuntimeEffects(agent: SpaceAgent, input: UpdateSpaceAgentInput): Promise<void>;
  validateTools(tools: string[]): string | null;
  validateModel(model: string, provider: string | null): Promise<string | null>;
  validateModelPool(pool: AgentModelPoolEntry[]): Promise<string | null>;
}

export interface AdmittedUpdate {
  agent: SpaceAgent;
  changes: UpdateSpaceAgentParams;
}

const COORDINATOR_HANDLES = new Set(['space-manager', 'coordinator']);
const LOCKED_COORDINATOR_STATUSES = new Set(['paused', 'disabled', 'archived']);

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
  const fieldError = firstAgentFieldError(admitted.changes);
  if (fieldError) return reject('invalid_request', fieldError);
  return { value: admitted };
}

export function gateDefaultAgent(admitted: AdmittedUpdate): Gate<AdmittedUpdate> {
  const { agent, changes } = admitted;
  if (!COORDINATOR_HANDLES.has(agent.handle)) return { value: admitted };

  if (changes.handle !== undefined && changes.handle !== agent.handle) {
    return reject(
      'invalid_identity',
      'The Space Manager handle is locked; instructions, model, provider and tools stay editable'
    );
  }
  if (changes.status !== undefined && LOCKED_COORDINATOR_STATUSES.has(changes.status)) {
    return reject('invalid_request', 'The Space Manager cannot be paused, disabled or archived');
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

  const renaming = changes.displayName !== undefined && changes.displayName !== agent.displayName;
  const unarchiving =
    agent.status === 'archived' && changes.status !== undefined && changes.status !== 'archived';
  const nameToCheck = renaming ? changes.displayName : unarchiving ? agent.displayName : undefined;
  if (nameToCheck === undefined) return { value: admitted };

  const target = nameToCheck.trim().toLowerCase();
  const peers = listDisplayNames(agent.spaceId, agent.id);
  if (peers.some((name) => name.trim().toLowerCase() === target)) {
    return reject(
      'invalid_identity',
      `Agent name "${nameToCheck}" is already used by another agent in this space`
    );
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
  const { agent, changes } = admitted;
  const modelChanged = changes.model !== undefined;
  const providerChanged = changes.provider !== undefined;
  if (!modelChanged && !providerChanged) return { value: admitted };

  const effectiveModel = modelChanged ? changes.model : agent.model;
  const effectiveProvider = providerChanged ? changes.provider : agent.provider;
  const outcome = await gateModel(
    { model: effectiveModel, provider: effectiveProvider },
    validateModel
  );
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
  return null;
}

export async function runRuntimeEffects(
  agent: SpaceAgent,
  input: UpdateSpaceAgentInput,
  applyRuntimeEffects: UpdateSpaceAgentDeps['applyRuntimeEffects']
): Promise<SpaceAgent> {
  await applyRuntimeEffects(agent, input);
  return agent;
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
    .pipe(gateDefaultAgent, 'admitted', 'result:admitted')
    .pipe(gateSessionChange, ['admitted', 'getSession', 'sessionOwner'], 'result:admitted')
    .pipe(gateIdentityChange, ['admitted', 'listHandles', 'listDisplayNames'], 'result:admitted')
    .pipe(gateUpdateTools, ['admitted', 'validateTools'], 'result:admitted')
    .pipe(gateUpdateModel, ['admitted', 'validateModel'], 'result:admitted')
    .pipe(gateUpdateModelPool, ['admitted', 'validateModelPool'], 'result:admitted')
    .pipe(applyUpdate, ['admitted', 'applyUpdate'], 'result:admitted')
    .pipe(runRuntimeEffects, ['admitted', 'input', 'applyRuntimeEffects'], 'admitted')
    .pipe(publishUpdated, ['admitted', 'publishUpdated'], 'admitted')
    .endAsync('admitted') as (
    input: UpdateSpaceAgentInput
  ) => Promise<SpaceAgent | SpaceAgentRejection>;
}
