import type {
  Gate,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowHook,
  WorkflowNode,
} from '@neokai/shared';

const MIGRATION_DOCS_URL = 'docs/features/space-workflows.md#workflow-hooks';

const REVIEW_POSTED_SCRIPT = [
  'PR_URL=$(jq -r \'(.data.pr_url // .data.review_url // .pr_url // .review_url // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ -z "$PR_URL" ]; then echo "Review handoff requires pr_url or review_url" >&2; exit 1; fi',
  'START_ISO="${NEOKAI_WORKFLOW_START_ISO:-1970-01-01T00:00:00Z}"',
  'if ! PR_JSON=$(gh pr view "$PR_URL" --json reviews,comments,author 2>/dev/null); then echo "Failed to fetch review evidence for ${PR_URL}" >&2; exit 1; fi',
  'FORMAL=$(jq --arg since "$START_ISO" \'[.reviews[] | select((.submittedAt // "") > $since) | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "COMMENTED")] | length\' <<< "$PR_JSON")',
  'COMMENTS=$(jq --arg since "$START_ISO" \'[.comments[] | select((.createdAt // "") > $since)] | length\' <<< "$PR_JSON")',
  'COUNT=$((FORMAL + COMMENTS))',
  'if [ "$COUNT" = "0" ]; then echo "No GitHub review or PR comment found on ${PR_URL} since workflow start" >&2; exit 1; fi',
  'jq -n --arg url "$PR_URL" --argjson count "$COUNT" \'{"type":"allow","data":{"pr_url":$url,"review_evidence_count":$count}}\'',
].join('\n');

