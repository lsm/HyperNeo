import type {
  Gate,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowHook,
  WorkflowNode,
} from '@hyperneo/shared';
import {
  CODEX_REVIEW_BOT_TIMEOUT_SECONDS,
  resolveCodexTimeoutSeconds,
} from '../runtime/gate-features.js';

const MIGRATION_DOCS_URL = 'docs/features/space-workflows.md#workflow-hooks';

/**
 * Human label for a codex reaction timeout (seconds), embedded in the block
 * reason text of migrated plan/review approval hooks. Uses "N-hour" when the
 * value divides evenly into hours, otherwise "N-minute" (rounded up) so a
 * custom per-node override (e.g. 300s) reads as "5-minute", not "0.1-hour".
 */
function formatCodexTimeoutLabel(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

const REVIEW_POSTED_SCRIPT = [
  'PR_URL=$(jq -r \'(.data.pr_url // .pr_url // empty)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'REVIEW_URL=$(jq -r \'(.data.review_url // .review_url // empty)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ -z "$PR_URL" ] || [ -z "$REVIEW_URL" ]; then echo "Review handoff requires both pr_url and review_url" >&2; exit 1; fi',
  'START_ISO="${HYPERNEO_WORKFLOW_START_ISO:-}"',
  'if [ -z "$START_ISO" ]; then echo "HYPERNEO_WORKFLOW_START_ISO not injected — cannot determine review window" >&2; exit 1; fi',
  'if ! PR_JSON=$(gh pr view "$PR_URL" --json reviews,comments,author,url 2>/dev/null); then echo "Failed to fetch review evidence for ${PR_URL}" >&2; exit 1; fi',
  'PR_API_URL=$(jq -r \'.url // empty\' <<< "$PR_JSON")',
  'PR_HOST=$(sed -E "s#https://([^/]+)/.*#\\1#" <<< "$PR_API_URL")',
  'if [ -z "$PR_HOST" ] || [ "$PR_HOST" = "$PR_API_URL" ]; then echo "Failed to resolve PR host from ${PR_URL}" >&2; exit 1; fi',
  'ALLOWED_HOST="${GH_HOST:-github.com}"',
  'if [ "$PR_HOST" != "github.com" ] && [ "$PR_HOST" != "$ALLOWED_HOST" ]; then echo "PR host ${PR_HOST} is not allowed for GitHub lookups" >&2; exit 1; fi',
  'VIEWER_LOGIN=$(gh api --hostname "$PR_HOST" user --jq .login 2>/dev/null || true)',
  'if [ -z "$VIEWER_LOGIN" ]; then echo "Unable to resolve authenticated reviewer" >&2; exit 1; fi',
  'FORMAL=$(jq --arg since "$START_ISO" --arg viewer "$VIEWER_LOGIN" \'[.reviews[] | select((.submittedAt // "") > $since) | select((.author.login // .user.login // "") == $viewer) | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")] | length\' <<< "$PR_JSON")',
  'if [ "$FORMAL" != "0" ]; then jq -n --arg url "$PR_URL" --argjson count "$FORMAL" \'{"type":"allow","data":{"pr_url":$url,"review_evidence_count":$count,"review_evidence":"formal_review"}}\'; exit 0; fi',
  'AUTHOR_LOGIN=$(jq -r \'.author.login // empty\' <<< "$PR_JSON")',
  'if [ -z "$AUTHOR_LOGIN" ] || [ "$AUTHOR_LOGIN" != "$VIEWER_LOGIN" ]; then echo "No APPROVED or CHANGES_REQUESTED review found on ${PR_URL} since workflow start; comment-only evidence is accepted only for own PRs" >&2; exit 1; fi',
  'COMMENTS=$(jq --arg since "$START_ISO" --arg viewer "$VIEWER_LOGIN" \'[.reviews[] | select((.submittedAt // "") > $since) | select((.author.login // .user.login // "") == $viewer) | select(.state == "COMMENTED")] | length\' <<< "$PR_JSON")',
  'PR_COMMENTS=$(jq --arg since "$START_ISO" --arg viewer "$VIEWER_LOGIN" \'[.comments[] | select((.createdAt // "") > $since) | select((.author.login // .user.login // "") == $viewer)] | length\' <<< "$PR_JSON")',
  'COUNT=$((COMMENTS + PR_COMMENTS))',
  'if [ "$COUNT" = "0" ]; then echo "No GitHub review or PR comment found on own PR ${PR_URL} since workflow start" >&2; exit 1; fi',
  'jq -n --arg url "$PR_URL" --argjson count "$COUNT" \'{"type":"allow","data":{"pr_url":$url,"review_evidence_count":$count,"review_evidence":"own_pr_comment"}}\'',
].join('\n');

/**
 * Builds the plan-approval hook script with a Codex reaction timeout window
 * of `timeoutSeconds` (default 7200 / env-overridable via
 * `HYPERNEO_CODEX_REVIEW_BOT_TIMEOUT_SECONDS`). Per-node `codexTimeoutSeconds`
 * overrides are honored at migration time by passing the resolved value here.
 */
function buildApprovalsScript(timeoutSeconds: number = CODEX_REVIEW_BOT_TIMEOUT_SECONDS): string {
  const label = formatCodexTimeoutLabel(timeoutSeconds);
  return [
    'STATE=$(jq -c \'.approvals // {}\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || echo {})',
    'WAIT_STARTED=$(jq -r \'.codex_wait_started_at // empty\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || true)',
    'WAIT_HEAD=$(jq -r \'.codex_wait_head_oid // empty\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || true)',
    'INCOMING=$(jq -c \'(.data.approvals // .approvals // {})\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || echo {})',
    'MERGED=$(jq -c -n --argjson a "$STATE" --argjson b "$INCOMING" \'$a * $b\')',
    'COUNT=$(jq \'to_entries | map(select(.value == "approved" or .value == true)) | length\' <<< "$MERGED")',
    'if [ "$COUNT" -lt 4 ]; then jq -n --argjson approvals "$MERGED" --argjson count "$COUNT" \'{"type":"block","reason":"Plan dispatch requires four approved plan-review votes","data":{"approvals":$approvals,"approval_count":$count}}\'; exit 0; fi',
    'PR_URL=$(jq -r \'(.data.pr_url // .pr_url // empty)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
    'if [ -z "$PR_URL" ]; then echo "Plan approval requires pr_url for Codex validation" >&2; exit 1; fi',
    'if ! PR_JSON=$(gh pr view "$PR_URL" --json number,headRefOid,url 2>/dev/null); then echo "Failed to fetch plan PR for Codex validation" >&2; exit 1; fi',
    'PR_NUMBER=$(jq -r \'.number\' <<< "$PR_JSON")',
    'HEAD_OID=$(jq -r \'.headRefOid // empty\' <<< "$PR_JSON")',
    'PR_API_URL=$(jq -r \'.url // empty\' <<< "$PR_JSON")',
    'PR_HOST=$(sed -E "s#https://([^/]+)/.*#\\1#" <<< "$PR_API_URL")',
    'OWNER=$(sed -E "s#https://[^/]+/([^/]+)/([^/]+)/pull/[0-9]+.*#\\1#" <<< "$PR_API_URL")',
    'REPO=$(sed -E "s#https://[^/]+/([^/]+)/([^/]+)/pull/[0-9]+.*#\\2#" <<< "$PR_API_URL")',
    'if [ -z "$PR_HOST" ] || [ -z "$OWNER" ] || [ -z "$REPO" ] || [ "$OWNER" = "$PR_API_URL" ]; then echo "Failed to resolve repository from PR URL" >&2; exit 1; fi',
    'ALLOWED_HOST="${GH_HOST:-github.com}"',
    'if [ "$PR_HOST" != "github.com" ] && [ "$PR_HOST" != "$ALLOWED_HOST" ]; then echo "PR host ${PR_HOST} is not allowed for GitHub lookups" >&2; exit 1; fi',
    'COMMENTS=$(gh api --hostname "$PR_HOST" --paginate --slurp "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments?per_page=100") || { echo "Failed to fetch Codex comments" >&2; exit 1; }',
    'REACTIONS=$(gh api --hostname "$PR_HOST" --paginate --slurp "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/reactions?per_page=100") || { echo "Failed to fetch Codex reactions" >&2; exit 1; }',
    'COMMENT_OK=$(jq --arg head "$HEAD_OID" \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and ((.body // "") | contains($head)))] | length\' <<< "$COMMENTS")',
    'REACTION_OK=$(jq \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and .content == "+1")] | length\' <<< "$REACTIONS")',
    'FRESH_REACTION_OK=$(jq --arg since "$WAIT_STARTED" \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and .content == "+1" and (.created_at // "") > $since)] | length\' <<< "$REACTIONS")',
    'if [ "$COMMENT_OK" != "0" ] || { [ -n "$WAIT_STARTED" ] && [ "$WAIT_HEAD" = "$HEAD_OID" ] && [ "$FRESH_REACTION_OK" != "0" ]; }; then jq -n --argjson approvals "$MERGED" --argjson reaction_count "$REACTION_OK" --argjson fresh_reaction_count "$FRESH_REACTION_OK" \'{"type":"allow","data":{"approvals":$approvals,"codex_approved":true,"codex_reaction_count":$reaction_count,"codex_fresh_reaction_count":$fresh_reaction_count}}\'; exit 0; fi',
    'NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    `if [ -z "$WAIT_STARTED" ] || [ "$WAIT_HEAD" != "$HEAD_OID" ]; then jq -n --argjson approvals "$MERGED" --arg started "$NOW_ISO" --arg head "$HEAD_OID" '{"type":"block","reason":"Plan approval requires fresh Codex bot approval for current head or ${label} timeout from approval handoff","data":{"approvals":$approvals,"approval_count":4,"codex_wait_started_at":$started,"codex_wait_head_oid":$head}}'; exit 0; fi`,
    'WAIT_STARTED_PARSE=${WAIT_STARTED%%.*}; WAIT_STARTED_PARSE=${WAIT_STARTED_PARSE%Z}Z',
    'START_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$WAIT_STARTED_PARSE" +%s 2>/dev/null || date -u -d "$WAIT_STARTED" +%s 2>/dev/null || echo 0)',
    'NOW_EPOCH=$(date -u +%s)',
    `if [ $((NOW_EPOCH - START_EPOCH)) -lt ${timeoutSeconds} ]; then jq -n --argjson approvals "$MERGED" --arg started "$WAIT_STARTED" --arg head "$HEAD_OID" '{"type":"block","reason":"Plan approval requires fresh Codex bot approval for current head or ${label} timeout from approval handoff","data":{"approvals":$approvals,"approval_count":4,"codex_wait_started_at":$started,"codex_wait_head_oid":$head}}'; exit 0; fi`,
    'jq -n --argjson approvals "$MERGED" \'{"type":"allow","data":{"approvals":$approvals,"codex_approved":false,"codex_timed_out":true,"codex_warning":"No current-head Codex approval found before timeout"}}\'',
  ].join('\n');
}

const APPROVALS_SCRIPT = buildApprovalsScript();

const PLAN_APPROVAL_RESET_SCRIPT = [
  'jq -n \'{"type":"record_state","stateForHook":{"__PLAN_APPROVAL_HOOK_ID__":{"approvals":null,"approval_count":0,"codex_wait_started_at":null,"codex_wait_head_oid":null}}}\'',
].join('\n');

const APPROVALS_WITHOUT_CODEX_SCRIPT = [
  'STATE=$(jq -c \'.approvals // {}\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || echo {})',
  'INCOMING=$(jq -c \'(.data.approvals // .approvals // {})\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || echo {})',
  'MERGED=$(jq -c -n --argjson a "$STATE" --argjson b "$INCOMING" \'$a * $b\')',
  'COUNT=$(jq \'to_entries | map(select(.value == "approved" or .value == true)) | length\' <<< "$MERGED")',
  'if [ "$COUNT" -lt 4 ]; then jq -n --argjson approvals "$MERGED" --argjson count "$COUNT" \'{"type":"block","reason":"Plan dispatch requires four approved plan-review votes","data":{"approvals":$approvals,"approval_count":$count}}\'; exit 0; fi',
  'jq -n --argjson approvals "$MERGED" \'{"type":"allow","data":{"approvals":$approvals}}\'',
].join('\n');

const REVIEW_APPROVAL_WITHOUT_CODEX_SCRIPT = [
  'APPROVED=$(jq -r \'(.data.approved // .approved // false)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'PR_URL=$(jq -r \'(.data.pr_url // .pr_url // empty)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ "$APPROVED" != "true" ]; then echo "Review handoff requires approved=true" >&2; exit 1; fi',
  'if [ -n "$PR_URL" ]; then jq -n --arg url "$PR_URL" \'{"type":"allow","data":{"approved":true,"pr_url":$url}}\'; else jq -n \'{"type":"allow","data":{"approved":true}}\'; fi',
].join('\n');

/**
 * Builds the review-approval hook script. Same parameterization contract as
 * {@link buildApprovalsScript}: `timeoutSeconds` defaults to the global
 * (env-overridable) constant and can be overridden per source node.
 */
function buildReviewApprovalScript(
  timeoutSeconds: number = CODEX_REVIEW_BOT_TIMEOUT_SECONDS
): string {
  const label = formatCodexTimeoutLabel(timeoutSeconds);
  return [
    'APPROVED=$(jq -r \'(.data.approved // .approved // false)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
    'PR_URL=$(jq -r \'(.data.pr_url // .pr_url // empty)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
    'if [ "$APPROVED" != "true" ]; then echo "Review handoff requires approved=true" >&2; exit 1; fi',
    'if [ -z "$PR_URL" ]; then echo "Review approval handoff requires pr_url for Codex validation" >&2; exit 1; fi',
    'WAIT_STARTED=$(jq -r \'.codex_wait_started_at // empty\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || true)',
    'WAIT_HEAD=$(jq -r \'.codex_wait_head_oid // empty\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || true)',
    'if ! PR_JSON=$(gh pr view "$PR_URL" --json number,headRefOid,url 2>/dev/null); then echo "Failed to fetch PR for Codex validation" >&2; exit 1; fi',
    'PR_NUMBER=$(jq -r \'.number\' <<< "$PR_JSON")',
    'HEAD_OID=$(jq -r \'.headRefOid // empty\' <<< "$PR_JSON")',
    'PR_API_URL=$(jq -r \'.url // empty\' <<< "$PR_JSON")',
    'PR_HOST=$(sed -E "s#https://([^/]+)/.*#\\1#" <<< "$PR_API_URL")',
    'OWNER=$(sed -E "s#https://[^/]+/([^/]+)/([^/]+)/pull/[0-9]+.*#\\1#" <<< "$PR_API_URL")',
    'REPO=$(sed -E "s#https://[^/]+/([^/]+)/([^/]+)/pull/[0-9]+.*#\\2#" <<< "$PR_API_URL")',
    'if [ -z "$PR_HOST" ] || [ -z "$OWNER" ] || [ -z "$REPO" ] || [ "$OWNER" = "$PR_API_URL" ]; then echo "Failed to resolve repository from PR URL" >&2; exit 1; fi',
    'ALLOWED_HOST="${GH_HOST:-github.com}"',
    'if [ "$PR_HOST" != "github.com" ] && [ "$PR_HOST" != "$ALLOWED_HOST" ]; then echo "PR host ${PR_HOST} is not allowed for GitHub lookups" >&2; exit 1; fi',
    'COMMENTS=$(gh api --hostname "$PR_HOST" --paginate --slurp "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments?per_page=100") || { echo "Failed to fetch Codex comments" >&2; exit 1; }',
    'REACTIONS=$(gh api --hostname "$PR_HOST" --paginate --slurp "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/reactions?per_page=100") || { echo "Failed to fetch Codex reactions" >&2; exit 1; }',
    'COMMENT_OK=$(jq --arg head "$HEAD_OID" \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and ((.body // "") | contains($head)))] | length\' <<< "$COMMENTS")',
    'REACTION_OK=$(jq \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and .content == "+1")] | length\' <<< "$REACTIONS")',
    'FRESH_REACTION_OK=$(jq --arg since "$WAIT_STARTED" \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and .content == "+1" and (.created_at // "") > $since)] | length\' <<< "$REACTIONS")',
    'if [ "$COMMENT_OK" != "0" ] || { [ -n "$WAIT_STARTED" ] && [ "$WAIT_HEAD" = "$HEAD_OID" ] && [ "$FRESH_REACTION_OK" != "0" ]; }; then jq -n --arg url "$PR_URL" --argjson reaction_count "$REACTION_OK" --argjson fresh_reaction_count "$FRESH_REACTION_OK" \'{"type":"allow","data":{"approved":true,"pr_url":$url,"codex_approved":true,"codex_reaction_count":$reaction_count,"codex_fresh_reaction_count":$fresh_reaction_count}}\'; exit 0; fi',
    'NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    `if [ -z "$WAIT_STARTED" ] || [ "$WAIT_HEAD" != "$HEAD_OID" ]; then jq -n --arg started "$NOW_ISO" --arg head "$HEAD_OID" '{"type":"block","reason":"Review approval requires fresh Codex bot approval for current head or ${label} timeout from approval handoff","data":{"codex_wait_started_at":$started,"codex_wait_head_oid":$head}}'; exit 0; fi`,
    'WAIT_STARTED_PARSE=${WAIT_STARTED%%.*}; WAIT_STARTED_PARSE=${WAIT_STARTED_PARSE%Z}Z',
    'START_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$WAIT_STARTED_PARSE" +%s 2>/dev/null || date -u -d "$WAIT_STARTED" +%s 2>/dev/null || echo 0)',
    'NOW_EPOCH=$(date -u +%s)',
    `if [ $((NOW_EPOCH - START_EPOCH)) -lt ${timeoutSeconds} ]; then jq -n --arg started "$WAIT_STARTED" --arg head "$HEAD_OID" '{"type":"block","reason":"Review approval requires fresh Codex bot approval for current head or ${label} timeout from approval handoff","data":{"codex_wait_started_at":$started,"codex_wait_head_oid":$head}}'; exit 0; fi`,
    'jq -n --arg url "$PR_URL" \'{"type":"allow","data":{"approved":true,"pr_url":$url,"codex_approved":false,"codex_timed_out":true,"codex_warning":"No current-head Codex approval found before timeout"}}\'',
  ].join('\n');
}

const REVIEW_APPROVAL_SCRIPT = buildReviewApprovalScript();

type Pattern = {
  gateId: string;
  hookId: string;
  routeSpecific?: boolean;
  label: string;
  method: WorkflowHook['method'];
  script: string;
  from?: string;
  to?: string;
  /**
   * When true, generated hooks declare `externalLookups: ['github']` so the
   * hook executor preserves GitHub auth env (GH_TOKEN, GITHUB_TOKEN, GH_HOST,
   * GH_CONFIG_DIR). Declared on the pattern (rather than inferred from script
   * identity in makeHook) so custom-timeout variants built via the script
   * builders also receive the lookup.
   */
  githubLookup?: boolean;
};

const KNOWN_GATE_PATTERNS: Record<string, Pattern> = {
  'review-posted-gate': {
    gateId: 'review-posted-gate',
    hookId: 'review-posted',
    routeSpecific: true,
    label: 'Review Posted',
    method: 'send_message',
    script: REVIEW_POSTED_SCRIPT,
    githubLookup: true,
  },
  'plan-approval-gate': {
    gateId: 'plan-approval-gate',
    hookId: 'plan-approval',
    routeSpecific: true,
    label: 'Plan Approval',
    method: 'send_message',
    script: APPROVALS_SCRIPT,
    githubLookup: true,
  },
  'plan-approval-feedback-reset': {
    gateId: 'plan-approval-feedback-reset',
    hookId: 'plan-approval-reset',
    label: 'Plan Approval Reset',
    method: 'send_message',
    script: PLAN_APPROVAL_RESET_SCRIPT,
    from: 'Plan Review',
    to: 'Planning',
  },
  'review-approval-gate': {
    gateId: 'review-approval-gate',
    hookId: 'review-approval',
    routeSpecific: true,
    label: 'Review Approval',
    method: 'send_message',
    script: REVIEW_APPROVAL_SCRIPT,
    githubLookup: true,
  },
};

export interface WorkflowMigrationWarning {
  code: 'known_gate_migrated_to_hook' | 'legacy_custom_gate_deprecated';
  gateId: string;
  hookId?: string;
  channel?: { from: string; to: WorkflowChannel['to'] };
  docsUrl: string;
}

export interface WorkflowMigrationResult<
  T extends Pick<SpaceWorkflow, 'channels' | 'gates' | 'hooks'>,
> {
  workflow: T;
  warnings: WorkflowMigrationWarning[];
}

type SpaceWorkflowLike = Pick<SpaceWorkflow, 'channels' | 'gates' | 'hooks'> &
  Partial<Pick<SpaceWorkflow, 'nodes' | 'templateName'>> & { templateGates?: Gate[] };

function resolveChannelNodeName(
  ref: string,
  nodes: WorkflowNode[] | undefined
): string | undefined {
  if (ref === '*') return undefined;
  const direct = nodes?.find((node) => node.name === ref);
  if (direct) return direct.name;
  const byAgentSlot = nodes?.find((node) => node.agents.some((agent) => agent.name === ref));
  return byAgentSlot?.name;
}

function matchingAgentSlotNodes(ref: string, nodes: WorkflowNode[] | undefined): WorkflowNode[] {
  if (nodes?.some((node) => node.name === ref)) return [];
  return nodes?.filter((node) => node.agents.some((agent) => agent.name === ref)) ?? [];
}

function isAgentSlot(ref: string, nodes: WorkflowNode[] | undefined): boolean {
  return matchingAgentSlotNodes(ref, nodes).length > 0;
}

function canMigrateChannel(channel: WorkflowChannel, nodes: WorkflowNode[] | undefined): boolean {
  return (
    typeof channel.to === 'string' &&
    !isAgentSlot(channel.to, nodes) &&
    matchingAgentSlotNodes(channel.from, nodes).length <= 1 &&
    resolveChannelNodeName(channel.from, nodes) !== undefined &&
    resolveChannelNodeName(channel.to, nodes) !== undefined
  );
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(value.map((item) => JSON.parse(sortedJson(item))));
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return JSON.stringify(
    Object.fromEntries(entries.map(([key, item]) => [key, JSON.parse(sortedJson(item))]))
  );
}

function comparableGateShape(gate: Gate): string {
  return sortedJson({
    fields: gate.fields ?? [],
    requiredLevel: gate.requiredLevel ?? null,
    resetOnCycle: gate.resetOnCycle ?? null,
    script: gate.script ?? null,
    poll: gate.poll ?? null,
    features: gate.features ?? null,
  });
}

function isBuiltInGateShape(gate: Gate | undefined, workflow: SpaceWorkflowLike): boolean {
  if (!workflow.templateName || !gate) return false;
  const templateGate = workflow.templateGates?.find((candidate) => candidate.id === gate.id);
  if (templateGate && comparableGateShape(gate) !== comparableGateShape(templateGate)) {
    return false;
  }
  if (!templateGate && workflow.templateGates) return false;
  if (gate.requiredLevel || gate.poll || gate.features) return false;
  const fields = gate.fields ?? [];
  switch (gate.id) {
    case 'review-posted-gate':
      return (
        fields.length === 2 &&
        fields.some((field) => field.name === 'pr_url') &&
        fields.some((field) => field.name === 'review_url') &&
        !!gate.script
      );
    case 'plan-approval-gate':
      return fields.length === 1 && fields[0]?.name === 'approvals' && !gate.script;
    case 'review-approval-gate':
      return fields.length === 1 && fields[0]?.name === 'approved' && !gate.script;
    default:
      return false;
  }
}

function hookIdComponent(value: string): string {
  return `${value.length}-${Array.from(value)
    .map((char) => char.codePointAt(0)?.toString(36) ?? '0')
    .join('_')}`;
}

function routeHookId(
  pattern: Pattern,
  sourceNode: string,
  targetNode: string,
  agentSlot?: string
): string {
  if (!pattern.routeSpecific) return pattern.hookId;
  const slotComponent = agentSlot ? `:${hookIdComponent(agentSlot)}` : '';
  return `${pattern.hookId}:${hookIdComponent(sourceNode)}:${hookIdComponent(targetNode)}${slotComponent}`;
}

function channelAgentSlot(
  channel: WorkflowChannel,
  nodes: WorkflowNode[] | undefined
): string | undefined {
  const directNode = nodes?.find((node) => node.name === channel.from);
  if (directNode) return undefined;
  const slotNode = nodes?.find((node) => node.agents.some((agent) => agent.name === channel.from));
  return slotNode ? channel.from : undefined;
}

function makeHook(
  pattern: Pattern,
  channel: WorkflowChannel,
  nodes: WorkflowNode[] | undefined,
  script = pattern.script
): WorkflowHook {
  const sourceNode = resolveChannelNodeName(channel.from, nodes)!;
  const targetNode = resolveChannelNodeName(channel.to as string, nodes)!;
  const agentSlot = channelAgentSlot(channel, nodes);
  return {
    id: routeHookId(pattern, sourceNode, targetNode, agentSlot),
    enabled: true,
    label: pattern.label,
    sourceNode,
    targetNode,
    method: pattern.method,
    classification: 'validation',
    order: 0,
    validator: {
      kind: 'script',
      interpreter: 'bash',
      source: script,
      timeoutMs: 30000,
      // Use pattern.githubLookup (not script identity) so custom-timeout
      // variants built via buildApprovalsScript/buildReviewApprovalScript
      // also declare the lookup and keep GitHub auth env in the executor.
      externalLookups: pattern.githubLookup ? ['github'] : undefined,
    },
    authorizedCallers: [
      {
        sourceNode,
        ...(agentSlot ? { agentSlots: [agentSlot] } : {}),
      },
    ],
  };
}

function equivalentGeneratedHook(existing: WorkflowHook, hook: WorkflowHook): boolean {
  return (
    existing.method === hook.method &&
    existing.sourceNode === hook.sourceNode &&
    existing.targetNode === hook.targetNode &&
    existing.classification === hook.classification &&
    existing.validator.kind === 'script' &&
    hook.validator.kind === 'script' &&
    existing.validator.interpreter === hook.validator.interpreter &&
    existing.validator.source === hook.validator.source &&
    existing.validator.timeoutMs === hook.validator.timeoutMs &&
    JSON.stringify(existing.validator.externalLookups ?? []) ===
      JSON.stringify(hook.validator.externalLookups ?? []) &&
    JSON.stringify(existing.authorizedCallers ?? []) ===
      JSON.stringify(hook.authorizedCallers ?? [])
  );
}

function findExistingRouteHookId(
  hooks: Iterable<WorkflowHook>,
  hook: WorkflowHook
): string | undefined {
  for (const existing of hooks) {
    if (
      existing.enabled === hook.enabled &&
      existing.id === hook.id &&
      equivalentGeneratedHook(existing, hook)
    ) {
      return existing.id;
    }
    if (existing.enabled === hook.enabled && equivalentGeneratedHook(existing, hook)) {
      return existing.id;
    }
  }
  return undefined;
}

function markDeprecatedGate(gate: Gate): Gate {
  return {
    ...gate,
    legacyGateMetadata: {
      ...gate.legacyGateMetadata,
      deprecated: true,
      badge: 'Legacy gate',
      docsUrl: MIGRATION_DOCS_URL,
      deprecationReason:
        'Gate-based workflow progression is deprecated for one release; use hooks.',
    },
  };
}

export function migrateWorkflowGateProgressionToHooks<T extends SpaceWorkflowLike>(
  workflow: T
): WorkflowMigrationResult<T> {
  const warnings: WorkflowMigrationWarning[] = [];
  const hooksById = new Map((workflow.hooks ?? []).map((hook) => [hook.id, hook]));
  const gatesById = new Map((workflow.gates ?? []).map((gate) => [gate.id, gate]));
  const migratedGateIds = new Set<string>();
  const planApprovalHookIds = new Set<string>();
  const planApprovalSourceNodes = new Set<string>();
  const planApprovalTargetNodes = new Set<string>();

  const channels = (workflow.channels ?? []).map((channel) => {
    if (!channel.gateId) return channel;
    const fromNode = resolveChannelNodeName(channel.from, workflow.nodes);
    const toNode =
      typeof channel.to === 'string'
        ? resolveChannelNodeName(channel.to, workflow.nodes)
        : undefined;
    const pattern =
      KNOWN_GATE_PATTERNS[
        `${channel.gateId}:${fromNode ?? channel.from}:${toNode ?? String(channel.to)}`
      ] ?? KNOWN_GATE_PATTERNS[channel.gateId];
    const gate = gatesById.get(channel.gateId);
    const sourceNode = workflow.nodes?.find((node) => node.name === fromNode);
    const codexRequired = sourceNode?.requireCodexApproval === true;
    // Resolve the Codex reaction timeout for migrated plan/review approval
    // hooks: honor a per-source-node `codexTimeoutSeconds` override, else the
    // global env-overridable default. Without this, an operator who shortened
    // the window via `HYPERNEO_CODEX_REVIEW_BOT_TIMEOUT_SECONDS` or per-node
    // config would still wait the baked-in 2h on a migrated workflow.
    const codexTimeoutSeconds =
      sourceNode?.codexTimeoutSeconds !== undefined
        ? resolveCodexTimeoutSeconds(sourceNode.codexTimeoutSeconds)
        : CODEX_REVIEW_BOT_TIMEOUT_SECONDS;
    const script =
      pattern?.gateId === 'plan-approval-gate' && !codexRequired
        ? APPROVALS_WITHOUT_CODEX_SCRIPT
        : pattern?.gateId === 'review-approval-gate' && !codexRequired
          ? REVIEW_APPROVAL_WITHOUT_CODEX_SCRIPT
          : pattern?.gateId === 'plan-approval-gate' && codexRequired
            ? codexTimeoutSeconds === CODEX_REVIEW_BOT_TIMEOUT_SECONDS
              ? APPROVALS_SCRIPT
              : buildApprovalsScript(codexTimeoutSeconds)
            : pattern?.gateId === 'review-approval-gate' && codexRequired
              ? codexTimeoutSeconds === CODEX_REVIEW_BOT_TIMEOUT_SECONDS
                ? REVIEW_APPROVAL_SCRIPT
                : buildReviewApprovalScript(codexTimeoutSeconds)
              : pattern?.script;
    if (
      !pattern ||
      !script ||
      (pattern.from !== undefined && pattern.from !== fromNode) ||
      (pattern.to !== undefined && pattern.to !== toNode) ||
      !canMigrateChannel(channel, workflow.nodes) ||
      !isBuiltInGateShape(gate, workflow)
    ) {
      warnings.push({
        code: 'legacy_custom_gate_deprecated',
        gateId: channel.gateId,
        channel: { from: channel.from, to: channel.to },
        docsUrl: MIGRATION_DOCS_URL,
      });
      return channel;
    }

    const hook = makeHook(pattern, channel, workflow.nodes, script);
    const existingRouteHookId = findExistingRouteHookId(hooksById.values(), hook);
    if (existingRouteHookId && !workflow.templateName) return channel;
    const hookId = existingRouteHookId ?? hook.id;
    if (!existingRouteHookId) hooksById.set(hook.id, hook);
    if (pattern.gateId === 'plan-approval-gate') {
      planApprovalHookIds.add(hookId);
      planApprovalSourceNodes.add(hook.sourceNode);
      if (hook.targetNode) planApprovalTargetNodes.add(hook.targetNode);
    }
    migratedGateIds.add(channel.gateId);
    warnings.push({
      code: 'known_gate_migrated_to_hook',
      gateId: channel.gateId,
      hookId,
      channel: { from: channel.from, to: channel.to },
      docsUrl: MIGRATION_DOCS_URL,
    });
    const { gateId: _gateId, ...openChannel } = channel;
    return openChannel;
  });

  const planFeedbackResetPattern = KNOWN_GATE_PATTERNS['plan-approval-feedback-reset'];
  if (workflow.templateName && planFeedbackResetPattern && planApprovalHookIds.size > 0) {
    const planFeedbackChannels = (workflow.channels ?? []).filter((channel) => {
      if (typeof channel.to !== 'string') return false;
      const sourceNode = resolveChannelNodeName(channel.from, workflow.nodes);
      const targetNode = resolveChannelNodeName(channel.to, workflow.nodes);
      if (!sourceNode || !targetNode) return false;
      if (!planApprovalSourceNodes.has(sourceNode)) return false;
      return !planApprovalTargetNodes.has(targetNode);
    });
    planFeedbackChannels.sort((a, b) => {
      const aTarget = typeof a.to === 'string' ? resolveChannelNodeName(a.to, workflow.nodes) : '';
      const bTarget = typeof b.to === 'string' ? resolveChannelNodeName(b.to, workflow.nodes) : '';
      if (aTarget === 'Planning') return -1;
      if (bTarget === 'Planning') return 1;
      return 0;
    });
    for (const planFeedbackChannel of planFeedbackChannels) {
      const stateForHook = Array.from(planApprovalHookIds)
        .map(
          (hookId) =>
            `"${hookId}":{"approvals":null,"approval_count":0,"codex_wait_started_at":null,"codex_wait_head_oid":null}`
        )
        .join(',');
      const hook = makeHook(
        planFeedbackResetPattern,
        planFeedbackChannel,
        workflow.nodes,
        PLAN_APPROVAL_RESET_SCRIPT.replace(
          '"__PLAN_APPROVAL_HOOK_ID__":{"approvals":null,"approval_count":0,"codex_wait_started_at":null,"codex_wait_head_oid":null}',
          stateForHook
        )
      );
      const existing = hooksById.get(hook.id);
      if (!existing) {
        hooksById.set(hook.id, hook);
      } else if (!existing.enabled || !equivalentGeneratedHook(existing, hook)) {
        hooksById.set(
          `${hook.id}:${hookIdComponent(hook.sourceNode)}:${hookIdComponent(hook.targetNode ?? '')}`,
          {
            ...hook,
            id: `${hook.id}:${hookIdComponent(hook.sourceNode)}:${hookIdComponent(hook.targetNode ?? '')}`,
          }
        );
      }
    }
  }

  // Post-pass: regenerate already-migrated plan/review approval hooks when
  // the source node's codexTimeoutSeconds has changed since the hook was
  // built. Once a channel is migrated, its gateId is stripped, so the main
  // migration loop above can no longer reach it; without this pass, an
  // RPC/import/editor update that changes codexTimeoutSeconds would persist
  // on the node but leave the existing hook source baked with the old
  // timeout (typically the 7200s default).
  //
  // Scope guard: the regex is anchored to the timeout comparison
  // `((NOW_EPOCH - START_EPOCH)) -lt N`, which is emitted ONLY by
  // buildApprovalsScript / buildReviewApprovalScript. This uniquely
  // identifies the timeout check rather than any `-lt N` in the script —
  // buildApprovalsScript also emits `if [ "$COUNT" -lt 4 ]` for the
  // approval-vote count, and a naive `/-lt (\d+) /` would match that first
  // (returning 4) and either always rebuild (when 4 != expectedTimeout) or
  // silently clobber a custom hook that happens to use `-lt N` for an
  // unrelated shell comparison.
  const TIMEOUT_CMP_RE = /\(\(NOW_EPOCH - START_EPOCH\)\) -lt (\d+) /;
  for (const hook of hooksById.values()) {
    if (hook.validator.kind !== 'script') continue;
    const isPlan = hook.id.startsWith('plan-approval:') || hook.id === 'plan-approval';
    const isReview = hook.id.startsWith('review-approval:') || hook.id === 'review-approval';
    if (!isPlan && !isReview) continue;
    const sourceNode = workflow.nodes?.find((node) => node.name === hook.sourceNode);
    if (!sourceNode?.requireCodexApproval) continue;
    const match = hook.validator.source.match(TIMEOUT_CMP_RE);
    if (!match) continue; // not a generated codex script; leave custom hooks alone
    const bakedTimeout = Number.parseInt(match[1]!, 10);
    // Treat a cleared (`undefined`) override as the global default so a
    // save that removes codexTimeoutSeconds still rebuilds the hook back
    // to the default window instead of leaving the prior custom value.
    const expectedTimeout =
      sourceNode.codexTimeoutSeconds === undefined
        ? CODEX_REVIEW_BOT_TIMEOUT_SECONDS
        : resolveCodexTimeoutSeconds(sourceNode.codexTimeoutSeconds);
    if (bakedTimeout === expectedTimeout) continue;
    const rebuiltScript = isPlan
      ? buildApprovalsScript(expectedTimeout)
      : buildReviewApprovalScript(expectedTimeout);
    hooksById.set(hook.id, {
      ...hook,
      validator: { ...hook.validator, source: rebuiltScript },
    });
  }

  const retainedGateIds = new Set(
    channels.flatMap((channel) => ('gateId' in channel && channel.gateId ? [channel.gateId] : []))
  );
  const gates = (workflow.gates ?? [])
    .filter((gate) => !migratedGateIds.has(gate.id) || retainedGateIds.has(gate.id))
    .map((gate) => markDeprecatedGate(gate));

  return {
    workflow: {
      ...workflow,
      channels: workflow.channels === undefined ? undefined : channels,
      gates: gates.length > 0 ? gates : undefined,
      hooks: Array.from(hooksById.values()),
    } as T,
    warnings,
  };
}
