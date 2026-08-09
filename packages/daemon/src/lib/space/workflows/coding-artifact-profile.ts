/**
 * Coding-Workflow Artifact Profile
 *
 * The domain implementation of {@link WorkflowArtifactProfile} for coding
 * workflows. This is the ONLY place in the daemon that names coding-specific
 * kinds (`pr`, `review`) and coding-specific identifiers (`review-posted-gate`,
 * the `pr_url` / `prUrl` / `review_url` gate-data fields). Generic infra depends
 * on the interface; it never imports this module.
 *
 * It consolidates the three behaviors that previously lived (duplicated and
 * kind-hardcoded) inside daemon core:
 *   - `resolvePrimaryLinkUrl` — the PR URL (a `link kind:'pr'`, or a legacy
 *     `pr_url`/`prUrl` field), resolved across gate data, hook state, and
 *     artifacts by recency.
 *   - `summarizeRunOutcome` — the kindless terminal `decision` summary.
 *   - `onGateDataCommitted` — append one `decision kind:'review'` (round-N)
 *     each time the review-posted-gate receives a `review_url`.
 */

import { deriveArtifactKey } from '@hyperneo/shared';
import { Logger } from '../../logger';
import type { GateDataCommittedEvent, WorkflowArtifactProfile } from '../runtime/artifact-profile';
import { PR_READY_VALIDATED_IDENTITY_HOOK_ID } from '../runtime/workflow-hook-engine';
import { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';

const log = new Logger('coding-artifact-profile');

/** Gate id that records a multi-round review decision per cycle. */
const REVIEW_POSTED_GATE = 'review-posted-gate';
const LEGACY_PR_READY_GATE_IDS = new Set([
  'code-ready-gate',
  'research-ready-gate',
  'plan-pr-gate',
  'code-pr-gate',
]);

/**
 * The SQLite database type this profile consumes. Derived from the repository
 * constructor rather than imported directly from `bun:sqlite` so it is
 * structurally identical to what every other repo caller passes (and what
 * `getDatabase()` returns) under any Bun type resolution — avoiding a
 * bun:sqlite ↔ node:sqlite type-surface mismatch that only surfaces in CI.
 */
type ArtifactDb = ConstructorParameters<typeof GateDataRepository>[0];

export interface CodingArtifactProfileConfig {
  db: ArtifactDb;
  artifactRepo?: WorkflowRunArtifactRepository;
  /** Optional shared gate-data repo; created from `db` when omitted. */
  gateDataRepo?: GateDataRepository;
}

/**
 * Extract a legacy PR URL (`prUrl` / `pr_url`) from a data object. Returns ''
 * when neither field holds a string. A generic `url` field never qualifies —
 * it could be an issue or preview link.
 */
function legacyPrUrl(data: Record<string, unknown> | undefined): string {
  return (
    (typeof data?.prUrl === 'string' && data.prUrl) ||
    (typeof data?.pr_url === 'string' && data.pr_url) ||
    ''
  );
}

export class CodingArtifactProfile implements WorkflowArtifactProfile {
  private readonly db: ArtifactDb;
  private readonly artifactRepo?: WorkflowRunArtifactRepository;
  private readonly sharedGateDataRepo?: GateDataRepository;

  constructor(config: CodingArtifactProfileConfig) {
    this.db = config.db;
    this.artifactRepo = config.artifactRepo;
    this.sharedGateDataRepo = config.gateDataRepo;
  }

  resolvePrimaryLinkUrl(runId: string): string {
    // The primary link is the FRESHEST eligible PR URL across ALL sources
    // (gate data, hook state, artifacts), compared by updatedAt — so a newer
    // `link kind:'pr'` artifact supersedes a stale gate-data `pr_url` (and vice
    // versa). A generic `url` on a non-pr artifact never qualifies.
    type Candidate = { url: string; updatedAt: number };
    let best: Candidate | null = null;
    // Pure fresher (no closure mutation) so TS control-flow tracks `best`.
    const fresher = (prev: Candidate | null, url: string, updatedAt: number): Candidate | null => {
      if (!url) return prev;
      if (!prev || updatedAt > prev.updatedAt) return { url, updatedAt };
      return prev;
    };

    // 1. Gate data — records carrying a legacy pr_url/prUrl.
    try {
      const gateDataRepo = this.sharedGateDataRepo ?? new GateDataRepository(this.db);
      for (const record of gateDataRepo.listByRun(runId)) {
        best = fresher(best, legacyPrUrl(record.data), record.updatedAt);
      }
    } catch (err) {
      log.warn(
        `resolvePrimaryLinkUrl: failed to read gate data for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 2. Workflow hook state — `pr_ready` hooks persist `pr_url` after a
    //    successful send_message even when the gate schema does not declare it.
    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.db);
      for (const snapshot of hookStateRepo.listByRun(runId)) {
        best = fresher(best, legacyPrUrl(snapshot.localState), snapshot.updatedAt ?? 0);
      }
    } catch (err) {
      log.warn(
        `resolvePrimaryLinkUrl: failed to read hook state for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 3. Artifacts — a `link kind:'pr'` (read via data.url) or a legacy row
    //    carrying pr_url/prUrl.
    if (this.artifactRepo) {
      try {
        for (const a of this.artifactRepo.listByRun(runId)) {
          const url =
            a.artifactType === 'link' && a.data.kind === 'pr'
              ? typeof a.data.url === 'string'
                ? a.data.url
                : ''
              : legacyPrUrl(a.data);
          best = fresher(best, url, a.updatedAt);
        }
      } catch (err) {
        log.warn(
          `resolvePrimaryLinkUrl: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return best?.url ?? '';
  }

  resolveInitialPrimaryLinkUrl(runId: string): string {
    // Authoritative source FIRST: the engine stamps the pr_ready-validated PR
    // identity under a RESERVED hook id that no real (user-defined) hook can
    // write (record_state / stateForHook target a hook's OWN id). Reading it
    // outright bypasses the user-defined hook-id matching below, closing the
    // colliding-hook-id / record_state PR-identity spoof for current runs.
    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.db);
      const reserved = hookStateRepo.get(runId, PR_READY_VALIDATED_IDENTITY_HOOK_ID);
      const reservedUrl = legacyPrUrl(reserved?.localState);
      if (reservedUrl) return reservedUrl;
    } catch (err) {
      log.warn(
        `resolveInitialPrimaryLinkUrl: failed to read reserved identity for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Approval handoffs persist pr_url in hook state (or legacy gate data).
    // Choose the latest validated handoff identity: a revision may legitimately
    // replace a closed PR before final approval. Deliberately ignore artifacts
    // whenever validated state exists so agents cannot substitute the PR later.
    type Candidate = { url: string; updatedAt: number };
    let approved: Candidate | null = null;
    const newer = (prev: Candidate | null, url: string, updatedAt: number): Candidate | null => {
      if (!url) return prev;
      return !prev || updatedAt > prev.updatedAt ? { url, updatedAt } : prev;
    };

    try {
      const gateDataRepo = this.sharedGateDataRepo ?? new GateDataRepository(this.db);
      for (const record of gateDataRepo.listByRun(runId)) {
        // Only the exact legacy pr_ready gate IDs are trusted compatibility
        // sources for the run's PR identity. A substring match (`includes(
        // 'pr-ready')`) would let a custom gate with a colliding id (e.g.
        // `post-pr-ready-notification`) supply a spoofed pr_url that, if written
        // latest, would control merge-dispatch resolution and the mark_complete
        // merge gate. The authoritative source on current runs is the pr_ready
        // hook state (the engine stamps pr_url only for the pr_ready validator);
        // this gate-data path is legacy-only (runs created before hook state).
        if (!LEGACY_PR_READY_GATE_IDS.has(record.gateId)) {
          continue;
        }
        approved = newer(approved, legacyPrUrl(record.data), record.updatedAt);
      }
    } catch (err) {
      log.warn(
        `resolveInitialPrimaryLinkUrl: failed to read gate data for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.db);
      for (const snapshot of hookStateRepo.listByRun(runId)) {
        // Only PR-ready handoffs establish the run's PR identity. Later
        // review/QA hooks also carry pr_url but validate different evidence and
        // must not be able to replace the coder/research PR.
        if (!snapshot.hookId.includes('pr-ready')) continue;
        approved = newer(approved, legacyPrUrl(snapshot.localState), snapshot.updatedAt ?? 0);
      }
    } catch (err) {
      log.warn(
        `resolveInitialPrimaryLinkUrl: failed to read hook state for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (approved) return approved.url;

    // Backward compatibility for runs created before PR-ready hook state was
    // persisted: bind to the oldest eligible artifact. With no validated
    // handoff state this is the least-mutable historical identity available.
    let fallback: Candidate | null = null;
    const earlier = (prev: Candidate | null, url: string, updatedAt: number): Candidate | null => {
      if (!url) return prev;
      return !prev || updatedAt < prev.updatedAt ? { url, updatedAt } : prev;
    };
    if (this.artifactRepo) {
      try {
        for (const artifact of this.artifactRepo.listByRun(runId)) {
          const url =
            artifact.artifactType === 'link' && artifact.data.kind === 'pr'
              ? typeof artifact.data.url === 'string'
                ? artifact.data.url
                : ''
              : legacyPrUrl(artifact.data);
          fallback = earlier(fallback, url, artifact.updatedAt);
        }
      } catch (err) {
        log.warn(
          `resolveInitialPrimaryLinkUrl: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return fallback?.url ?? '';
  }

  summarizeRunOutcome(runId: string): string | null {
    if (!this.artifactRepo) return null;
    try {
      // The terminal outcome is a kindless `decision` carrying a summary.
      // Review/gate decisions carry a kind and are not terminal; rolling-status
      // `note`s are excluded too.
      const decisions = this.artifactRepo.listByRun(runId, { artifactType: 'decision' });
      const summaryOf = (item: { data: Record<string, unknown> }): string => {
        const s = item.data.summary;
        return typeof s === 'string' ? s : '';
      };
      const isTerminal = (item: { data: Record<string, unknown> }): boolean =>
        !item.data.kind && summaryOf(item).trim().length > 0;
      const artifact = decisions
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => isTerminal(item))
        .toSorted(
          (a, b) =>
            b.item.updatedAt - a.item.updatedAt ||
            b.item.createdAt - a.item.createdAt ||
            b.index - a.index
        )[0]?.item;
      const summary = artifact ? summaryOf(artifact) : '';
      return summary.length > 0 ? summary : null;
    } catch (err) {
      log.warn(
        `summarizeRunOutcome: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  async onGateDataCommitted(event: GateDataCommittedEvent): Promise<void> {
    if (!this.artifactRepo) return;
    const { runId, nodeId, gateId, committedData, messageData } = event;
    // Multi-round review history: every time the reviewer COMMITS a fresh
    // `review_url` on the review-posted-gate, persist one `decision kind:'review'`
    // per cycle (round-0, round-1 …) keyed so each round is a distinct upsert.
    // Read the URL from `committedData` — the gate-declared fields the sender was
    // authorized to write in THIS send (not the raw payload, and not the merged
    // gate state). This avoids two failure modes: (a) a later send that only
    // updates comment_urls would see the prior round's review_url in the merged
    // gate state and spuriously record an extra round; (b) a field the agent sent
    // but was not authorized to write must not trigger a side-artifact.
    if (gateId !== REVIEW_POSTED_GATE) return;
    const reviewUrl = committedData?.review_url;
    if (typeof reviewUrl !== 'string' || reviewUrl.length === 0) return;

    try {
      const decisions = this.artifactRepo.listByRun(runId, { artifactType: 'decision' });
      // Next round = one past the highest existing review-round number, derived
      // from the trailing digits of each review decision's key (handles sparse
      // keys and both legacy 'cycle-N' and namespaced 'review:round-N' forms).
      let maxCycle = -1;
      for (const a of decisions) {
        if (a.data.kind !== 'review') continue;
        const m = /(\d+)$/.exec(a.artifactKey);
        if (m) maxCycle = Math.max(maxCycle, Number.parseInt(m[1], 10));
      }
      const cycle = maxCycle + 1;
      const artifactData: Record<string, unknown> = {
        recommendation: 'reviewed',
        kind: 'review',
        review_url: reviewUrl,
        cycle,
        submittedAt: new Date().toISOString(),
      };
      // comment_urls is review metadata, not a gate field, so it travels in the
      // raw payload (messageData) rather than committedData.
      const rawCommentUrls = messageData?.comment_urls;
      if (Array.isArray(rawCommentUrls) && rawCommentUrls.every((u) => typeof u === 'string')) {
        artifactData.comment_urls = rawCommentUrls;
      }
      this.artifactRepo.upsert({
        id: crypto.randomUUID(),
        runId,
        nodeId,
        artifactType: 'decision',
        artifactKey: deriveArtifactKey('decision', { kind: 'review' }, `round-${cycle}`),
        data: artifactData,
      });
    } catch (err) {
      log.warn(
        `onGateDataCommitted: failed to append review artifact for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
