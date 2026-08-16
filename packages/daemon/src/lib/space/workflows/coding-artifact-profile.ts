/**
 * Coding-Workflow Artifact Profile
 *
 * The domain implementation of {@link WorkflowArtifactProfile} for coding
 * workflows. This is the ONLY place in the daemon that names coding-specific
 * kinds (`pr`, `review`) and the `pr_url` / `prUrl` / `review_url` identity
 * fields. Generic infra depends on the interface; it never imports this module.
 *
 * It consolidates the behaviors that previously lived (duplicated and
 * kind-hardcoded) inside daemon core:
 *   - `resolvePrimaryLinkUrl` — the PR URL (a `link kind:'pr'`, or a legacy
 *     `pr_url`/`prUrl` field), resolved across hook state and artifacts by
 *     recency.
 *   - `summarizeRunOutcome` — the kindless terminal `decision` summary.
 */

import { Logger } from '../../logger';
import type { WorkflowArtifactProfile } from '../runtime/artifact-profile';
import { PR_READY_VALIDATED_IDENTITY_HOOK_ID } from '../runtime/workflow-hook-engine';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';

const log = new Logger('coding-artifact-profile');

/**
 * The SQLite database type this profile consumes. Derived structurally from
 * `WorkflowHookStateRepository`'s constructor so it is identical to what every
 * other repo caller passes (and what `getDatabase()` returns) under any Bun type
 * resolution — avoiding a bun:sqlite ↔ node:sqlite type-surface mismatch that
 * only surfaces in CI.
 */
type ArtifactDb = ConstructorParameters<typeof WorkflowHookStateRepository>[0];

export interface CodingArtifactProfileConfig {
  db: ArtifactDb;
  artifactRepo?: WorkflowRunArtifactRepository;
  /**
   * Resolves the hook ids configured with the actual `pr_ready` built-in
   * validator for a run's workflow. When provided, the PR-identity resolver's
   * hook-state fallback trusts ONLY those validator-verified hook ids (not a
   * `pr-ready` substring), so a custom hook with a colliding id and a different
   * validator cannot spoof the run PR identity on runs without a reserved
   * snapshot. Returns undefined when the workflow can't be resolved (the
   * resolver then falls back to the substring for legacy compatibility).
   */
  resolvePrReadyHookIds?: (runId: string) => Set<string> | undefined;
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
  private readonly resolvePrReadyHookIds?: (runId: string) => Set<string> | undefined;

  constructor(config: CodingArtifactProfileConfig) {
    this.db = config.db;
    this.artifactRepo = config.artifactRepo;
    this.resolvePrReadyHookIds = config.resolvePrReadyHookIds;
  }

  resolvePrimaryLinkUrl(runId: string): string {
    // Lenient contract for infra control flow: a read failure degrades to the
    // safe default ('') rather than throwing. Completion gates that must NOT
    // treat a read failure as "no PR exists" use resolvePrimaryLinkUrlStrict.
    return this.collectPrimaryLink(runId).url;
  }

