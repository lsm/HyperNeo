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
export const INACTIVITY_NAG_DELIVERY_TIMEOUT_MS = 30_000;
export const INACTIVITY_CLAIM_LEASE_MS = 5 * 60 * 1000;

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
  deliveryTimeoutMs?: number;
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
  if (value.length <= INACTIVITY_NAG_PROMPT_MAX_CHARS) return value;
  const codePoints = [...value];
  return `${codePoints.slice(0, INACTIVITY_NAG_PROMPT_MAX_CHARS - 1).join('')}…`;
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
    let claim = this.deps.claimRepo.getByAgent(spaceId, agentId);
    const staleBefore = Date.now() - INACTIVITY_CLAIM_LEASE_MS;
    if (
      claim !== null &&
      claim.state !== 'none' &&
      !claim.degraded &&
      claim.updatedAt <= staleBefore
    ) {
      this.deps.claimRepo.releaseStale(spaceId, agentId, staleBefore);
      claim = null;
    }
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
      decision.configRevision,
      boundInactivityNagPrompt(config.prompt)
    );
  }

  private async deliver(
    spaceId: string,
    agentId: string,
    claimKey: string,
    acquiredConfigRevision: number | null,
    prompt: string
  ): Promise<void> {
    const recheckAgent = this.deps.agentRepo.getById(agentId);
    const recheckConfig = this.deps.configRepo.getByAgent(spaceId, agentId);
    const recheckSession = this.deps.getSessionSnapshot(spaceId, agentId);
    if (
      recheckAgent === null ||
      recheckAgent.spaceId !== spaceId ||
      recheckConfig === null ||
      !recheckConfig.enabled ||
      recheckSession === null
    ) {
      this.applyOutcome(
        spaceId,
        agentId,
        claimKey,
        acquiredConfigRevision,
        'pre_admission_failure'
      );
      return;
    }
    const lastActivityAt = resolveLastActivityAt({
      latestConsumedMessageAt: recheckSession.latestConsumedMessageAt,
      sessionCreatedAt: recheckSession.sessionCreatedAt,
      agentCreatedAt: recheckAgent.createdAt,
    });
    const space = await this.deps.spaceManager.getSpace(spaceId);
    const currentClaim = this.deps.claimRepo.getByAgent(spaceId, agentId);
    if (
      currentClaim === null ||
      currentClaim.claimKey !== claimKey ||
      currentClaim.ownerToken !== this.deps.scannerToken ||
      currentClaim.configRevision !== acquiredConfigRevision
    ) {
      return;
    }
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
      claim: claimSnapshotForCore(currentClaim),
    });
    if (recheck.action !== 'nag') {
      this.applyOutcome(
        spaceId,
        agentId,
        claimKey,
        acquiredConfigRevision,
        'pre_admission_failure'
      );
      return;
    }
    let outcome: InactivityNagDeliveryOutcome;
    try {
      outcome = await this.deliverNagBounded({
        spaceId,
        agentId,
        prompt,
        idempotencyKey: claimKey,
      });
    } catch (err) {
      log.warn(
        `Inactivity nag delivery threw for agent "${agentId}" in space "${spaceId}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      outcome = 'terminal_failure';
    }
    this.applyOutcome(spaceId, agentId, claimKey, acquiredConfigRevision, outcome);
  }

  private async deliverNagBounded(args: {
    spaceId: string;
    agentId: string;
    prompt: string;
    idempotencyKey: string;
  }): Promise<InactivityNagDeliveryOutcome> {
    const timeoutMs = this.deps.deliveryTimeoutMs ?? INACTIVITY_NAG_DELIVERY_TIMEOUT_MS;
    if (timeoutMs <= 0) return this.deps.deliverNag(args);
    const delivery = this.deps.deliverNag(args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        delivery,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Inactivity nag delivery timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private applyOutcome(
    spaceId: string,
    agentId: string,
    claimKey: string,
    acquiredConfigRevision: number | null,
    outcome: InactivityNagDeliveryOutcome
  ): void {
    const stage = outcome === 'terminal_failure_after_consumption' ? 'terminal_failure' : outcome;
    const reset = decideNagWindowReset(stage, {
      consumed: outcome === 'terminal_failure_after_consumption',
    });
    this.deps.claimRepo.applyReset(
      spaceId,
      agentId,
      claimKey,
      this.deps.scannerToken,
      acquiredConfigRevision,
      {
        releaseClaim: reset.releaseClaim,
        markDegraded: reset.markDegraded,
        advanceAttemptGeneration: reset.advanceAttemptGeneration,
      }
    );
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
