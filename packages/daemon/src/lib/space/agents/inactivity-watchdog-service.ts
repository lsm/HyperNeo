import { Logger } from '../../logger';
import type { SpaceManager } from '../managers/space-manager';
import type {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
  SpaceAgentInactivityClaim,
} from '../../../storage/repositories/space-agent-inactivity-repository';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository';
import {
  decideInactivityNag,
  decideNagWindowReset,
  resolveLastActivityAt,
} from './inactivity-watchdog-gates';

const log = new Logger('inactivity-watchdog');

export const INACTIVITY_NAG_PROMPT_MAX_CHARS = 4000;

export const DEFAULT_INACTIVITY_NAG_PROMPT =
  'You have been idle for a while. Check your goals, reminders, and pending reviews; if nothing needs you, say so briefly and stand by.';

export type InactivityNagDeliveryOutcome =
  | 'consumed'
  | 'accepted'
  | 'terminal_failure'
  | 'terminal_failure_after_consumption'
  | 'pre_admission_failure';

export interface InactivityWatchdogSessionSnapshot {
  latestConsumedMessageAt: number | null;
  sessionCreatedAt: number | null;
  busyWithOtherWork: boolean;
  pendingOtherAcceptedDelivery: boolean;
}

export interface InactivityWatchdogDeps {
  configRepo: SpaceAgentInactivityConfigRepository;
  claimRepo: SpaceAgentInactivityClaimRepository;
  agentRepo: Pick<SpaceLongHorizonAgentRepository, 'getById' | 'listBySpaceId'>;
  spaceManager: Pick<SpaceManager, 'getSpace'>;
  scannerToken: string;
  now?: () => number;
  getSessionSnapshot(spaceId: string, agentId: string): InactivityWatchdogSessionSnapshot | null;
  deliverNag(args: {
    spaceId: string;
    agentId: string;
    prompt: string;
    idempotencyKey: string;
  }): Promise<InactivityNagDeliveryOutcome>;
}

export function boundInactivityNagPrompt(prompt: string | null): string {
  const trimmed = (prompt ?? '').trim();
  const value = trimmed.length > 0 ? trimmed : DEFAULT_INACTIVITY_NAG_PROMPT;
  return value.length > INACTIVITY_NAG_PROMPT_MAX_CHARS
    ? `${value.slice(0, INACTIVITY_NAG_PROMPT_MAX_CHARS - 1)}…`
    : value;
}

export class SpaceAgentInactivityWatchdogService {
  constructor(private readonly deps: InactivityWatchdogDeps) {}

