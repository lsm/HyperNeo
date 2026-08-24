import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor.ts';
import { getConnector, registerConnector } from './connector.ts';
import {
  createExternalStateValidator,
  type ExternalStateValidatorConfig,
} from './external-state-validator.ts';
import { createGithubConnector, GITHUB_CONNECTOR_ID } from './github-connector.ts';
import type { Predicate } from './predicate.ts';

const PR_READY_LABEL = 'PR is not ready for Review';
const PR_MERGED_LABEL = 'PR is not merged';
const CODEX_LABEL = 'codex review bot approval missing';

const CODEX_RETRY_INTERVAL_MS = 60_000;

export function registerGithubConnector(
  spawnImpl: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
    Bun.spawn(...args)) as typeof Bun.spawn
): void {
  registerConnector(createGithubConnector(spawnImpl));
}

function readPrUrl(params: Record<string, unknown> | undefined): string | undefined {
  const data = params?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const v = (data as Record<string, unknown>).pr_url;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function resolvePrUrlParams(ctx: HookExecutorContext): Record<string, unknown> {
  const prUrl =
    readPrUrl(ctx.params) ??
    (ctx.rawParams ? readPrUrl(ctx.rawParams) : undefined) ??
    (typeof ctx.hookLocalState?.pr_url === 'string' ? ctx.hookLocalState.pr_url : undefined);
  return prUrl ? { prUrl } : {};
}

const PR_READY_PASS: Predicate = {
  all: [
    { eq: ['state', 'OPEN'] },
    { eq: ['mergeable', 'MERGEABLE'] },
    {
      any: [
        { eq: ['mergeStateStatus', 'CLEAN'] },
        { eq: ['mergeStateStatus', 'HAS_HOOKS'] },
        { eq: ['mergeStateStatus', 'BLOCKED'] },
      ],
    },
    { empty: 'unresolvedThreadUrls' },
  ],
};

const PR_READY_PENDING: Predicate = {
  any: [{ eq: ['mergeable', 'UNKNOWN'] }, { eq: ['mergeStateStatus', 'UNKNOWN'] }],
};

export function createPrReadyValidatorV2(
  spawnImpl: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
    Bun.spawn(...args)) as typeof Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  registerGithubConnector(spawnImpl);
  const config: ExternalStateValidatorConfig = {
    connector: GITHUB_CONNECTOR_ID,
    op: 'getPrReadiness',
    pass: PR_READY_PASS,
    pending: PR_READY_PENDING,
    params: resolvePrUrlParams,
    label: PR_READY_LABEL,
    dataProjection: (data) => ({
      pr_url: typeof data.url === 'string' ? data.url : undefined,
    }),
  };
  return createExternalStateValidator(config);
}

export function createPrMergedValidator(
  spawnImpl: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
    Bun.spawn(...args)) as typeof Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  registerGithubConnector(spawnImpl);
  const config: ExternalStateValidatorConfig = {
    connector: GITHUB_CONNECTOR_ID,
    op: 'getPr',
    pass: { eq: ['state', 'MERGED'] },
    pending: { eq: ['state', 'OPEN'] },
    params: resolvePrUrlParams,
    label: PR_MERGED_LABEL,
  };
  return createExternalStateValidator(config);
}

const REVIEW_POSTED_LABEL = 'no fresh GitHub review evidence';

const REVIEW_POSTED_PASS: Predicate = {
  any: [
    { gte: ['formalReviewCount', 1] },
    { all: [{ eq: ['ownPr', true] }, { gte: ['commentEvidenceCount', 1] }] },
  ],
};

function reviewPostedPrUrl(params: Record<string, unknown> | undefined): string | undefined {
  const data = params?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (typeof d.pr_url === 'string') return d.pr_url;
    if (typeof d.prUrl === 'string') return d.prUrl;
    if (typeof d.review_url === 'string') return d.review_url;
    if (typeof d.reviewUrl === 'string') return d.reviewUrl;
  }
  return undefined;
}

