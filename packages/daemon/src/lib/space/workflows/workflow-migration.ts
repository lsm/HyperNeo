import type { Gate, SpaceWorkflow, WorkflowChannel, WorkflowHook } from '@neokai/shared';

const MIGRATION_DOCS_URL = 'docs/features/space-workflows.md#workflow-hooks';

const REVIEW_POSTED_SCRIPT = [
  'PR_URL=$(jq -r \'(.data.pr_url // .data.review_url // .pr_url // .review_url // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ -z "$PR_URL" ]; then echo "Review handoff requires pr_url or review_url" >&2; exit 1; fi',
  'jq -n --arg url "$PR_URL" \'{"type":"allow","data":{"pr_url":$url}}\'',
].join('\n');

const VALIDATION_ONLY_SCRIPT = [
  'MODE=$(jq -r \'(.data.completion_mode // .completion_mode // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'CHANGED=$(jq -r \'(.data.changed_files // .changed_files // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'OUTCOME=$(jq -r \'(.data.validation_outcome // .validation_outcome // empty)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ "$MODE" != "validation_only" ] || [ "$CHANGED" != "0" ] || [ -z "$OUTCOME" ]; then',
  '  echo "Validation-only handoff requires completion_mode=validation_only, changed_files=0, and validation_outcome" >&2; exit 1',
  'fi',
  'jq -n --arg outcome "$OUTCOME" \'{"type":"allow","data":{"completion_mode":"validation_only","changed_files":0,"validation_outcome":$outcome}}\'',
].join('\n');

const APPROVALS_SCRIPT = [
  'COUNT=$(jq \'(.data.approvals // .approvals // {}) | to_entries | map(select(.value == "approved" or .value == true)) | length\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || echo 0)',
  'if [ "$COUNT" -lt 4 ]; then echo "Plan dispatch requires four approved plan-review votes" >&2; exit 1; fi',
  'jq -n \'{"type":"allow"}\'',
].join('\n');

const REVIEW_APPROVAL_SCRIPT = [
  'APPROVED=$(jq -r \'(.data.approved // .approved // false)\' <<< "${NEOKAI_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ "$APPROVED" != "true" ]; then echo "Review handoff requires approved=true" >&2; exit 1; fi',
  'jq -n \'{"type":"allow","data":{"approved":true}}\'',
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

function makeHook(pattern: Pattern, channel: WorkflowChannel): WorkflowHook {
  return {
    id: pattern.hookId,
    enabled: true,
    label: pattern.label,
    sourceNode: channel.from,
    targetNode: Array.isArray(channel.to) ? channel.to[0] : channel.to,
    method: pattern.method,
    classification: 'validation',
    order: 0,
    validator: {
      kind: 'script',
      interpreter: 'bash',
      source: pattern.script,
      timeoutMs: 30000,
      externalLookups: pattern.gateId === 'review-posted-gate' ? ['github'] : undefined,
    },
    authorizedCallers: [{ sourceNode: channel.from }],
  };
}

function markDeprecatedGate(gate: Gate): Gate {
  return {
    ...gate,
    ...((gate as unknown as { metadata?: Record<string, unknown> }).metadata ? {} : {}),
    metadata: {
      ...(gate as unknown as { metadata?: Record<string, unknown> }).metadata,
      deprecated: true,
      badge: 'Legacy gate',
      docsUrl: MIGRATION_DOCS_URL,
      deprecationReason:
        'Gate-based workflow progression is deprecated for one release; use hooks.',
    },
  } as Gate;
}

export function migrateWorkflowGateProgressionToHooks<
  T extends Pick<SpaceWorkflow, 'channels' | 'gates' | 'hooks'>,
>(workflow: T): WorkflowMigrationResult<T> {
  const warnings: WorkflowMigrationWarning[] = [];
  const hooksById = new Map((workflow.hooks ?? []).map((hook) => [hook.id, hook]));
  const migratedGateIds = new Set<string>();

  const channels = (workflow.channels ?? []).map((channel) => {
    if (!channel.gateId) return channel;
    const pattern = KNOWN_GATE_PATTERNS[channel.gateId];
    if (!pattern) {
      warnings.push({
        code: 'legacy_custom_gate_deprecated',
        gateId: channel.gateId,
        channel: { from: channel.from, to: channel.to },
        docsUrl: MIGRATION_DOCS_URL,
      });
      return channel;
    }

    if (!hooksById.has(pattern.hookId)) hooksById.set(pattern.hookId, makeHook(pattern, channel));
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
    .map((gate) => (migratedGateIds.size === 0 ? markDeprecatedGate(gate) : gate));

  return {
    workflow: {
      ...workflow,
      channels,
      gates: gates.length > 0 ? gates : undefined,
      hooks: Array.from(hooksById.values()),
      migrationWarnings: warnings,
    } as T,
    warnings,
  };
}