  async scanSpace(spaceId: string): Promise<void> {
    const space = await this.deps.spaceManager.getSpace(spaceId);
    if (!space || space.status !== 'active' || space.paused || space.stopped) return;
    for (const config of this.deps.configRepo.listEnabled(spaceId)) {
      try {
        await this.scanAgent(spaceId, config.agentId);
      } catch (err) {
        log.warn(
          `Inactivity watchdog scan failed for agent "${config.agentId}" in space "${spaceId}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  async scanAgent(spaceId: string, agentId: string): Promise<void> {
    const config = this.deps.configRepo.getByAgent(spaceId, agentId);
    if (config === null || !config.enabled) return;
    const agent = this.deps.agentRepo.getById(agentId);
    if (agent === null || agent.spaceId !== spaceId) return;
    const session = this.deps.getSessionSnapshot(spaceId, agentId);
    if (session === null) return;
    const lastActivityAt = resolveLastActivityAt({
      latestConsumedMessageAt: session.latestConsumedMessageAt,
      sessionCreatedAt: session.sessionCreatedAt,
      agentCreatedAt: agent.createdAt,
    });
    if (lastActivityAt === null) return;
    const space = await this.deps.spaceManager.getSpace(spaceId);
    const claim = this.deps.claimRepo.getByAgent(spaceId, agentId);
    const decision = decideInactivityNag({
      now: this.deps.now?.() ?? Date.now(),
      enabled: config.enabled,
      thresholdMs: config.thresholdMs,
      configRevision: config.configRevision,
      agentId,
      callerToken: this.deps.scannerToken,
      admissionRecheck: false,
      actor: {
        agentStatus: agent.status,
        spaceWakeable:
          space !== null && space.status === 'active' && !space.paused && !space.stopped,
        busyWithOtherWork: session.busyWithOtherWork,
        pendingOtherAcceptedDelivery: session.pendingOtherAcceptedDelivery,
        lastActivityAt,
      },
      claim: claim === null ? null : claimSnapshotForCore(claim),
    });
    if (decision.action !== 'nag') return;
    const acquired = this.deps.claimRepo.acquire({
      spaceId,
      agentId,
      claimKey: decision.claimKey,
      windowAnchoredAt: decision.windowAnchoredAt,
      attemptGeneration: decision.attemptGeneration,
      ownerToken: this.deps.scannerToken,
      configRevision: decision.configRevision,
    });
    if (!acquired.acquired) return;
    this.deps.claimRepo.markInFlight(spaceId, agentId, decision.claimKey);
    await this.deliver(
      spaceId,
      agentId,
      decision.claimKey,
      boundInactivityNagPrompt(config.prompt)
    );
  }

  private async deliver(
    spaceId: string,
    agentId: string,
    claimKey: string,
    prompt: string
  ): Promise<void> {
    const recheckAgent = this.deps.agentRepo.getById(agentId);
    const recheckConfig = this.deps.configRepo.getByAgent(spaceId, agentId);
    const recheckSession = this.deps.getSessionSnapshot(spaceId, agentId);
    const recheckClaim = this.deps.claimRepo.getByAgent(spaceId, agentId);
    if (
      recheckAgent === null ||
      recheckAgent.spaceId !== spaceId ||
      recheckConfig === null ||
      !recheckConfig.enabled ||
      recheckSession === null
    ) {
      this.applyOutcome(spaceId, agentId, claimKey, 'pre_admission_failure');
      return;
    }
    const lastActivityAt = resolveLastActivityAt({
      latestConsumedMessageAt: recheckSession.latestConsumedMessageAt,
      sessionCreatedAt: recheckSession.sessionCreatedAt,
      agentCreatedAt: recheckAgent.createdAt,
    });
    const space = await this.deps.spaceManager.getSpace(spaceId);
    const recheck = decideInactivityNag({
      now: this.deps.now?.() ?? Date.now(),
      enabled: recheckConfig.enabled,
      thresholdMs: recheckConfig.thresholdMs,
      configRevision: recheckConfig.configRevision,
      agentId,
      callerToken: this.deps.scannerToken,
      admissionRecheck: true,
      actor: {
        agentStatus: recheckAgent.status,
        spaceWakeable:
          space !== null && space.status === 'active' && !space.paused && !space.stopped,
        busyWithOtherWork: recheckSession.busyWithOtherWork,
        pendingOtherAcceptedDelivery: recheckSession.pendingOtherAcceptedDelivery,
        lastActivityAt: lastActivityAt ?? 0,
      },
      claim: recheckClaim === null ? null : claimSnapshotForCore(recheckClaim),
    });
    if (recheck.action !== 'nag') {
      this.applyOutcome(spaceId, agentId, claimKey, 'pre_admission_failure');
      return;
    }
    let outcome: InactivityNagDeliveryOutcome;
    try {
      outcome = await this.deps.deliverNag({ spaceId, agentId, prompt, idempotencyKey: claimKey });
    } catch (err) {
      log.warn(
        `Inactivity nag delivery threw for agent "${agentId}" in space "${spaceId}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      outcome = 'terminal_failure';
    }
    this.applyOutcome(spaceId, agentId, claimKey, outcome);
  }

  private applyOutcome(
    spaceId: string,
    agentId: string,
    claimKey: string,
    outcome: InactivityNagDeliveryOutcome
  ): void {
    const stage = outcome === 'terminal_failure_after_consumption' ? 'terminal_failure' : outcome;
    const reset = decideNagWindowReset(stage, {
      consumed: outcome === 'terminal_failure_after_consumption',
    });
    this.deps.claimRepo.applyReset(spaceId, agentId, claimKey, this.deps.scannerToken, {
      releaseClaim: reset.releaseClaim,
      markDegraded: reset.markDegraded,
      advanceAttemptGeneration: reset.advanceAttemptGeneration,
    });
  }
}

function claimSnapshotForCore(claim: SpaceAgentInactivityClaim) {
  return {
    state: claim.state,
    windowAnchoredAt: claim.windowAnchoredAt,
    attemptGeneration: claim.attemptGeneration,
    ownerToken: claim.ownerToken,
    configRevision: claim.configRevision,
    degraded: claim.degraded,
  };
}