function reviewPostedPrUrlFromState(
  state: Record<string, unknown> | undefined
): string | undefined {
  if (typeof state?.pr_url === 'string') return state.pr_url;
  if (typeof state?.prUrl === 'string') return state.prUrl;
  if (typeof state?.review_url === 'string') return state.review_url;
  if (typeof state?.reviewUrl === 'string') return state.reviewUrl;
  return undefined;
}

function reviewPostedParamResolver(ctx: HookExecutorContext): Record<string, unknown> {
  const prUrl =
    reviewPostedPrUrl(ctx.params) ??
    (ctx.rawParams ? reviewPostedPrUrl(ctx.rawParams) : undefined) ??
    reviewPostedPrUrlFromState(ctx.hookLocalState) ??
    (typeof ctx.frozenPrUrl === 'string' ? ctx.frozenPrUrl : undefined);
  let sinceIso: string | undefined;
  if (typeof ctx.hookLocalState?.workflowStartIso === 'string') {
    sinceIso = ctx.hookLocalState.workflowStartIso;
  } else if (
    typeof ctx.workflowRunCreatedAt === 'number' &&
    Number.isFinite(ctx.workflowRunCreatedAt)
  ) {
    sinceIso = new Date(ctx.workflowRunCreatedAt).toISOString();
  }
  return prUrl ? { prUrl, sinceIso } : {};
}

export function createReviewPostedValidator(
  spawnImpl: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
    Bun.spawn(...args)) as typeof Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  registerGithubConnector(spawnImpl);
  const config: ExternalStateValidatorConfig = {
    connector: GITHUB_CONNECTOR_ID,
    op: 'getReviewEvidence',
    params: reviewPostedParamResolver,
    pass: REVIEW_POSTED_PASS,
    label: REVIEW_POSTED_LABEL,
    dataProjection: (data) => ({
      pr_url: typeof data.url === 'string' ? data.url : undefined,
      review_count: typeof data.reviewCount === 'number' ? data.reviewCount : undefined,
      review_evidence: data.reviewEvidence,
    }),
  };
  return createExternalStateValidator(config);
}

export function createCodexApprovalValidator(
  spawnImpl: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
    Bun.spawn(...args)) as typeof Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  registerGithubConnector(spawnImpl);
  return async (ctx) => {
    const connector = getConnector(GITHUB_CONNECTOR_ID);
    if (!connector) {
      return { type: 'block', reason: `${CODEX_LABEL}: connector "github" is not registered` };
    }
    const op = connector.ops['getCodexApproval'];
    if (!op) {
      return {
        type: 'block',
        reason: `${CODEX_LABEL}: github connector has no op "getCodexApproval"`,
      };
    }

    const outcome = await op(
      {},
      {
        workspacePath: ctx.workspacePath,
        params: ctx.params,
        rawParams: ctx.rawParams,
        hookLocalState: ctx.hookLocalState,
      }
    );

    if (!outcome.ok) {
      return outcome.retryable
        ? {
            type: 'retryable_block',
            reason: `${CODEX_LABEL}: ${outcome.error}`,
            retryAfterMs: outcome.retryAfterMs ?? CODEX_RETRY_INTERVAL_MS,
          }
        : { type: 'block', reason: `${CODEX_LABEL}: ${outcome.error}` };
    }

    const data = outcome.data as { prUrl?: string; headSha?: string; approved?: boolean };
    if (data.approved === true) {
      return {
        type: 'allow',
        data: {
          ...(typeof data.prUrl === 'string' ? { pr_url: data.prUrl } : {}),
          codex_approved: true,
          ...(typeof data.headSha === 'string' ? { head_sha: data.headSha } : {}),
        },
      };
    }

    return {
      type: 'retryable_block',
      reason: `${CODEX_LABEL}: no codex approval for current head`,
    };
  };
}
