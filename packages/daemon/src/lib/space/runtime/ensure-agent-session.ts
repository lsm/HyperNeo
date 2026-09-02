import type { Space, SpaceWorkerAgent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  type AgentRecordResolution,
  type ResolveAgentRecordDeps,
  resolveAgentRecord,
} from '../../session-resolution/resolve-agent-record.ts';

export interface EnsuredSession {
  getSessionData(): { status: string };
}

export interface EnsureAgentSessionDeps {
  getSpace(spaceId: string): Promise<Space | null>;
  recordDeps: ResolveAgentRecordDeps;
  ensureCoordinatorSession(spaceId: string): Promise<EnsuredSession | null>;
  ensureLongHorizonAgentSession(spaceId: string, agentId: string): Promise<EnsuredSession | null>;
  ensureWorkerAgentSession(
    spaceId: string,
    agent: SpaceWorkerAgent
  ): Promise<EnsuredSession | null>;
}

const ensureHalted = (halt?: string): boolean => halt !== undefined;

export async function admitSpaceStage(
  deps: EnsureAgentSessionDeps,
  spaceId: string
): Promise<string | undefined> {
  const space = await deps.getSpace(spaceId).catch(() => null);
  return space !== null && !space.paused && !space.stopped && space.status !== 'archived'
    ? undefined
    : 'space_inactive';
}

export function classifyAgentStage(
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): { resolution: AgentRecordResolution | null; classifyHalt: string | undefined } {
  const resolution = resolveAgentRecord(spaceId, agentId, deps.recordDeps);
  if (resolution.kind === 'missing') {
    return { resolution: null, classifyHalt: 'agent_missing' };
  }
  if (
    resolution.kind === 'worker' &&
    (resolution.agent.status === 'paused' || resolution.agent.status === 'archived')
  ) {
    return { resolution: null, classifyHalt: 'agent_inactive' };
  }
  return { resolution, classifyHalt: undefined };
}

export async function provisionAgentSessionStage(
  resolution: AgentRecordResolution | null,
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): Promise<EnsuredSession | null> {
  if (resolution === null) return null;
  if (resolution.kind === 'coordinator') return deps.ensureCoordinatorSession(spaceId);
  if (resolution.kind === 'long_horizon') {
    return deps.ensureLongHorizonAgentSession(spaceId, agentId);
  }
  if (resolution.kind === 'worker') return deps.ensureWorkerAgentSession(spaceId, resolution.agent);
  return null;
}

export function gateEnsuredSessionStage(ensured: EnsuredSession | null): EnsuredSession | null {
  if (ensured === null) return null;
  const status = ensured.getSessionData().status;
  return status === 'ended' || status === 'archived' ? null : ensured;
}

const runEnsureAgentSessionPipeline = (
  superpipe({ ensureHalted })('ensure-agent-session') as PipelineAPI
)
  .input(['spaceId', 'agentId', 'deps'])
  .pipe(admitSpaceStage, ['deps', 'spaceId'], 'spaceHalt')
  .pipe('!ensureHalted', 'spaceHalt')
  .pipe(classifyAgentStage, ['spaceId', 'agentId', 'deps'], ['resolution', 'classifyHalt'])
  .pipe('!ensureHalted', 'classifyHalt')
  .pipe(provisionAgentSessionStage, ['resolution', 'spaceId', 'agentId', 'deps'], 'ensuredSession')
  .pipe(gateEnsuredSessionStage, 'ensuredSession', 'ensuredSession')
  .endAsync('ensuredSession');

export async function runEnsureAgentSession(
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): Promise<EnsuredSession | null> {
  return ((await runEnsureAgentSessionPipeline(spaceId, agentId, deps).catch(() => null)) ??
    null) as EnsuredSession | null;
}

export async function isAgentTargetLifecycleEligible(
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): Promise<boolean> {
  if ((await admitSpaceStage(deps, spaceId)) !== undefined) return false;
  return classifyAgentStage(spaceId, agentId, deps).resolution !== null;
}
