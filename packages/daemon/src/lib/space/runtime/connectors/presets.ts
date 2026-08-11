/**
 * Coding-pack presets (epic #2299; promoted from the #2300 spike in P2 #2302).
 *
 * The coding capabilities expressed as `external_state` validators over the
 * github connector + domain-agnostic predicates. This is the L4 "coding pack"
 * over L3-over-L2 — the dogfood, and the epic's honesty test made concrete.
 *
 *   - `createPrReadyValidatorV2`   coder→reviewer handoff gate (the L3-over-L2
 *                                    expression of built_in `pr_ready`). The
 *                                    DEPLOYED `pr_ready` stays on the legacy
 *                                    impl (discovery + patch_params + reason
 *                                    strings) during a phased cutover; this V2
 *                                    form is the proven target.
 *   - `createPrMergedValidator`    mark_complete merge gate (PR must be MERGED).
 *                                    Net-new capability, wired directly as the
 *                                    registered `pr_merged` preset.
 *   - `createReviewPostedValidator` Review→Coding feedback gate (a formal review
 *                                    since run start, or — for an own PR — a
 *                                    comment). Backs the registered
 *                                    `review_posted` preset.
 *   - `createCodexApprovalValidator` codex approval gate as an L4 validator
 *                                    over the github connector, registered in
 *                                    production as the opt-in (OFF by default)
 *                                    `codex_review_approved` built_in. The
 *                                    legacy `codex_review_bot` gate feature
 *                                    still enforces codex on the default
 *                                    workflows; this preset is the simpler
 *                                    target it will migrate onto.
 *
 * Zero engine special-casing: each preset is (connector id, op name, predicate)
 * fed to the generic validator — or, for the codex gate, a hand-written L4
 * validator over the github connector (a plain allow / retryable-block
 * decision over the op's facts; no wait-state or timeout — the engine's
 * retryable-block scheduling is the only timer). `pr_merged` /
 * `codex_review_approved` / `review_posted` are registered in production via
 * `built-in-validators/index.ts`; the rest are exercised by tests and ready for
 * the pr_ready cutover.
 */

import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor';
import { getConnector, registerConnector } from './connector';
import {
  createExternalStateValidator,
  type ExternalStateValidatorConfig,
} from './external-state-validator';
import { createGithubConnector, GITHUB_CONNECTOR_ID } from './github-connector';
import type { Predicate } from './predicate';

const PR_READY_LABEL = 'PR is not ready for Review';
const PR_MERGED_LABEL = 'PR is not merged';
const CODEX_LABEL = 'codex review bot approval missing';

/**
 * Fallback `retryAfterMs` for the codex hook's failure path (rate limit /
 * transient connector error). The no-approval polling cadence is the hook's
 * configured `hook.retry.delayMs` (60s via the visual-editor default
 * serialization), NOT this constant — the validator omits `retryAfterMs` on
 * the no-approval branch so the engine applies the hook config.
 */
const CODEX_RETRY_INTERVAL_MS = 60_000;

/** Register the github connector so preset validators can resolve it by id.
 *  Safe to call repeatedly; overwrites. */
export function registerGithubConnector(
  spawnImpl: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
    Bun.spawn(...args)) as typeof Bun.spawn
): void {
  registerConnector(createGithubConnector(spawnImpl));
}

/**
 * Resolve the github op's `prUrl` param from the hook context: `data.pr_url`
 * in the bounded params → raw params → hook-local state. This is coding
 * knowledge (the `pr_url` field) and lives HERE in the L4 preset, not in the
 * domain-neutral L3 validator (epic #2299 honesty test).
 */
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

// ---------------------------------------------------------------------------
// pr_merged — mark_complete merge gate
// ---------------------------------------------------------------------------

/**
 * The merge gate: PR state must be MERGED before a task completes. OPEN is
 * pending (merge in flight); CLOSED-without-merge or lookup failure is a
 * terminal block.
 *
 * This preset is the registered `pr_merged` validator — a plain
 * `external_state` predicate on `state`. The historical `isPrMergedCompletionGate`
 * engine catch-all (a special-case NOT to replicate) no longer exists in the
 * tree; this preset is its generic replacement. (Exit criterion of #2302: the
 * engine special-cases neither `pr_ready` nor `pr_merged`.)
 */
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

// ---------------------------------------------------------------------------
// review_posted — Review→Coding feedback gate (own-PR fallback)
// ---------------------------------------------------------------------------

const REVIEW_POSTED_LABEL = 'no fresh GitHub review evidence';

/**
 * Policy for "has review evidence landed since the workflow started?":
 *   - a formal review (APPROVED / CHANGES_REQUESTED) by anyone, OR
 *   - on an own PR (viewer == author), a COMMENTED review or PR conversation
 *     comment.
 *
 * The own-PR gate is expressed HERE in the predicate (the policy), not hidden
 * in the op: the op merely supplies the `ownPr` FACT (prAuthor === viewer — the
 * one cross-field comparison the predicate language cannot do) plus the
 * since-start-filtered counts. GitHub blocks self-APPROVE, so comment-only
 * evidence is accepted only when the viewer owns the PR.
 */
