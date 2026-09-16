import { Logger } from '../logger';
import { reconcileInactivityClaim } from './inactivity-claim-reconciliation';
import type {
  InactivityNagDeliveryOutcome,
  InactivityWatchdogDeps,
} from './inactivity-watchdog-contracts';
import {
  applyRunNowBaseline,
  boundInactivityNagPrompt,
  claimSnapshotForCore,
  INACTIVITY_NAG_DELIVERY_TIMEOUT_MS,
} from './inactivity-watchdog-contracts';
import {
  decideInactivityNag,
  decideNagWindowReset,
  resolveLastActivityAt,
} from './inactivity-watchdog-gates';

export type {
  InactivityNagDeliveryOutcome,
  InactivityWatchdogDeps,
  InactivityWatchdogSessionSnapshot,
} from './inactivity-watchdog-contracts';
export {
  boundInactivityNagPrompt,
  DEFAULT_INACTIVITY_NAG_PROMPT,
  INACTIVITY_NAG_PROMPT_MAX_CHARS,
} from './inactivity-watchdog-contracts';

const log = new Logger('inactivity-watchdog');

export class SpaceAgentInactivityWatchdogService {
  constructor(private readonly deps: InactivityWatchdogDeps) {}

  async scanSpace(spaceId: string): Promise<void> {
    const space = await this.deps.spaceManager.getSpace(spaceId);
    if (!space || space.status !== 'active' || space.paused || space.stopped) return;
    for (const config of this.deps.configRepo.listEnabled(spaceId)) {
      if (this.deps.shouldAbort?.()) return;
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

  async scanAgent(
    spaceId: string,
    agentId: string,
    activityBaseline?: number,
    invokedAt?: number,
    invokingUserMsgAt?: number | null
  ): Promise<void> {
    const config = this.deps.configRepo.getByAgent(spaceId, agentId);
    if (config === null || !config.enabled) return;
    const agent = this.deps.agentRepo.getById(agentId);
    if (agent === null || agent.spaceId !== spaceId) return;
    const session = this.deps.getSessionSnapshot(spaceId, agentId);
    if (session === null) return;
    const snapshotActivity = resolveLastActivityAt({
      latestConsumedMessageAt: session.latestConsumedMessageAt,
      sessionCreatedAt: session.sessionCreatedAt,
      agentCreatedAt: agent.createdAt,
    });
    const lastActivityAt = applyRunNowBaseline(
      session,
      activityBaseline,
      invokedAt,
      invokingUserMsgAt,
      snapshotActivity
    );
    if (lastActivityAt === null) return;
    const space = await this.deps.spaceManager.getSpace(spaceId);
    reconcileInactivityClaim(this.deps, spaceId, agentId, config.configRevision, lastActivityAt);
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
    if (!acquired.created) return;
    this.deps.claimRepo.markInFlight(spaceId, agentId, decision.claimKey);
    await this.deliver(
      spaceId,
      agentId,
      acquired.claim.id,
      decision.claimKey,
      decision.configRevision,
      activityBaseline,
      invokedAt,
      invokingUserMsgAt,
      boundInactivityNagPrompt(config.prompt)
    );
  }

  private async deliver(
    spaceId: string,
    agentId: string,
    claimId: string,
    claimKey: string,
    acquiredConfigRevision: number | null,
    activityBaseline: number | undefined,
    invokedAt: number | undefined,
    invokingUserMsgAt: number | null | undefined,
    prompt: string
  ): Promise<void> {
    const space = await this.deps.spaceManager.getSpace(spaceId);
    const recheckAgent = this.deps.agentRepo.getById(agentId);
    const recheckConfig = this.deps.configRepo.getByAgent(spaceId, agentId);
    const recheckSession = this.deps.getSessionSnapshot(spaceId, agentId);
    const currentClaim = this.deps.claimRepo.getByAgent(spaceId, agentId);
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
        claimId,
        claimKey,
        acquiredConfigRevision,
        'pre_admission_failure'
      );
      return;
    }
    if (
      currentClaim === null ||
      currentClaim.id !== claimId ||
      currentClaim.claimKey !== claimKey ||
      currentClaim.ownerToken !== this.deps.scannerToken ||
      currentClaim.configRevision !== acquiredConfigRevision
    ) {
      return;
    }
    const snapshotActivity = resolveLastActivityAt({
      latestConsumedMessageAt: recheckSession.latestConsumedMessageAt,
      sessionCreatedAt: recheckSession.sessionCreatedAt,
      agentCreatedAt: recheckAgent.createdAt,
    });
    const lastActivityAt = applyRunNowBaseline(
      recheckSession,
      activityBaseline,
      invokedAt,
      invokingUserMsgAt,
      snapshotActivity
    );
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
        claimId,
        claimKey,
        acquiredConfigRevision,
        'pre_admission_failure'
      );
      return;
    }
    let outcome: InactivityNagDeliveryOutcome | 'pending';
    try {
      outcome = await this.deliverNagBounded({
        spaceId,
        agentId,
        claimId,
        prompt,
        idempotencyKey: claimKey,
        configRevision: acquiredConfigRevision,
      });
    } catch (err) {
      log.warn(
        `Inactivity nag delivery threw for agent "${agentId}" in space "${spaceId}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      outcome = 'terminal_failure';
    }
    if (outcome === 'pending') return;
    this.applyOutcome(spaceId, agentId, claimId, claimKey, acquiredConfigRevision, outcome);
  }

  private async deliverNagBounded(args: {
    spaceId: string;
    agentId: string;
    claimId: string;
    prompt: string;
    idempotencyKey: string;
    configRevision: number | null;
  }): Promise<InactivityNagDeliveryOutcome | 'pending'> {
    const timeoutMs = this.deps.deliveryTimeoutMs ?? INACTIVITY_NAG_DELIVERY_TIMEOUT_MS;
    if (timeoutMs <= 0) return this.deps.deliverNag(args);
    const delivery = this.deps.deliverNag(args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        delivery,
        new Promise<InactivityNagDeliveryOutcome | 'pending'>((resolve) => {
          timer = setTimeout(() => {
            resolve('pending');
            delivery
              .then(
                (outcome) =>
                  this.applyLateOutcome(
                    args.spaceId,
                    args.agentId,
                    args.claimId,
                    args.idempotencyKey,
                    args.configRevision,
                    outcome
                  ),
                (err) => {
                  log.warn(
                    `Inactivity nag delivery for agent "${args.agentId}" in space "${args.spaceId}" failed after timing out: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  );
                  this.applyLateOutcome(
                    args.spaceId,
                    args.agentId,
                    args.claimId,
                    args.idempotencyKey,
                    args.configRevision,
                    'terminal_failure'
                  );
                }
              )
              .catch(() => {});
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private applyLateOutcome(
    spaceId: string,
    agentId: string,
    claimId: string,
    claimKey: string,
    acquiredConfigRevision: number | null,
    outcome: InactivityNagDeliveryOutcome
  ): void {
    try {
      this.applyOutcome(spaceId, agentId, claimId, claimKey, acquiredConfigRevision, outcome);
    } catch (err) {
      log.warn(
        `Inactivity nag late outcome for agent "${agentId}" in space "${spaceId}" could not be applied: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private applyOutcome(
    spaceId: string,
    agentId: string,
    claimId: string,
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
      claimId,
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
