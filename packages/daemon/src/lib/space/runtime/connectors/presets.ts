/**
 * Coding-pack presets (THROWAWAY spike, #2300).
 *
 * The three capabilities the spike re-expresses, each as an `external_state`
 * validator over the github connector + a domain-agnostic predicate. This is
 * the L4 "coding pack" over L3-over-L2 — the dogfood.
 *
 *   - `createPrReadyValidatorV2`   coder→reviewer handoff gate (was built_in `pr_ready`)
 *   - `createPrMergedValidator`    mark_complete merge gate (PR must be MERGED)
 *   - `createCodexReviewBotValidator` codex +1 reaction gate (was the
 *                                     `codex_review_bot` gate feature)
 *
 * Plus `pollUntilAllow`, an L3 composition primitive that demonstrates how the
 * codex timeout-allow ("after N seconds, open the gate without a +1") composes
 * from generic primitives rather than a coding-specific engine branch.
 *
 * Zero engine special-casing: each preset is just (connector id, op name,
 * predicates) fed to the generic validator. Nothing here is referenced by the
 * production hook executor or hook engine.
 */

import type { HookExecutorContext } from '../hook-executor';
import type { WorkflowHookResult } from '@hyperneo/shared';
import { registerConnector } from './connector';
import { createGithubConnector, GITHUB_CONNECTOR_ID } from './github-connector';
import {
  createExternalStateValidator,
  type ExternalStateValidatorConfig,
} from './external-state-validator';
import type { Predicate } from './predicate';

const PR_READY_LABEL = 'PR is not ready for Review';
const PR_MERGED_LABEL = 'PR is not merged';
const CODEX_LABEL = 'codex review bot approval missing';

/** Register the github connector so preset validators can resolve it by id.
 *  Safe to call repeatedly; overwrites. */
export function registerGithubConnector(spawnImpl: typeof Bun.spawn = Bun.spawn): void {
  registerConnector(createGithubConnector(spawnImpl));
}

// ---------------------------------------------------------------------------
// pr_ready — coder→reviewer handoff gate
// ---------------------------------------------------------------------------

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

/**
 * Re-expression of the built-in `pr_ready` validator. Same decision matrix:
 * open + mergeable + cleanish mergeState + no unresolved threads → allow;
 * UNKNOWN mergeability/checks → retryable; anything else → block.
 *
 * The "no unresolved review threads" leg is what forced a COMPOSITE op
 * (`github.getPrReadiness`) — see github-connector.ts. That is the pr_ready
 * finding: a multi-lookup gate is one connector op, not two predicate passes.
 */
export function createPrReadyValidatorV2(
  spawnImpl: typeof Bun.spawn = Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  registerGithubConnector(spawnImpl);
  const config: ExternalStateValidatorConfig = {
    connector: GITHUB_CONNECTOR_ID,
    op: 'getPrReadiness',
    pass: PR_READY_PASS,
    pending: PR_READY_PENDING,
    label: PR_READY_LABEL,
    dataProjection: (data) => ({
      pr_url: typeof data.url === 'string' ? data.url : undefined,
    }),
  };
  return createExternalStateValidator(config);
}

// ---------------------------------------------------------------------------
// pr_merged — mark_complete merge gate
// ---------------------------------------------------------------------------

/**
 * The merge gate: PR state must be MERGED before a task completes. OPEN is
 * pending (merge in flight); CLOSED-without-merge or lookup failure is a
 * terminal block.
 *
 * The issue referenced an `isPrMergedCompletionGate` engine catch-all as a
 * special-case NOT to replicate; this preset replaces that shape with a plain
 * external_state predicate on `state`. (In the current tree that catch-all no
 * longer exists — the merge is driven by the post-approval reviewer session —
 * so this preset is the forward-looking expression of the capability.)
 */
export function createPrMergedValidator(
  spawnImpl: typeof Bun.spawn = Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  registerGithubConnector(spawnImpl);
  const config: ExternalStateValidatorConfig = {
    connector: GITHUB_CONNECTOR_ID,
    op: 'getPr',
    pass: { eq: ['state', 'MERGED'] },
    pending: { eq: ['state', 'OPEN'] },
    label: PR_MERGED_LABEL,
  };
  return createExternalStateValidator(config);
}

// ---------------------------------------------------------------------------
// codex_review_bot — codex +1 reaction gate
// ---------------------------------------------------------------------------

/** A fresh codex-bot +1 reaction exists on the PR. The `getReactions` op has
 *  already dropped reactions older than the freshness anchor (cycle_start_at),
 *  so the predicate is a static exists-check — no temporal logic here. */
