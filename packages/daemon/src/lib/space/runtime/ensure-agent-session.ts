import type { Space, SpaceWorkerAgent as WorkerAgent } from '@hyperneo/shared';
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
  ensureLongHorizon(spaceId: string, agentId: string): Promise<EnsuredSession | null>;
  ensureWorkerAgentSession(spaceId: string, agent: WorkerAgent): Promise<EnsuredSession | null>;
}

export async function admitSpaceStage(
  deps: EnsureAgentSessionDeps,
  spaceId: string
): Promise<string | undefined> {
  const space = await deps.getSpace(spaceId).catch(() => null);
  if (!space || space.paused || space.stopped || space.status === 'archived')
    return 'space_inactive';
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
    ['paused', 'archived'].includes(resolution.agent.status ?? '')
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
  if (resolution === null || resolution.kind === 'missing') return null;
  if (resolution.kind === 'coordinator') return deps.ensureCoordinatorSession(spaceId);
  if (resolution.kind === 'long_horizon') return deps.ensureLongHorizon(spaceId, agentId);
  return deps.ensureWorkerAgentSession(spaceId, resolution.agent);
}

export async function gateEnsuredSessionStage(
  ensured: EnsuredSession | null,
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): Promise<{ ensuredSession: EnsuredSession | null }> {
  if ((await admitSpaceStage(deps, spaceId)) !== undefined) return { ensuredSession: null };
  if (classifyAgentStage(spaceId, agentId, deps).resolution === null) {
    return { ensuredSession: null };
  }
  if (['ended', 'archived'].includes(ensured?.getSessionData().status ?? ''))
    return { ensuredSession: null };
  return { ensuredSession: ensured };
}

const runEnsureAgentSessionPipeline = (
  superpipe({ ensureHalted: (halt?: string) => halt !== undefined })(
    'ensure-agent-session'
  ) as PipelineAPI
)
  .input(['spaceId', 'agentId', 'deps'])
  .pipe(admitSpaceStage, ['deps', 'spaceId'], 'spaceHalt')
  .pipe('!ensureHalted', 'spaceHalt')
  .pipe(classifyAgentStage, ['spaceId', 'agentId', 'deps'], ['resolution', 'classifyHalt'])
  .pipe('!ensureHalted', 'classifyHalt')
  .pipe(provisionAgentSessionStage, ['resolution', 'spaceId', 'agentId', 'deps'], 'ensuredSession')
  .pipe(gateEnsuredSessionStage, ['ensuredSession', 'spaceId', 'agentId', 'deps'], '{...}')
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
  try {
    return classifyAgentStage(spaceId, agentId, deps).resolution !== null;
  } catch {
    return false;
  }
}
