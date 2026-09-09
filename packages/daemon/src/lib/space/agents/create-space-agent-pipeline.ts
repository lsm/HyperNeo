import type {
  AgentModelPoolEntry,
  CreateSpaceAgentParams,
  SpaceAgent,
  SpaceAgentTemplate,
} from '@hyperneo/shared';
import superpipe, { type Dependencies, type PipelineAPI } from 'superpipe';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit, validateSlug } from '../slug.ts';

export interface CreateSpaceAgentInput extends Omit<CreateSpaceAgentParams, 'handle'> {
  handle?: string;
  templateKey?: string | null;
}

export interface CreateSpaceAgentDeps extends Dependencies {
  spaceExists(spaceId: string): Promise<boolean>;
  sessionOwner(sessionId: string): string | null;
  getSession(sessionId: string): BindableSession | null;
  getTemplate(key: string): SpaceAgentTemplate | null;
  listHandles(spaceId: string): string[];
  listDisplayNames(spaceId: string): string[];
  createAgent(params: CreateSpaceAgentParams): SpaceAgent;
  publishCreated(agent: SpaceAgent): Promise<void>;
  validateTools(tools: string[]): string | null;
  validateModel(model: string, provider: string | null): Promise<string | null>;
  validateModelPool(pool: AgentModelPoolEntry[]): Promise<string | null>;
}

export type CreateSpaceAgentRejectionKind =
  | 'invalid_request'
  | 'space_not_found'
  | 'session_invalid'
  | 'session_taken'
  | 'template_not_found'
  | 'invalid_identity'
  | 'invalid_config';

export interface BindableSession {
  type: string;
  spaceId: string | null;
}

export interface CreateSpaceAgentRejection {
  kind: CreateSpaceAgentRejectionKind;
  message: string;
}

export interface AdmittedRequest {
  request: CreateSpaceAgentInput;
}

export interface AdmittedTemplate extends AdmittedRequest {
  template: SpaceAgentTemplate | null;
}

export interface AdmittedIdentity extends AdmittedTemplate {
  handle: string;
  displayName: string;
}

type Gate<T> = { value: T } | { reason: CreateSpaceAgentRejection };

function reject(
  kind: CreateSpaceAgentRejectionKind,
  message: string
): { reason: CreateSpaceAgentRejection } {
  return { reason: { kind, message } };
}

function isReservedHandle(handle: string): boolean {
  return (RESERVED_SPACE_AGENT_HANDLES as readonly string[]).includes(handle);
}

export function gateRequest(request: CreateSpaceAgentInput): Gate<AdmittedRequest> {
  if (!request.spaceId) return reject('invalid_request', 'spaceId is required');
  if (request.displayName !== undefined && request.displayName.trim() === '') {
    return reject('invalid_request', 'displayName cannot be blank');
  }
  if (request.handle !== undefined && request.handle.trim() === '') {
    return reject('invalid_request', 'handle cannot be blank');
  }
  if (isBlankString(request.model)) {
    return reject('invalid_request', 'model cannot be blank — use null to clear it');
  }
  if (isBlankString(request.provider)) {
    return reject('invalid_request', 'provider cannot be blank — use null to clear it');
  }
  return { value: { request } };
}

function isBlankString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() === '';
}

export async function gateSpace(
  admitted: AdmittedRequest,
  spaceExists: CreateSpaceAgentDeps['spaceExists']
): Promise<Gate<AdmittedRequest>> {
  const { spaceId } = admitted.request;
  if (!(await spaceExists(spaceId))) {
    return reject('space_not_found', `Space not found: ${spaceId}`);
  }
  return { value: admitted };
}

export function gateSession(
  admitted: AdmittedRequest,
  sessionOwner: CreateSpaceAgentDeps['sessionOwner'],
  getSession: CreateSpaceAgentDeps['getSession']
): Gate<AdmittedRequest> {
  const { sessionId, spaceId } = admitted.request;
  if (!sessionId) return { value: admitted };

  const session = getSession(sessionId);
  if (!session) return reject('session_invalid', `Session not found: ${sessionId}`);
  if (session.spaceId !== spaceId) {
    return reject('session_invalid', `Session ${sessionId} does not belong to space ${spaceId}`);
  }
  if (session.type === 'space_task_agent') {
    return reject('session_invalid', 'Task agent sessions cannot be bound to a space agent');
  }

  const owner = sessionOwner(sessionId);
  if (owner) {
    return reject('session_taken', `Session ${sessionId} is already bound to agent ${owner}`);
  }
  return { value: admitted };
}

export function gateTemplate(
  admitted: AdmittedRequest,
  getTemplate: CreateSpaceAgentDeps['getTemplate']
): Gate<AdmittedTemplate> {
  const key = admitted.request.templateKey;
  if (!key) return { value: { ...admitted, template: null } };
  const template = getTemplate(key);
  if (!template) return reject('template_not_found', `Template not found: ${key}`);
  return { value: { ...admitted, template } };
}

export function gateIdentity(
  admitted: AdmittedTemplate,
  listHandles: CreateSpaceAgentDeps['listHandles'],
  listDisplayNames: CreateSpaceAgentDeps['listDisplayNames']
): Gate<AdmittedIdentity> {
  const { request, template } = admitted;
  const displayName = (request.displayName ?? template?.displayName ?? request.handle ?? '').trim();
  const handleSource = request.handle ?? template?.handle ?? displayName;
  if (!handleSource) return reject('invalid_identity', 'handle or displayName is required');

  const taken = listHandles(request.spaceId);
  const handle =
    request.handle ?? slugifyWithinLimit(handleSource, [...taken, ...RESERVED_SPACE_AGENT_HANDLES]);

  const slugError = validateSlug(handle);
  if (slugError) return reject('invalid_identity', slugError);
  if (isReservedHandle(handle)) {
    return reject('invalid_identity', `Handle "${handle}" is reserved`);
  }
  if (taken.includes(handle)) {
    return reject('invalid_identity', `Handle "${handle}" is already in use in this space`);
  }

  const resolvedName = displayName || handle;
  const nameTaken = listDisplayNames(request.spaceId).some(
    (name) => name.trim().toLowerCase() === resolvedName.trim().toLowerCase()
  );
  if (nameTaken) {
    return reject(
      'invalid_identity',
      `Agent name "${resolvedName}" is already used by another agent in this space`
    );
  }

  return { value: { ...admitted, handle, displayName: resolvedName } };
}