  /**
   * Write-once memory of a run's primary-link (PR) URL, stored under the
   * RESERVED hook id (no user-defined hook can write there). Called from the
   * artifact write path at RECORD time so a later same-key artifact overwrite
   * (a kindless decision row rewritten without its pr_url) cannot erase the
   * run's PR-bound identity: resolveInitialPrimaryLinkUrl reads the reserved
   * state first. Idempotent — the first recorded URL wins; later calls with
   * a different URL do not rewrite history.
   */
  rememberPrimaryLinkUrl(runId: string, url: string): void {
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.db);
      const reserved = hookStateRepo.get(runId, PR_READY_VALIDATED_IDENTITY_HOOK_ID);
      if (reserved && legacyPrUrl(reserved.localState)) return; // first wins
      const snapshot = hookStateRepo.ensure(runId, PR_READY_VALIDATED_IDENTITY_HOOK_ID, {
        pr_url: trimmed,
      });
      if (!legacyPrUrl(snapshot.localState ?? {})) {
        hookStateRepo.update(runId, PR_READY_VALIDATED_IDENTITY_HOOK_ID, {
          expectedVersion: snapshot.version,
          localState: { ...snapshot.localState, pr_url: trimmed },
        });
      }
    } catch (err) {
      log.warn(
        `rememberPrimaryLinkUrl: failed to record PR identity for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  resolvePrimaryLinkUrlStrict(runId: string): { url: string; readable: boolean } {
    const { url, fullyReadable } = this.collectPrimaryLink(runId);
    // A FOUND url answers "PR-bound" with certainty even when another source
    // failed to read; only a url-less scan with a failed source is
    // indeterminate.
    return { url, readable: fullyReadable || url !== '' };
  }

  /**
   * Shared core for both resolvePrimaryLinkUrl variants. The primary link is
   * the FRESHEST eligible PR URL across hook state and artifacts, compared by
   * updatedAt — so a newer `link kind:'pr'` artifact supersedes a stale
   * hook-state `pr_url` (and vice versa). A generic `url` on a non-pr
   * artifact never qualifies. Legacy `pr_url`/`prUrl` on artifacts is
   * load-bearing for post-approval routing (which records the PR on a
   * `decision` artifact) and for migrated runs. `fullyReadable` records
   * whether every source actually answered; the lenient path ignores it.
   */
  private collectPrimaryLink(runId: string): { url: string; fullyReadable: boolean } {
    type Candidate = { url: string; updatedAt: number };
    let best: Candidate | null = null;
    let fullyReadable = true;
    // Pure fresher (no closure mutation) so TS control-flow tracks `best`.
    const fresher = (prev: Candidate | null, url: string, updatedAt: number): Candidate | null => {
      if (!url) return prev;
      if (!prev || updatedAt > prev.updatedAt) return { url, updatedAt };
      return prev;
    };

    // 1. Workflow hook state — engine-controlled; `pr_ready` hooks persist
    //    `pr_url` after a successful send_message.
    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.db);
      for (const snapshot of hookStateRepo.listByRun(runId)) {
        best = fresher(best, legacyPrUrl(snapshot.localState), snapshot.updatedAt ?? 0);
      }
    } catch (err) {
      fullyReadable = false;
      log.warn(
        `resolvePrUrl: failed to read hook state for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 2. Artifacts — a `link kind:'pr'` (data.url) or a legacy row carrying
    // pr_url/prUrl. Legacy artifact pr_url is load-bearing for post-approval
    // routing (decision artifacts) and migrated runs.
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
        fullyReadable = false;
        log.warn(
          `resolvePrUrl: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { url: best?.url ?? '', fullyReadable };
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

    // Approval handoffs persist pr_url in hook state. Choose the latest
    // validated handoff identity: a revision may legitimately replace a closed
    // PR before final approval. Deliberately ignore artifacts whenever validated
    // state exists so agents cannot substitute the PR later.
    type Candidate = { url: string; updatedAt: number };
    let approved: Candidate | null = null;
    const newer = (prev: Candidate | null, url: string, updatedAt: number): Candidate | null => {
      if (!url) return prev;
      return !prev || updatedAt > prev.updatedAt ? { url, updatedAt } : prev;
    };

    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.db);
      // When the caller can resolve which hook ids are actually configured with
      // the pr_ready validator, trust ONLY those — a custom hook with a
      // `pr-ready` id and a different validator must not be able to spoof the
      // run PR identity on runs without a reserved snapshot. Fall back to the
      // substring only when the workflow can't be resolved (legacy compat).
      const verifiedHookIds = this.resolvePrReadyHookIds?.(runId);
      const useExact = verifiedHookIds !== undefined;
      for (const snapshot of hookStateRepo.listByRun(runId)) {
        const trusted = useExact
          ? verifiedHookIds.has(snapshot.hookId)
          : snapshot.hookId.includes('pr-ready');
        if (!trusted) continue;
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
      // Review decisions carry a kind and are not terminal; rolling-status
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
}