const REVIEW_POSTED_PASS: Predicate = {
  any: [
    { gte: ['formalReviewCount', 1] },
    { all: [{ eq: ['ownPr', true] }, { gte: ['commentEvidenceCount', 1] }] },
  ],
};

/**
 * Resolve op params for the review-posted gate. `prUrl` is read from action
 * data / hook-local state (snake_case `pr_url` preferred, camelCase `prUrl`
 * accepted for parity with the pr_ready validator; `review_url`/`reviewUrl` — a
 * review permalink — accepted as a fallback since `gh pr view` resolves the PR
 * from either, matching the legacy REVIEW_POSTED bash). When no PR identity is
 * supplied anywhere, the resolver falls back to `ctx.frozenPrUrl` — the run's
 * authoritative reviewed PR stamped by the pr_ready hook — so a reviewer who
 * omits data.pr_url (the prompt guidance was lost in the gate→hook migration)
 * no longer false-blocks the Review→Coding feedback handoff. frozenPrUrl is
 * engine-only, so binding to it is safe; fail-closed when genuinely absent.
 *
 * The `sinceIso` workflow-start window comes from
 * `hookLocalState.workflowStartIso` (set by the gate evaluator when it
 * dispatches a built-in validator) or, on the hook path, from
 * `workflowRunCreatedAt`. This is coding knowledge (the `pr_url` field + the
 * workflow-start anchor) and lives in the L4 preset, not the L3 validator.
 */
function reviewPostedPrUrl(params: Record<string, unknown> | undefined): string | undefined {
  const data = params?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    // snake_case first (preferred), then camelCase for parity with the pr_ready
    // validator — the Reviewer's prompt may pass either form.
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

/**
 * Review→Coding feedback gate, re-expressed as an `external_state` validator.
 * Backs the `review_posted` built-in preset (the converted review-posted gate):
 * the Review→Coding channel only opens once a fresh GitHub review — or, for an
 * own PR, a comment — is visible. The decision matrix is the generic
 * validator's (allow / terminal-block / retryable-block on rate limit); there
 * is no `pending` predicate, matching the legacy bash which had no transient
 * state (a missing review is a plain block, not a poll).
 */
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

// ---------------------------------------------------------------------------
// codex_review_approved — the production codex +1 gate (L4, epic #2299 #2304)
// ---------------------------------------------------------------------------

/**
 * The production codex review gate, re-expressed as a declarative `built_in`
 * preset over the github connector's `getCodexApproval` op. This replaces the
 * legacy `codex_review_bot` gate feature + the four bash builders (epic #2299
 * #2304): the requirement is now a named preset an operator opts into via a
 * hook, and the engine special-cases no codex code.
 *
 * Decision matrix:
 *   - a codex bot PR review with state APPROVED on the current head
 *     (commit_id === head SHA) → allow.
 *   - a connector lookup failure → retryable (rate limit / transient) or
 *     terminal block.
 *   - otherwise → retryable_block so the handoff proceeds the moment the bot
 *     posts its approval.
 *
 * Approval is the head-specific signal codex actually emits (an APPROVED
 * review on a commit). A PR-level +1 reaction is intentionally not accepted:
 * it is not head-bound, so one left before a mid-run push would also satisfy
 * a newer, unreviewed head.
 *
 * This is deliberately an opt-in hook (OFF by default): it is not wired onto
 * any built-in workflow node, and the generic hook engine leaves
 * `enabled: false` hooks inert. There is no wait-state, timeout, or safety
 * valve — the engine's retryable-block scheduling is the only timer.
 *
 * Retry behavior: the engine auto-retries a retryable_block ONLY for
 * `send_message` (the coder→reviewer handoff this gate is designed for). On
 * terminal methods (mark_complete / approve_task / submit_for_approval) it
 * surfaces as a retryable error the agent must re-invoke — so for automatic
 * re-checking, attach the gate to the send_message handoff.
 */
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

    // The op resolves the PR from the workspace branch (engine/git-controlled)
    // and checks codex approval for THAT PR — ignoring the caller's pr_url,
    // which a prompt-injected agent could set to a foreign, already-approved
    // PR. No cross-PR guard is needed: the gate is inherently bound to the
    // run's actual PR (the workspace branch).
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
      // A connector lookup failure (rate limit / outage) must never open the
      // approval gate — map to retryable (rate limit) or terminal block.
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

    // No codex approval yet: retryable so the engine re-checks on its cadence
    // and the handoff proceeds the moment the bot posts its review. No explicit
    // retryAfterMs here — the engine applies the operator's hook.retry.delayMs
    // (+ backoff) when configured, else its default delay, so the visible delay
    // /backoff controls actually take effect.
    return {
      type: 'retryable_block',
      reason: `${CODEX_LABEL}: no codex approval for current head`,
    };
  };
}
