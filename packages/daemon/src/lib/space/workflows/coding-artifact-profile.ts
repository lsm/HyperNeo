import { Logger } from '../../logger.ts';
import type { WorkflowArtifactProfile } from '../runtime/artifact-profile.ts';
import { PR_READY_VALIDATED_IDENTITY_HOOK_ID } from '../runtime/workflow-hook-engine.ts';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository.ts';

const log = new Logger('coding-artifact-profile');

type ArtifactDb = ConstructorParameters<typeof WorkflowHookStateRepository>[0];

export interface CodingArtifactProfileConfig {
  db: ArtifactDb;
  artifactRepo?: WorkflowRunArtifactRepository;
  resolvePrReadyHookIds?: (runId: string) => Set<string> | undefined;
}

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
    type Candidate = { url: string; updatedAt: number };
    let best: Candidate | null = null;
    const fresher = (prev: Candidate | null, url: string, updatedAt: number): Candidate | null => {
      if (!url) return prev;
      if (!prev || updatedAt > prev.updatedAt) return { url, updatedAt };
      return prev;
    };

    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.db);
      for (const snapshot of hookStateRepo.listByRun(runId)) {
        best = fresher(best, legacyPrUrl(snapshot.localState), snapshot.updatedAt ?? 0);
      }
    } catch (err) {
      log.warn(
        `resolvePrUrl: failed to read hook state for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

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
          `resolvePrUrl: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return best?.url ?? '';
  }

  resolveInitialPrimaryLinkUrl(runId: string): string {
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

    type Candidate = { url: string; updatedAt: number };
    let approved: Candidate | null = null;
    const newer = (prev: Candidate | null, url: string, updatedAt: number): Candidate | null => {
      if (!url) return prev;
      return !prev || updatedAt > prev.updatedAt ? { url, updatedAt } : prev;
    };

    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.db);
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
