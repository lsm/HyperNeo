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
 *   - `createCodexApprovalValidator` codex +1 gate (the L4 expression of the
 *                                    legacy `codex_review_bot` gate feature).
 *                                    #2304 unified the feature onto this preset
 *                                    and deleted the gate-feature + bash
 *                                    mechanism; it is registered in production
 *                                    as the `codex_review_approved` built_in.
 *
 * Zero engine special-casing: each preset is (connector id, op name, predicate)
 * fed to the generic validator — or, for the codex gate, a hand-written L4
 * validator over the github connector (the wait-state-machine + timeout-allow
 * it owns are domain logic, expressed in L4 not the engine). `pr_merged` /
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
 * Default timeout (seconds) for the codex review bot reaction check.
 *
 * Codex reviews on large PRs routinely take 20–30 minutes; the previous 600s
 * (10 min) default timed out before the bot posted its +1, which silently
 * re-opened approval gates. 7200s (2 hours) gives the bot room to finish while
 * still bounding the wait. Operators can override globally via
 * `HYPERNEO_CODEX_REVIEW_BOT_TIMEOUT_SECONDS`. The per-node
 * `codexTimeoutSeconds` override is intentionally NOT honored — it was part of
 * the legacy requireCodexApproval runtime-injection split being deleted (epic
 * #2299); the global env knob is the operator control.
 */
const DEFAULT_CODEX_REVIEW_BOT_TIMEOUT_SECONDS = 7200;

/**
 * Parse a candidate timeout (seconds) for the codex review bot reaction check.
 * Accepts finite positive integers only; falls back to the supplied default
 * otherwise. Strictness matches `SpaceWorkflowManager.validateCodexTimeout`.
 */
function resolveCodexTimeoutSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed) ? parsed : fallback;
}

/** The effective codex approval timeout (seconds), env-overridable. */
const CODEX_REVIEW_BOT_TIMEOUT_SECONDS = resolveCodexTimeoutSeconds(
  process.env.HYPERNEO_CODEX_REVIEW_BOT_TIMEOUT_SECONDS,
  DEFAULT_CODEX_REVIEW_BOT_TIMEOUT_SECONDS
);

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
 * Resolve op params for the review-posted gate: `prUrl` (from action data /
 * hook-local state) plus the `sinceIso` workflow-start window. The window comes
 * from `hookLocalState.workflowStartIso` (set by the gate evaluator when it
 * dispatches a built-in validator) or, on the hook path, from
 * `workflowRunCreatedAt`. This is coding knowledge (the `pr_url` field + the
 * workflow-start anchor) and lives in the L4 preset, not the L3 validator.
 *
 * `pr_url` is preferred but `review_url` (a review permalink) is accepted as a
 * fallback — `gh pr view` resolves the PR from either, matching the legacy
 * REVIEW_POSTED bash (`PR_URL=$(jq -r '.pr_url // .review_url // empty' ...)`).
 */
function reviewPostedPrUrl(params: Record<string, unknown> | undefined): string | undefined {
  const data = params?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (typeof d.pr_url === 'string') return d.pr_url;
    if (typeof d.review_url === 'string') return d.review_url;
  }
  return undefined;
}

function reviewPostedPrUrlFromState(
  state: Record<string, unknown> | undefined
): string | undefined {
  if (typeof state?.pr_url === 'string') return state.pr_url;
  if (typeof state?.review_url === 'string') return state.review_url;
  return undefined;
}

