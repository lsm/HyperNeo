import { resolveGithubConfigDir, runGhJson } from '../gh-lookup-helpers.ts';
import { parsePrUrl } from '../parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import type { Connector, ConnectorContext, ConnectorOp, ConnectorOutcome } from './connector.ts';

const GITHUB_CONNECTOR_ID = 'github';

const GITHUB_SANDBOX_ENV_KEYS: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
];

export function createGithubConnector(spawnImpl: SpawnFn = spawnProcess): Connector {
  return {
    id: GITHUB_CONNECTOR_ID,
    auth: {
      envKeys: GITHUB_SANDBOX_ENV_KEYS,
      resolveExtraEnv: () => ({ GH_CONFIG_DIR: resolveGithubConfigDir() }),
    },
    ops: {
      getPr: makeGetPrOp(spawnImpl),

      getPrReadiness: makeGetPrReadinessOp(spawnImpl),

      getReactions: makeGetReactionsOp(spawnImpl),

      getCodexApproval: makeGetCodexApprovalOp(spawnImpl),

      getReviewEvidence: makeGetReviewEvidenceOp(spawnImpl),
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validatePrLookupHost(prUrl: string): ConnectorOutcome | null {
  let inputHost: string | undefined;
  try {
    inputHost = new URL(prUrl).hostname || undefined;
  } catch {
    return null;
  }
  const allowedHost = process.env.GH_HOST || 'github.com';
  if (inputHost !== 'github.com' && inputHost !== allowedHost) {
    return {
      ok: false,
      error: `PR host ${inputHost} is not allowed for GitHub lookups (allowed: github.com${
        allowedHost !== 'github.com' ? `, ${allowedHost}` : ''
      })`,
    };
  }
  return null;
}

function makeGetPrOp(spawnImpl: SpawnFn): ConnectorOp {
  return async (opParams, ctx): Promise<ConnectorOutcome> => {
    const prUrl = asString(opParams.prUrl);
    if (!prUrl) return { ok: false, error: 'prUrl is required' };
    const hostError = validatePrLookupHost(prUrl);
    if (hostError) return hostError;
    return runGhJson(
      ['gh', 'pr', 'view', prUrl, '--json', 'url,state,mergeable,mergeStateStatus'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { resourceHint: 'graphql' }
    );
  };
}

function makeGetPrReadinessOp(spawnImpl: SpawnFn): ConnectorOp {
  return async (opParams, ctx): Promise<ConnectorOutcome> => {
    const prUrl = asString(opParams.prUrl);
    if (!prUrl) return { ok: false, error: 'prUrl is required' };

    const prOutcome = await runGhJson(
      ['gh', 'pr', 'view', prUrl, '--json', 'url,state,mergeable,mergeStateStatus'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { resourceHint: 'graphql' }
    );
    if (!prOutcome.ok) return prOutcome;

    const canonicalUrl = asString((prOutcome.data as Record<string, unknown>)?.url);
    const meta = parsePrUrl(prUrl) ?? (canonicalUrl ? parsePrUrl(canonicalUrl) : null);
    if (!meta) {
      return {
        ok: false,
        error: `unable to parse PR URL for review-threads lookup: ${canonicalUrl ?? prUrl}`,
      };
    }

    const threadsOutcome = await fetchUnresolvedReviewThreads(meta, ctx, spawnImpl);
    if (!threadsOutcome.ok) return threadsOutcome;

    const unresolvedThreadUrls = (threadsOutcome.data as { unresolvedThreadUrls: string[] })
      .unresolvedThreadUrls;
    return {
      ok: true,
      data: {
        ...(prOutcome.data as Record<string, unknown>),
        unresolvedThreadUrls,
      },
    };
  };
}

function makeGetReactionsOp(spawnImpl: SpawnFn): ConnectorOp {
  return async (opParams, ctx): Promise<ConnectorOutcome> => {
    const prUrl = asString(opParams.prUrl);
    if (!prUrl) return { ok: false, error: 'prUrl is required' };
    const meta = parsePrUrl(prUrl);
    if (!meta) return { ok: false, error: `unable to parse GitHub PR URL: ${prUrl}` };

    const outcome = await runGhJson(
      [
        'gh',
        'api',
        '--hostname',
        meta.host,
        `repos/${meta.owner}/${meta.repo}/issues/${meta.number}/reactions?per_page=100`,
        '-H',
        'Accept: application/vnd.github+json',
      ],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { hostHint: meta.host, resourceHint: 'core' }
    );
    if (!outcome.ok) return outcome;

    const raw = outcome.data;
    const list = normaliseReactionsPayload(raw);
    const sinceIso = normaliseIso(asString(opParams.sinceIso));
    const reactions = list
      .map((r) => {
        const node = r as Record<string, unknown>;
        const user = node.user as Record<string, unknown> | undefined;
        return {
          login: asString(user?.login) ?? '',
          content: asString(node.content) ?? '',
          createdAt: normaliseIso(asString(node.created_at)) ?? '',
        };
      })
      .filter((r) => !sinceIso || (r.createdAt.length > 0 && r.createdAt >= sinceIso));
    return { ok: true, data: { reactions } };
  };
}

function makeGetCodexApprovalOp(spawnImpl: SpawnFn): ConnectorOp {
  return async (_opParams, ctx): Promise<ConnectorOutcome> => {
    const wsOutcome = await runGhJson(
      ['gh', 'pr', 'view', '--json', 'url'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { resourceHint: 'graphql', stripGHRepo: true }
    );
    if (!wsOutcome.ok) return wsOutcome;
    const prUrl = asString((wsOutcome.data as { url?: unknown })?.url);
    if (!prUrl) {
      return {
        ok: false,
        error:
          'No PR on the current workspace branch — open a PR before the codex gate can verify it.',
      };
    }

    let inputHost: string | undefined;
    try {
      inputHost = new URL(prUrl).hostname || undefined;
    } catch {}
    if (inputHost) {
      const allowedHost = process.env.GH_HOST || 'github.com';
      if (inputHost !== 'github.com' && inputHost !== allowedHost) {
        return {
          ok: false,
          error: `PR host ${inputHost} is not allowed for GitHub lookups (allowed: github.com${
            allowedHost !== 'github.com' ? `, ${allowedHost}` : ''
          })`,
        };
      }
    }

    const meta = parsePrUrl(prUrl);
    if (!meta) return { ok: false, error: `Unable to parse GitHub PR URL: ${prUrl}` };

    const prOutcome = await runGhJson(
      ['gh', 'pr', 'view', prUrl, '--json', 'number,headRefOid,url'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { hostHint: meta.host, resourceHint: 'graphql' }
    );
    if (!prOutcome.ok) return prOutcome;
    const prData = prOutcome.data as { headRefOid?: string; url?: string };
    const headSha = asString(prData.headRefOid);
    if (!headSha) {
      return { ok: false, error: 'Failed to resolve current head SHA for codex approval check' };
    }

    const reviews: Array<{ login: string; state: string; commitId: string }> = [];
    let page = 1;
    for (; page <= 10; page++) {
      const pageOutcome = await runGhJson(
        [
          'gh',
          'api',
          '--hostname',
          meta.host,
          `repos/${meta.owner}/${meta.repo}/pulls/${meta.number}/reviews?per_page=100&page=${page}`,
        ],
        ctx.workspacePath || '/tmp',
        spawnImpl,
        { hostHint: meta.host, resourceHint: 'core' }
      );
      if (!pageOutcome.ok) return pageOutcome;
      const batch = Array.isArray(pageOutcome.data) ? pageOutcome.data : [];
      for (const rv of batch) {
        const node = rv as Record<string, unknown>;
        const user = node.user as Record<string, unknown> | undefined;
        reviews.push({
          login: asString(user?.login) ?? '',
          state: asString(node.state) ?? '',
          commitId: asString(node.commit_id) ?? '',
        });
      }
      if (batch.length < 100) break;
    }
    if (page > 10) {
      return {
        ok: false,
        error:
          'codex review history exceeds the 1000-review scan cap; cannot safely determine the latest verdict (fail closed)',
      };
    }

    const isCodexBot = (login: string): boolean =>
      login.toLowerCase().includes('codex') && login.endsWith('[bot]');

    const codexHeadReviews = reviews.filter((r) => isCodexBot(r.login) && r.commitId === headSha);
    const decisive = codexHeadReviews.filter((r) => {
      const s = r.state.toUpperCase();
      return s === 'APPROVED' || s === 'CHANGES_REQUESTED';
    });
    const latestDecisiveState =
      decisive.length > 0 ? decisive[decisive.length - 1].state.toUpperCase() : undefined;
    const approved = latestDecisiveState === 'APPROVED';

    if (approved) {
      const recheck = await runGhJson(
        ['gh', 'pr', 'view', prUrl, '--json', 'headRefOid'],
        ctx.workspacePath || '/tmp',
        spawnImpl,
        { hostHint: meta.host, resourceHint: 'graphql' }
      );
      if (!recheck.ok) return recheck;
      const currentHead = asString((recheck.data as { headRefOid?: unknown })?.headRefOid);
      if (!currentHead || currentHead !== headSha) {
        return {
          ok: false,
          retryable: true,
          error: 'PR head changed during codex approval check; re-checking',
          retryAfterMs: 30_000,
        };
      }
    }

    return {
      ok: true,
      data: {
        prUrl: asString(prData.url) ?? prUrl,
        headSha,
        approved,
      },
    };
  };
}

function makeGetReviewEvidenceOp(spawnImpl: SpawnFn): ConnectorOp {
  return async (opParams, ctx): Promise<ConnectorOutcome> => {
    const prUrl = asString(opParams.prUrl);
    if (!prUrl) return { ok: false, error: 'prUrl is required' };
    const sinceIso = normaliseIso(asString(opParams.sinceIso));
    if (!sinceIso) {
      return {
        ok: false,
        error: 'sinceIso (workflow start) is required — cannot determine review window',
      };
    }

    const hostError = validatePrLookupHost(prUrl);
    if (hostError) return hostError;

    const prOutcome = await runGhJson(
      ['gh', 'pr', 'view', prUrl, '--json', 'reviews,comments,author,url'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { resourceHint: 'graphql' }
    );
    if (!prOutcome.ok) return prOutcome;

    const prData = (prOutcome.data ?? {}) as {
      url?: string;
      author?: { login?: string };
      reviews?: Array<{ submittedAt?: string; state?: string }>;
      comments?: Array<{ createdAt?: string }>;
    };

    let viewerLogin: string | undefined;
    const canonicalUrl = asString(prData.url);
    const viewerMeta = parsePrUrl(prUrl) ?? (canonicalUrl ? parsePrUrl(canonicalUrl) : null);
    const viewerHostArgs = viewerMeta ? ['--hostname', viewerMeta.host] : [];
    const viewerOutcome = await runGhJson(
      ['gh', 'api', ...viewerHostArgs, 'user'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { hostHint: viewerMeta?.host, resourceHint: 'core' }
    );
    if (
      viewerOutcome.ok &&
      viewerOutcome.data &&
      typeof viewerOutcome.data === 'object' &&
      !Array.isArray(viewerOutcome.data)
    ) {
      viewerLogin = asString((viewerOutcome.data as { login?: unknown }).login);
    }

    const authorLogin = asString(prData.author?.login);
    const ownPr = Boolean(authorLogin && viewerLogin && authorLogin === viewerLogin);

    const isSince = (iso: string | undefined): boolean => {
      const n = normaliseIso(asString(iso));
      return n !== undefined && n > sinceIso;
    };

    const reviews = prData.reviews ?? [];
    const formalReviewCount = reviews.filter(
      (r) => isSince(r.submittedAt) && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
    ).length;
    const commentedReviewCount = reviews.filter(
      (r) => isSince(r.submittedAt) && r.state === 'COMMENTED'
    ).length;
    const prCommentCount = (prData.comments ?? []).filter((c) => isSince(c.createdAt)).length;
    const commentEvidenceCount = commentedReviewCount + prCommentCount;

    if (!viewerOutcome.ok && formalReviewCount === 0 && commentEvidenceCount > 0) {
      return viewerOutcome;
    }

    const hasFormal = formalReviewCount > 0;
    const reviewEvidence = hasFormal
      ? 'formal_review'
      : ownPr && commentEvidenceCount > 0
        ? 'own_pr_comment'
        : null;
    const reviewCount = hasFormal ? formalReviewCount : ownPr ? commentEvidenceCount : 0;

    return {
      ok: true,
      data: {
        url: asString(prData.url) ?? prUrl,
        ownPr,
        formalReviewCount,
        commentEvidenceCount,
        reviewEvidence,
        reviewCount,
      },
    };
  };
}

function normaliseIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const dot = value.indexOf('.');
  return dot >= 0 ? `${value.slice(0, dot)}Z` : value;
}

function normaliseReactionsPayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray((raw as Record<string, unknown> | null)?.items)) {
    return (raw as { items: unknown[] }).items;
  }
  return [];
}

interface ReviewThreadsPage {
  nodes: Array<{ id?: string; isResolved: boolean; comments: { nodes: Array<{ url: string }> } }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function fetchUnresolvedReviewThreads(
  meta: { host: string; owner: string; repo: string; number: string },
  ctx: ConnectorContext,
  spawnImpl: SpawnFn
): Promise<ConnectorOutcome> {
  const urls: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 50; page++) {
    const query = cursor
      ? 'query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}'
      : 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}';
    const args = [
      'gh',
      'api',
      'graphql',
      '--hostname',
      meta.host,
      '-f',
      `owner=${meta.owner}`,
      '-f',
      `name=${meta.repo}`,
      '-F',
      `number=${meta.number}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    args.push('-f', `query=${query}`);
    const outcome = await runGhJson(args, ctx.workspacePath || '/tmp', spawnImpl, {
      hostHint: meta.host,
      resourceHint: 'graphql',
    });
    if (!outcome.ok) return outcome;

    const threads = (
      outcome.data as {
        data?: { repository?: { pullRequest?: { reviewThreads?: ReviewThreadsPage } } };
      }
    )?.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) {
      return { ok: false, error: 'Incomplete GraphQL response — reviewThreads missing' };
    }
    for (const node of threads.nodes) {
      if (!node.isResolved) {
        urls.push(node.comments.nodes[0]?.url ?? node.id ?? '<unknown>');
      }
    }
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
    if (!cursor) {
      return { ok: false, error: 'Incomplete pagination: hasNextPage true but endCursor missing' };
    }
  }

  return { ok: true, data: { unresolvedThreadUrls: urls } };
}

export { GITHUB_CONNECTOR_ID };
