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

const log = new Logger('coding-artifact-profile');

export interface CodingArtifactProfileConfig {
  artifactRepo?: WorkflowRunArtifactRepository;
}

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
  if (artifactType === 'link' && (artifactKey === 'pr' || data?.kind === 'pr')) {
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
      let best: { url: string; updatedAt: number } | null = null;
      for (const a of this.artifactRepo.listByRun(runId)) {
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
      // The OLDEST `link/pr` artifact is the first reviewed-PR identity stamped
      // for the run — the immutable one completion safety binds to, so a later
      // stamp cannot substitute a different already-merged PR.
      let earliest: { url: string; updatedAt: number } | null = null;
      for (const a of this.artifactRepo.listByRun(runId)) {
        const url = prUrlOf(a.artifactType, a.artifactKey, a.data);
        if (!url) continue;
        if (!earliest || a.updatedAt < earliest.updatedAt)
          earliest = { url, updatedAt: a.updatedAt };
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