function reviewPostedParamResolver(ctx: HookExecutorContext): Record<string, unknown> {
  const prUrl =
    reviewPostedPrUrl(ctx.params) ??
    (ctx.rawParams ? reviewPostedPrUrl(ctx.rawParams) : undefined) ??
    reviewPostedPrUrlFromState(ctx.hookLocalState);
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
 * Resolve the PR URL for the codex gate from the hook context. Accepts:
 *   - `params.data.pr_url` / `params.pr_url` (a `send_message` carries
 *     `data.pr_url`; the terminal `submit_for_approval` / `approve_task` carry
 *     `pr_url` at the top level once added to their schemas),
 *   - `hookLocalState.pr_url` (recorded when a prior send_message allowed), or
 *   - the raw params equivalents.
 * The connector op additionally falls back to resolving the PR from the
 * workspace branch, so a reviewer that never passed pr_url still works.
 */
function codexApprovalPrUrl(ctx: HookExecutorContext): string | undefined {
  const readData = (params: Record<string, unknown> | undefined): string | undefined => {
    const data = params?.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const v = (data as Record<string, unknown>).pr_url;
      if (typeof v === 'string') return v;
    }
    return undefined;
  };
  const agentPrUrl =
    readData(ctx.params) ??
    (typeof ctx.params?.pr_url === 'string' ? ctx.params.pr_url : undefined) ??
    readData(ctx.rawParams) ??
    (typeof ctx.rawParams?.pr_url === 'string' ? ctx.rawParams.pr_url : undefined);
  // The CANONICAL PR of the workflow run takes precedence over an agent-supplied
  // pr_url so a terminal action cannot redirect the codex check to an unrelated
  // PR that happens to already carry a +1 (wrong-PR bypass). The PRIMARY PR
  // link artifact (the latest saved link) takes precedence over hook-local
  // state: if the workflow moved from PR A to PR B, the artifact reflects B
  // while hook-local state may still carry A from a prior cycle.
  const artifactPrUrl = resolvePrimaryPrLink(ctx);
  const cachedPrUrl =
    typeof ctx.hookLocalState?.pr_url === 'string' ? ctx.hookLocalState.pr_url : undefined;
  return artifactPrUrl ?? cachedPrUrl ?? agentPrUrl;
}

/** The primary PR `link` artifact saved by a workflow agent (e.g. the coder's
 *  `save_artifact({ shape: "link", kind: "pr", data: { url } })`). */
function resolvePrimaryPrLink(ctx: HookExecutorContext): string | undefined {
  for (const artifact of ctx.currentArtifacts ?? []) {
    if (artifact.type !== 'link' || artifact.key !== 'pr') continue;
    const data = artifact.data as { url?: unknown } | undefined;
    if (typeof data?.url === 'string') return data.url;
  }
  return undefined;
}