const VALIDATION_ONLY_SCRIPT = [
  'MODE=$(jq -r \'(.data.completion_mode // .completion_mode // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'CHANGED=$(jq -r \'(.data.changed_files // .changed_files // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'OUTCOME=$(jq -r \'(.data.validation_outcome // .validation_outcome // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ "$MODE" != "validation_only" ] || [ "$CHANGED" != "0" ] || [ -z "$OUTCOME" ]; then',
  '  echo "Validation-only handoff requires completion_mode=validation_only, changed_files=0, and validation_outcome" >&2; exit 1',
  'fi',
  'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "Workspace is not a git worktree" >&2; exit 1; fi',
  'if [ -n "$(git status --porcelain=v1 2>/dev/null)" ]; then echo "Validation-only handoff requires a clean worktree" >&2; git status --short >&2 || true; exit 1; fi',
  'BASE_REF="${VALIDATION_BASE_REF:-${NEOKAI_VALIDATION_BASE_REF:-origin/dev}}"',
  'if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then BASE_REF=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed "s#^origin/##" | sed "s#^#origin/#"); fi',
  'if [ -z "$BASE_REF" ] || ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then echo "Unable to resolve validation base ref" >&2; exit 1; fi',
  'if ! MERGE_BASE=$(git merge-base HEAD "$BASE_REF^{}" 2>/dev/null); then echo "Unable to compute merge-base against $BASE_REF" >&2; exit 1; fi',
  'if [ -n "$(git diff --name-only "$MERGE_BASE"...HEAD 2>/dev/null)" ]; then echo "Validation-only handoff requires no committed changes against $BASE_REF" >&2; git diff --stat "$MERGE_BASE"...HEAD >&2 || true; exit 1; fi',
  'jq -n --arg outcome "$OUTCOME" \'{"type":"allow","data":{"completion_mode":"validation_only","changed_files":0,"validation_outcome":$outcome}}\'',
].join('\n');

const APPROVALS_SCRIPT = [
  'STATE=$(jq -c \'.approvals // {}\' <<< "${NEOKAI_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || echo {})',
  'INCOMING=$(jq -c \'(.data.approvals // .approvals // {})\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || echo {})',
  'MERGED=$(jq -c -n --argjson a "$STATE" --argjson b "$INCOMING" \'$a * $b\')',
  'COUNT=$(jq \'to_entries | map(select(.value == "approved" or .value == true)) | length\' <<< "$MERGED")',
  'if [ "$COUNT" -lt 4 ]; then jq -n --argjson approvals "$MERGED" --argjson count "$COUNT" \'{"type":"block","reason":"Plan dispatch requires four approved plan-review votes","data":{"approvals":$approvals,"approval_count":$count}}\'; exit 0; fi',
  'jq -n --argjson approvals "$MERGED" \'{"type":"allow","data":{"approvals":$approvals}}\'',
].join('\n');

const REVIEW_APPROVAL_SCRIPT = [
  'APPROVED=$(jq -r \'(.data.approved // .approved // false)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'PR_URL=$(jq -r \'(.data.pr_url // .pr_url // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ "$APPROVED" != "true" ]; then echo "Review handoff requires approved=true" >&2; exit 1; fi',
  'if [ -z "$PR_URL" ]; then echo "Review approval handoff requires pr_url for Codex validation" >&2; exit 1; fi',
  'if ! PR_JSON=$(gh pr view "$PR_URL" --json number,headRefOid 2>/dev/null); then echo "Failed to fetch PR for Codex validation" >&2; exit 1; fi',
  'PR_NUMBER=$(jq -r \'.number\' <<< "$PR_JSON")',
  'if ! REPO_JSON=$(gh repo view --json owner,name 2>/dev/null); then echo "Failed to resolve repository for Codex validation" >&2; exit 1; fi',
  'OWNER=$(jq -r \'.owner.login\' <<< "$REPO_JSON")',
  'REPO=$(jq -r \'.name\' <<< "$REPO_JSON")',
  'REACTIONS=$(gh api "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/reactions" 2>/dev/null || echo [])',
  'CODEX_OK=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "+1")] | length\' <<< "$REACTIONS")',
  'if [ "$CODEX_OK" = "0" ]; then echo "Review approval requires codex[bot] +1 reaction" >&2; exit 1; fi',
  'jq -n --arg url "$PR_URL" \'{"type":"allow","data":{"approved":true,"pr_url":$url,"codex_approved":true}}\'',
].join('\n');

type Pattern = {
  gateId: string;
  hookId: string;
  label: string;
  method: WorkflowHook['method'];
  script: string;
};

const KNOWN_GATE_PATTERNS: Record<string, Pattern> = {
  'validation-complete-gate': {
    gateId: 'validation-complete-gate',
    hookId: 'validation-only-complete',
    label: 'Validation-only Complete',
    method: 'send_message',
    script: VALIDATION_ONLY_SCRIPT,
  },
  'review-posted-gate': {
    gateId: 'review-posted-gate',
    hookId: 'review-posted',
    label: 'Review Posted',
    method: 'send_message',
    script: REVIEW_POSTED_SCRIPT,
  },
  'plan-approval-gate': {
    gateId: 'plan-approval-gate',
    hookId: 'plan-approval',
    label: 'Plan Approval',
    method: 'send_message',
    script: APPROVALS_SCRIPT,
  },
  'review-approval-gate': {
    gateId: 'review-approval-gate',
    hookId: 'review-approval',
    label: 'Review Approval',
    method: 'send_message',
    script: REVIEW_APPROVAL_SCRIPT,
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

function canMigrateChannel(channel: WorkflowChannel, nodes: WorkflowNode[] | undefined): boolean {
  return (
    typeof channel.to === 'string' &&
    resolveChannelNodeName(channel.from, nodes) !== undefined &&
    resolveChannelNodeName(channel.to, nodes) !== undefined
  );
}

function isBuiltInGateShape(
  gate: Gate | undefined,
  workflow: Pick<SpaceWorkflow, 'templateName'>
): boolean {
  if (!workflow.templateName || !gate) return false;
  return !gate.requiredLevel && !gate.poll && !gate.features;
}

function makeHook(
  pattern: Pattern,
  channel: WorkflowChannel,
  nodes: WorkflowNode[] | undefined
): WorkflowHook {
  return {
    id: pattern.hookId,
    enabled: true,
    label: pattern.label,
    sourceNode: resolveChannelNodeName(channel.from, nodes)!,
    targetNode: resolveChannelNodeName(channel.to as string, nodes)!,
    method: pattern.method,
    classification: 'validation',
    order: 0,
    validator: {
      kind: 'script',
      interpreter: 'bash',
      source: pattern.script,
      timeoutMs: 30000,
      externalLookups:
        pattern.gateId === 'review-posted-gate' || pattern.gateId === 'review-approval-gate'
          ? ['github']
          : undefined,
    },
    authorizedCallers: [{ sourceNode: resolveChannelNodeName(channel.from, nodes)! }],
  };
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

export function migrateWorkflowGateProgressionToHooks<
  T extends Pick<SpaceWorkflow, 'channels' | 'gates' | 'hooks'> &
    Partial<Pick<SpaceWorkflow, 'nodes' | 'templateName'>>,
>(workflow: T): WorkflowMigrationResult<T> {
  const warnings: WorkflowMigrationWarning[] = [];
  const hooksById = new Map((workflow.hooks ?? []).map((hook) => [hook.id, hook]));
  const existingHookIds = new Set(hooksById.keys());
  const gatesById = new Map((workflow.gates ?? []).map((gate) => [gate.id, gate]));
  const migratedGateIds = new Set<string>();

  const channels = (workflow.channels ?? []).map((channel) => {
    if (!channel.gateId) return channel;
    const pattern = KNOWN_GATE_PATTERNS[channel.gateId];
    const gate = gatesById.get(channel.gateId);
    if (
      !pattern ||
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

    if (existingHookIds.has(pattern.hookId) && !workflow.templateName) return channel;
    hooksById.set(pattern.hookId, makeHook(pattern, channel, workflow.nodes));
    migratedGateIds.add(channel.gateId);
    warnings.push({
      code: 'known_gate_migrated_to_hook',
      gateId: channel.gateId,
      hookId: pattern.hookId,
      channel: { from: channel.from, to: channel.to },
      docsUrl: MIGRATION_DOCS_URL,
    });
    const { gateId: _gateId, ...openChannel } = channel;
    return openChannel;
  });

  const gates = (workflow.gates ?? [])
    .filter((gate) => !migratedGateIds.has(gate.id))
    .map((gate) => markDeprecatedGate(gate));

  return {
    workflow: {
      ...workflow,
      channels,
      gates: gates.length > 0 ? gates : undefined,
      hooks: Array.from(hooksById.values()),
    } as T,
    warnings,
  };
}