export function buildParams(admitted: AdmittedIdentity): CreateSpaceAgentParams {
  return templateToCreateParams(
    admitted.request,
    admitted.template,
    admitted.handle,
    admitted.displayName
  );
}

export function templateToCreateParams(
  input: CreateSpaceAgentInput,
  template: SpaceAgentTemplate | null,
  handle: string,
  displayName: string
): CreateSpaceAgentParams {
  const pick = <T>(explicit: T | undefined, fromTemplate: T | undefined, fallback: T): T => {
    if (explicit !== undefined) return explicit;
    if (fromTemplate !== undefined) return fromTemplate;
    return fallback;
  };

  return {
    id: input.id,
    spaceId: input.spaceId,
    handle,
    displayName,
    description: pick(input.description, template?.description, null),
    instructions: pick(input.instructions, template?.instructions, ''),
    status: input.status ?? 'active',
    sessionId: input.sessionId ?? null,
    autonomyLevel: pick(input.autonomyLevel, template?.suggestedAutonomyLevel, null),
    model: pick(input.model, template?.model, null),
    provider: pick(input.provider, template?.provider, null),
    modelPool: pick(input.modelPool, template?.modelPool, null),
    thinkingLevel: pick(input.thinkingLevel, template?.thinkingLevel, null),
    settingSources: pick(input.settingSources, template?.settingSources, null),
    tools: pick(input.tools, template?.tools, null),
  };
}

export function gateTools(
  params: CreateSpaceAgentParams,
  validateTools: CreateSpaceAgentDeps['validateTools']
): Gate<CreateSpaceAgentParams> {
  if (!params.tools || params.tools.length === 0) return { value: params };
  const error = validateTools(params.tools);
  return error ? reject('invalid_config', error) : { value: params };
}

export async function gateModel(
  params: CreateSpaceAgentParams,
  validateModel: CreateSpaceAgentDeps['validateModel']
): Promise<Gate<CreateSpaceAgentParams>> {
  if (!params.model) return { value: params };
  const error = await validateModel(params.model, params.provider ?? null);
  return error ? reject('invalid_config', error) : { value: params };
}

export async function gateModelPool(
  params: CreateSpaceAgentParams,
  validateModelPool: CreateSpaceAgentDeps['validateModelPool']
): Promise<Gate<CreateSpaceAgentParams>> {
  if (!params.modelPool || params.modelPool.length === 0) return { value: params };
  const error = await validateModelPool(params.modelPool);
  return error ? reject('invalid_config', error) : { value: params };
}

export function persistAgent(
  params: CreateSpaceAgentParams,
  createAgent: CreateSpaceAgentDeps['createAgent']
): Gate<SpaceAgent> {
  try {
    return { value: createAgent(params) };
  } catch (error) {
    const collision = classifyPersistenceCollision(error, params);
    if (collision) return collision;
    throw error;
  }
}

function classifyPersistenceCollision(
  error: unknown,
  params: CreateSpaceAgentParams
): { reason: CreateSpaceAgentRejection } | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('is already bound to agent')) {
    return reject('session_taken', message);
  }
  if (/UNIQUE constraint failed.*handle/i.test(message)) {
    return reject('invalid_identity', `Handle "${params.handle}" is already in use in this space`);
  }
  return null;
}

export async function publishCreated(
  agent: SpaceAgent,
  publish: CreateSpaceAgentDeps['publishCreated']
): Promise<SpaceAgent> {
  await publish(agent);
  return agent;
}

export function buildCreateSpaceAgentPipeline(
  deps: CreateSpaceAgentDeps
): (request: CreateSpaceAgentInput) => Promise<SpaceAgent | CreateSpaceAgentRejection> {
  return (superpipe(deps)('createSpaceAgent') as PipelineAPI)
    .input(['request'])
    .pipe(gateRequest, 'request', 'result:admitted')
    .pipe(gateSpace, ['admitted', 'spaceExists'], 'result:admitted')
    .pipe(gateSession, ['admitted', 'sessionOwner', 'getSession'], 'result:admitted')
    .pipe(gateTemplate, ['admitted', 'getTemplate'], 'result:admitted')
    .pipe(gateIdentity, ['admitted', 'listHandles', 'listDisplayNames'], 'result:admitted')
    .pipe(buildParams, 'admitted', 'admitted')
    .pipe(gateTools, ['admitted', 'validateTools'], 'result:admitted')
    .pipe(gateModel, ['admitted', 'validateModel'], 'result:admitted')
    .pipe(gateModelPool, ['admitted', 'validateModelPool'], 'result:admitted')
    .pipe(persistAgent, ['admitted', 'createAgent'], 'result:admitted')
    .pipe(publishCreated, ['admitted', 'publishCreated'], 'admitted')
    .endAsync('admitted') as (
    request: CreateSpaceAgentInput
  ) => Promise<SpaceAgent | CreateSpaceAgentRejection>;
}

export function isCreateSpaceAgentRejection(
  outcome: SpaceAgent | CreateSpaceAgentRejection
): outcome is CreateSpaceAgentRejection {
  return 'kind' in outcome;
}