/**
 * The production codex review gate, re-expressed as a declarative `built_in`
 * preset over the github connector's `getCodexApproval` op. This replaces the
 * legacy `codex_review_bot` gate feature + the four bash builders (epic #2299
 * #2304): the requirement is now a named preset on the template hook, and the
 * engine special-cases no codex code.
 *
 * Decision matrix (mirrors the legacy migration bash):
 *   - codex bot commented on the CURRENT head → allow.
 *   - a codex +1 for the current cycle → allow. On the FIRST check the
 *     freshness anchor is the workflow-run start, so a reviewer that waited for
 *     codex before closing (terminal flow) is not made stale by starting the
 *     wait after the +1; on subsequent checks the anchor is the wait start (head
 *     unchanged).
 *   - otherwise record the wait start (`codex_wait_started_at` +
 *     `codex_wait_head_oid` in the result data, persisted to hook-local state)
 *     and return a RETRYABLE block whose `retryAfterMs` is the remaining time to
 *     the timeout — the engine auto-reevaluates, so the two-hour safety valve
 *     opens even when the caller never re-invokes (a codex quota outage must not
 *     deadlock a terminal action).
 *   - once the wait has elapsed `CODEX_REVIEW_BOT_TIMEOUT_SECONDS`, allow with a
 *     timeout warning.
 *
 * The wait window starts when the gate first runs (i.e. AFTER the approval
 * votes / reviewer-approved condition passes, because the approval hook is
 * ordered first and short-circuits on its non-retryable block). That preserves
 * the legacy behavior where the 2h window ran from the approval handoff.
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

    const state = ctx.hookLocalState ?? {};
    const waitStarted =
      typeof state.codex_wait_started_at === 'string' ? state.codex_wait_started_at : undefined;
    const waitHead =
      typeof state.codex_wait_head_oid === 'string' ? state.codex_wait_head_oid : undefined;
    // GATE path: when this validator is attached as a gate's `validator` (the
    // gate-on-external-state primitive for retained custom approval gates),
    // `runGateValidator` sets `workflowStartIso` + `gateDataUpdatedIso` in
    // hook-local state — the hook path never sets either. On the gate path there
    // is no persisted wait-state: the FRESHNESS anchor is `cycle_start_at` (a
    // millisecond epoch injected into gate data and reset on every cyclic
    // revision) converted to ISO — so a +1 from a PREVIOUS cycle is filtered
    // out even when the PR head is unchanged. The TIMEOUT anchor is
    // `gateDataUpdatedIso` (the last approval handoff, mirroring the legacy
    // HYPERNEO_GATE_DATA_UPDATED_ISO) so a long-running workflow gets a full
    // post-approval codex window instead of timing out immediately.
    const gatePathStartIso =
      typeof state.workflowStartIso === 'string' ? state.workflowStartIso : undefined;
    // cycle_start_at is a millisecond epoch in gate data; convert to ISO.
    const cycleStartIso =
      typeof state.cycle_start_at === 'number' && Number.isFinite(state.cycle_start_at)
        ? new Date(state.cycle_start_at).toISOString()
        : undefined;
    const gateDataUpdatedIso =
      typeof state.gateDataUpdatedIso === 'string' ? state.gateDataUpdatedIso : undefined;
    const prUrl = codexApprovalPrUrl(ctx);
    // Freshness anchor: the wait start once started; before that, prefer the
    // current cycle start (reset per revision), falling back to the workflow
    // start, so a current-cycle +1 is honored on the first check but a stale
    // previous-cycle +1 is not.
    const sinceIso =
      waitStarted ?? cycleStartIso ?? gatePathStartIso ?? resolveWorkflowStartIso(ctx);
    // Check the timeout BEFORE the connector call: if the wait has already
    // elapsed, allow immediately even if the connector is rate-limited — a
    // prolonged GitHub outage must not defeat the 2h deadlock safety valve.
    const preCheckWaitMs = waitStarted !== undefined ? Date.parse(waitStarted) : NaN;
    const preCheckAnchorMs = Number.isFinite(preCheckWaitMs)
      ? preCheckWaitMs
      : gateDataUpdatedIso
        ? Date.parse(gateDataUpdatedIso)
        : cycleStartIso
          ? Date.parse(cycleStartIso)
          : gatePathStartIso
            ? Date.parse(gatePathStartIso)
            : NaN;
    const timeoutMs = CODEX_REVIEW_BOT_TIMEOUT_SECONDS * 1000;
    const preCheckElapsed = Number.isFinite(preCheckAnchorMs) ? Date.now() - preCheckAnchorMs : 0;
    if (preCheckElapsed >= timeoutMs) {
      return {
        type: 'allow',
        data: {
          codex_approved: false,
          codex_timed_out: true,
          codex_warning: 'codex review bot +1 reaction missing after timeout; allowing gate',
        },
      };
    }

    const outcome = await op(prUrl ? { prUrl, sinceIso } : {}, {
      workspacePath: ctx.workspacePath,
      params: ctx.params,
      rawParams: ctx.rawParams,
      hookLocalState: ctx.hookLocalState,
    });

    if (!outcome.ok) {
      // A connector lookup failure (rate limit / outage) must never open the
      // approval gate — map to retryable (rate limit) or terminal block.
      return outcome.retryable
        ? {
            type: 'retryable_block',
            reason: `${CODEX_LABEL}: ${outcome.error}`,
            retryAfterMs: outcome.retryAfterMs ?? 30_000,
          }
        : { type: 'block', reason: `${CODEX_LABEL}: ${outcome.error}` };
    }

    const data = outcome.data as {
      prUrl?: string;
      headSha?: string;
      commentOnHead?: boolean;
      freshPlusOne?: boolean;
    };
    const headSha = data.headSha;
    const commentOnHead = data.commentOnHead === true;
    const freshPlusOne = data.freshPlusOne === true;
    const waitHeadMatches = waitHead !== undefined && headSha !== undefined && waitHead === headSha;

    // A current-cycle codex +1 counts: on the first check (no wait started) it is
    // relative to the run/cycle start, so a pre-close +1 is honored; once the
    // wait is running it must be fresh since the wait start AND on the same head.
    // When the head has CHANGED from the wait head to the current head and codex
    // has already +1'd the new head, that is valid evidence — the +1 is anchored
    // to the new head's push time, which the connector already verified. Rejecting
    // it would restart the wait with NOW as the anchor, making the valid +1 stale
    // on every subsequent poll and delaying to the 2h timeout.
    const headChangedToCurrent =
      waitHead !== undefined && headSha !== undefined && waitHead !== headSha;
    const plusOneAllows =
      waitStarted === undefined
        ? freshPlusOne
        : headChangedToCurrent
          ? freshPlusOne // head changed → the +1 is for the current head, accept it
          : waitHeadMatches && freshPlusOne; // same head → must be fresh since wait start
    if (commentOnHead || plusOneAllows) {
      return {
        type: 'allow',
        data: {
          ...(typeof data.prUrl === 'string' ? { pr_url: data.prUrl } : {}),
          codex_approved: true,
          ...(headSha ? { head_sha: headSha } : {}),
        },
      };
    }

    const nowIso = new Date().toISOString();
    // A wait is "ongoing" only when started AND the head is unchanged AND the
    // anchor parses. A head change, a first miss, or a corrupted anchor
    // (unparseable timestamp) starts/restarts the window — a corrupt anchor must
    // never deadlock the timeout-allow.
    const waitStartMs = waitStarted !== undefined ? Date.parse(waitStarted) : NaN;
    const waitOngoing =
      waitStarted !== undefined &&
      headSha !== undefined &&
      waitHead === headSha &&
      Number.isFinite(waitStartMs);

    // Timeout anchor: the persisted wait start (hook path, once the wait began);
    // on the GATE path, `gateDataUpdatedIso` (the last approval handoff —
    // mirrors the legacy HYPERNEO_GATE_DATA_UPDATED_ISO), falling back to the
    // workflow start when no approval write has happened yet. On the hook path's
    // FIRST call the anchor is absent, so the 2h window is armed from the
    // approval handoff (the legacy semantics).
    const timeoutAnchorMs = waitOngoing
      ? waitStartMs
      : gateDataUpdatedIso
        ? Date.parse(gateDataUpdatedIso)
        : gatePathStartIso
          ? Date.parse(gatePathStartIso)
          : NaN;
    const elapsedMs = Number.isFinite(timeoutAnchorMs) ? Date.now() - timeoutAnchorMs : 0;

    if (Number.isFinite(timeoutAnchorMs) && elapsedMs >= timeoutMs) {
      return {
        type: 'allow',
        data: {
          ...(typeof data.prUrl === 'string' ? { pr_url: data.prUrl } : {}),
          codex_approved: false,
          codex_timed_out: true,
          codex_warning: 'codex review bot +1 reaction missing after timeout; allowing gate',
        },
      };
    }

    // Miss: return a RETRYABLE block so the engine re-evaluates periodically. The
    // retry interval is a periodic poll (so a +1 posted minutes later is observed
    // promptly) CAPPED by the remaining timeout — the timeout-allow branch is
    // reachable by elapsed time alone (the 2h safety valve). Mirrors the legacy
    // feature's 5-minute poll. On the HOOK path the block carries the wait anchor
    // (persisted to hook state, arming the timeout); on the GATE path there is no
    // persistence, so the anchor stays the workflow start.
    const remainingMs = Math.max(1000, timeoutMs - elapsedMs);
    const pollIntervalMs = Math.min(CODEX_REVIEW_BOT_POLL_INTERVAL_MS, remainingMs);
    return {
      type: 'retryable_block',
      reason: `${CODEX_LABEL}: no codex approval for current head`,
      retryAfterMs: Math.ceil(pollIntervalMs / 1000) * 1000,
      data: gatePathStartIso
        ? {}
        : {
            codex_wait_started_at: waitOngoing ? waitStarted : nowIso,
            codex_wait_head_oid: headSha ?? '',
          },
    };
  };
}

/** Periodic re-check interval (ms) for a pending codex wait — the legacy
 *  feature polled every 5 minutes. The retry is capped by the remaining timeout
 *  so the 2h safety valve still anchors from the wait start. */
const CODEX_REVIEW_BOT_POLL_INTERVAL_MS = 300_000;

/** Resolve the workflow (cycle) start as an ISO string from the hook context,
 *  used as the codex freshness anchor before a wait starts. */
function resolveWorkflowStartIso(ctx: HookExecutorContext): string | undefined {
  if (typeof ctx.workflowRunCreatedAt === 'number' && Number.isFinite(ctx.workflowRunCreatedAt)) {
    return new Date(ctx.workflowRunCreatedAt).toISOString();
  }
  const tpl = ctx.templateData?.workflowRunCreatedAt ?? ctx.templateData?.runCreatedAt;
  return typeof tpl === 'string' ? tpl : undefined;
}