const CODEX_PLUS_ONE: Predicate = {
  exists: {
    select: 'reactions',
    where: {
      all: [
        { contains: ['login', 'codex'] },
        { endswith: ['login', '[bot]'] },
        { eq: ['content', '+1'] },
      ],
    },
  },
};

/** Resolve op params for the codex gate: prUrl + the freshness anchor
 *  (`sinceIso`), read from hook-local state (set per cycle). The freshness
 *  anchor is what filters out +1s from prior review cycles. */
function codexParamResolver(ctx: HookExecutorContext): Record<string, unknown> {
  const data = ctx.params?.data;
  const dataPrUrl =
    data && typeof data === 'object' && typeof (data as Record<string, unknown>).pr_url === 'string'
      ? ((data as Record<string, unknown>).pr_url as string)
      : undefined;
  const prUrl = prUrlFromState(ctx.hookLocalState) ?? dataPrUrl ?? rawPrUrl(ctx.rawParams);
  const sinceIso =
    typeof ctx.hookLocalState?.freshnessIso === 'string'
      ? (ctx.hookLocalState.freshnessIso as string)
      : undefined;
  return prUrl ? { prUrl, sinceIso } : {};
}

function prUrlFromState(state: Record<string, unknown> | undefined): string | undefined {
  return typeof state?.pr_url === 'string' ? state.pr_url : undefined;
}

function rawPrUrl(rawParams: Record<string, unknown> | undefined): string | undefined {
  const data = rawParams?.data;
  if (
    data &&
    typeof data === 'object' &&
    typeof (data as Record<string, unknown>).pr_url === 'string'
  ) {
    return (data as Record<string, unknown>).pr_url as string;
  }
  return undefined;
}

/**
 * Re-expression of the `codex_review_bot` gate feature. The core — "a codex
 * bot left a fresh +1" — is a static predicate over the `getReactions` op.
 *
 * `pending` is a tautology (`all: []`) so a missing +1 yields
 * `retryable_block` (keep polling) rather than a terminal block — the validator
 * never hard-fails just because the bot hasn't reacted yet. The production
 * feature's OTHER two behaviours — eyes-reaction "still in progress" guidance
 * and the timeout-allow after N seconds — compose from generic L3 primitives
 * (see `pollUntilAllow`); they are not coding-specific.
 */
export function createCodexReviewBotValidator(
  spawnImpl: typeof Bun.spawn = Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  registerGithubConnector(spawnImpl);
  const config: ExternalStateValidatorConfig = {
    connector: GITHUB_CONNECTOR_ID,
    op: 'getReactions',
    params: codexParamResolver,
    pass: CODEX_PLUS_ONE,
    // No fresh +1 → keep polling (retryable), never terminal-block.
    pending: { all: [] },
    label: CODEX_LABEL,
  };
  return createExternalStateValidator(config);
}

// ---------------------------------------------------------------------------
// pollUntilAllow — L3 composition primitive (demonstrates codex timeout)
// ---------------------------------------------------------------------------

/**
 * Wrap a validator so that once `isExpired(ctx)` is true, a PREDICATE-PENDING
 * `retryable_block` is converted to an `allow` carrying `warningData`. This is
 * how the codex "after N seconds with no +1, open the gate anyway" timeout
 * composes from a generic primitive: the inner validator owns pass/pending,
 * this wrapper owns the deadline. No coding knowledge lives here.
 *
 * Only results the inner validator tagged `externalStatePending` (i.e. the
 * predicate genuinely hasn't been satisfied yet, like "no +1 so far") are
 * eligible. A connector LOOKUP FAILURE that surfaces as `retryable_block`
 * (rate limit, outage) is passed through untouched — an outage must never open
 * the approval gate. This mirrors the production codex gate, which fails before
 * its timeout when the reactions fetch errors (gate-features.ts:309-313).
 *
 * `isExpired` typically compares an approval-handoff anchor in hook-local
 * state against a timeout; the spike tests it with a literal flag.
 */
export function pollUntilAllow(
  inner: (context: HookExecutorContext) => Promise<WorkflowHookResult>,
  isExpired: (ctx: HookExecutorContext) => boolean,
  warningData: Record<string, unknown>
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  return async (ctx) => {
    const result = await inner(ctx);
    const isPending =
      result.type === 'retryable_block' && result.data?.externalStatePending === true;
    if (isPending && isExpired(ctx)) {
      return { type: 'allow', data: warningData };
    }
    return result;
  };
}
