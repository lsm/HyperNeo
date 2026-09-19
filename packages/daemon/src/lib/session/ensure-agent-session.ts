import type { Space } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  type AgentRecordResolution,
  type ResolveAgentRecordDeps,
  resolveAgentRecord,
} from '../session-resolution/resolve-agent-record.ts';

export interface EnsuredSession {
  getSessionData(): { status: string };
}

export type EnsureAgentSessionReason = 'space_inactive' | 'agent_missing' | 'session_unavailable';
export type EnsureAgentSessionOutcome = EnsuredSession | EnsureAgentSessionReason;

export interface EnsureAgentSessionDeps {
  getSpace(spaceId: string): Promise<Space | null>;
  recordDeps: ResolveAgentRecordDeps;
  ensureLongHorizon(spaceId: string, agentId: string): Promise<EnsuredSession | null>;
}

function readSpaceStage(deps: EnsureAgentSessionDeps, spaceId: string): Promise<Space | null> {
  return deps.getSpace(spaceId);
}

export function admitSpaceStage(
  space: Space | null
): { value: Space } | { reason: 'space_inactive' } {
  return !space || space.paused || space.stopped || space.status === 'archived'
    ? { reason: 'space_inactive' }
    : { value: space };
}

function classifyAgentStage(
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): AgentRecordResolution {
  return resolveAgentRecord(spaceId, agentId, deps.recordDeps);
}

export function admitAgentStage(
  resolution: AgentRecordResolution
): { value: Exclude<AgentRecordResolution, { kind: 'missing' }> } | { reason: 'agent_missing' } {
  return resolution.kind === 'missing' ? { reason: 'agent_missing' } : { value: resolution };
}

function provisionAgentSessionStage(
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): Promise<EnsuredSession | null> {
  return deps.ensureLongHorizon(spaceId, agentId);
}

export function gateEnsuredSessionStage(
  ensured: EnsuredSession | null
): { value: EnsuredSession } | { reason: 'session_unavailable' } {
  return !ensured || ['ended', 'archived'].includes(ensured.getSessionData().status)
    ? { reason: 'session_unavailable' }
    : { value: ensured };
}

const runEnsureAgentSessionPipeline = (superpipe({})('ensure-agent-session') as PipelineAPI)
  .input(['spaceId', 'agentId', 'deps'])
  .pipe(readSpaceStage, ['deps', 'spaceId'], 'space')
  .pipe(admitSpaceStage, 'space', 'result:outcome')
  .pipe(classifyAgentStage, ['spaceId', 'agentId', 'deps'], 'resolution')
  .pipe(admitAgentStage, 'resolution', 'result:outcome')
  .pipe(provisionAgentSessionStage, ['spaceId', 'agentId', 'deps'], 'ensuredSession')
  .pipe(readSpaceStage, ['deps', 'spaceId'], 'space')
  .pipe(admitSpaceStage, 'space', 'result:outcome')
  .pipe(classifyAgentStage, ['spaceId', 'agentId', 'deps'], 'resolution')
  .pipe(admitAgentStage, 'resolution', 'result:outcome')
  .pipe(gateEnsuredSessionStage, 'ensuredSession', 'result:outcome')
  .endAsync('outcome') as (
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
) => Promise<EnsureAgentSessionOutcome>;

export async function runEnsureAgentSession(
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): Promise<EnsureAgentSessionOutcome> {
  return runEnsureAgentSessionPipeline(spaceId, agentId, deps);
}

const runAgentEligibility = (superpipe({})('agent-target-lifecycle-eligibility') as PipelineAPI)
  .input(['spaceId', 'agentId', 'deps'])
  .pipe(readSpaceStage, ['deps', 'spaceId'], 'space')
  .pipe(admitSpaceStage, 'space', 'result:outcome')
  .pipe(classifyAgentStage, ['spaceId', 'agentId', 'deps'], 'resolution')
  .pipe(admitAgentStage, 'resolution', 'result:outcome')
  .endAsync('outcome') as (
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
) => Promise<AgentRecordResolution | EnsureAgentSessionReason>;

export async function isAgentTargetLifecycleEligible(
  spaceId: string,
  agentId: string,
  deps: EnsureAgentSessionDeps
): Promise<boolean> {
  return typeof (await runAgentEligibility(spaceId, agentId, deps)) !== 'string';
}
