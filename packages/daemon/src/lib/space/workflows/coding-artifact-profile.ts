/**
 * Coding-Workflow Artifact Profile
 *
 * The domain implementation of {@link WorkflowArtifactProfile} for coding
 * workflows. This is the ONLY place in the daemon that names coding-specific
 * kinds (`pr`, `review`) and the `pr` identity. Generic infra depends on the
 * interface; it never imports this module.
 *
 * In the v2 hook model the `pr_ready` hook stamps the run's reviewed PR as a
 * `link/pr` artifact (via `ctx.writeArtifact`) on a successful handoff. That
 * artifact is the single authoritative source for the run's PR identity — there
 * is no longer an engine-reserved hook-state key or a `pr_url` field on hook
 * state. `resolvePrimaryLinkUrl` reads the freshest such artifact; the immutable
 * `resolveInitialPrimaryLinkUrl` reads the oldest (so a later artifact cannot
 * swap the reviewed PR for a different already-merged one).
 */

import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import { Logger } from '../../logger';
import type { WorkflowArtifactProfile } from '../runtime/artifact-profile';
// The validated-PR key is PR-domain knowledge owned by the extensions layer.
import { VALIDATED_PR_ARTIFACT_KEY } from '@hyperneo/extensions-hooks';

const log = new Logger('coding-artifact-profile');

export interface CodingArtifactProfileConfig {
  artifactRepo?: WorkflowRunArtifactRepository;
}

/**
 * Alias for the extensions-owned engine-reserved key the `pr_ready` hook stamps
 * the run's authoritative reviewed-PR identity under. `save_artifact` rejects
 * `__`-prefixed keys, so only the engine (via `ctx.writeArtifact`) can write
 * this — a same-node agent cannot overwrite it to swap the PR the merge gate
 * binds to.
 */
const VALIDATED_PR_KEY = VALIDATED_PR_ARTIFACT_KEY;

/**
 * The PR's URL on a `link/pr` artifact (v2: `data.link`, legacy `link kind:'pr'`:
 * `data.url`), OR a legacy `pr_url`/`prUrl` field carried on any artifact —
 * post-approval routing records the PR on a kindless `decision` artifact, and
 * migrated runs carry it on older artifacts. Returns '' when none holds a string.
 */
function prUrlOf(
  artifactType: string,
  artifactKey: string,
  data: Record<string, unknown> | undefined
): string {
  if (
    artifactType === 'link' &&
    (artifactKey === 'pr' || artifactKey === VALIDATED_PR_KEY || data?.kind === 'pr')
  ) {
    const link = typeof data?.link === 'string' ? data.link : '';
    if (link) return link;
    const url = typeof data?.url === 'string' ? data.url : '';
    if (url) return url;
  }
  if (typeof data?.prUrl === 'string' && data.prUrl) return data.prUrl;
  if (typeof data?.pr_url === 'string' && data.pr_url) return data.pr_url;
  return '';
}

export class CodingArtifactProfile implements WorkflowArtifactProfile {
  private readonly artifactRepo?: WorkflowRunArtifactRepository;

  constructor(config: CodingArtifactProfileConfig) {
    this.artifactRepo = config.artifactRepo;
  }

  resolvePrimaryLinkUrl(runId: string): string {
    if (!this.artifactRepo) return '';
    try {
      // Prefer the engine-stamped validated identity (earliest = the immutable
      // first stamp, so a later same-key stamp from another node can't swap it).
      // Fall back to the freshest agent-written link/pr only before the first
      // handoff stamps a validated identity.
      const all = this.artifactRepo.listByRun(runId);
      const validated = all.filter(
        (a) => a.artifactType === 'link' && a.artifactKey === VALIDATED_PR_KEY
      );
      const earliestValidated = validated
        .map((a) => ({
          url: prUrlOf(a.artifactType, a.artifactKey, a.data),
          // createdAt, NOT updatedAt: the stamp is UPSERTED per
          // (run, node, type, key), so a re-stamp bumps updatedAt — ordering by
          // it would let a re-stamped node steal "earliest" from the original
          // identity. createdAt is stable under upsert.
          createdAt: a.createdAt,
        }))
        .filter((v) => v.url)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (earliestValidated) return earliestValidated.url;
      let best: { url: string; updatedAt: number } | null = null;
      for (const a of all) {
        const url = prUrlOf(a.artifactType, a.artifactKey, a.data);
        if (!url) continue;
        if (!best || a.updatedAt > best.updatedAt) best = { url, updatedAt: a.updatedAt };
      }
      return best?.url ?? '';
    } catch (err) {
      log.warn(
        `resolvePrimaryLinkUrl: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return '';
    }
  }

  resolveInitialPrimaryLinkUrl(runId: string): string {
    if (!this.artifactRepo) return '';
    try {
      const all = this.artifactRepo.listByRun(runId);
      // Prefer the engine-stamped validated identity (agent-unwritable) — the
      // immutable one completion safety binds to. Only when no handoff has
      // stamped one yet do we fall back to agent-written link/pr rows.
      const validated = all.filter(
        (a) => a.artifactType === 'link' && a.artifactKey === VALIDATED_PR_KEY
      );
      const pool = validated.length > 0 ? validated : all;
      // Order by createdAt (stable under upsert) — see resolvePrimaryLinkUrl.
      let earliest: { url: string; createdAt: number } | null = null;
      for (const a of pool) {
        const url = prUrlOf(a.artifactType, a.artifactKey, a.data);
        if (!url) continue;
        if (!earliest || a.createdAt < earliest.createdAt)
          earliest = { url, createdAt: a.createdAt };
      }
      return earliest?.url ?? '';
    } catch (err) {
      log.warn(
        `resolveInitialPrimaryLinkUrl: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return '';
    }
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
