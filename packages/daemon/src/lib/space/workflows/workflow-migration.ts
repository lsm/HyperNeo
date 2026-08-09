import {
  hasEnabledGateFeature,
  type Gate,
  type SpaceWorkflow,
  type WorkflowChannel,
  type WorkflowHook,
  type WorkflowHookValidatorId,
  type WorkflowNode,
} from '@hyperneo/shared';
import { isApprovalGate } from '../runtime/gate-features.js';

const MIGRATION_DOCS_URL = 'docs/features/space-workflows.md#workflow-hooks';

/**
 * Plan-approval hook script: accumulates the four plan-review votes and opens
 * the Plan Review → Task Dispatcher channel once all four reviewers approved.
 * The codex +1 check is a SEPARATE `codex_review_approved` hook (see
 * `makeCodexApprovalHook`) ordered after this one — the epic #2299 #2304
 * unification moved the codex requirement out of the approval bash into a
 * declarative preset, so this script is approval-count-only.
 */
const APPROVALS_SCRIPT = [
  'STATE=$(jq -c \'.approvals // {}\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || echo {})',
  'INCOMING=$(jq -c \'(.data.approvals // .approvals // {})\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || echo {})',
  'MERGED=$(jq -c -n --argjson a "$STATE" --argjson b "$INCOMING" \'$a * $b\')',
  'COUNT=$(jq \'to_entries | map(select(.value == "approved" or .value == true)) | length\' <<< "$MERGED")',
  'if [ "$COUNT" -lt 4 ]; then jq -n --argjson approvals "$MERGED" --argjson count "$COUNT" \'{"type":"block","reason":"Plan dispatch requires four approved plan-review votes","data":{"approvals":$approvals,"approval_count":$count}}\'; exit 0; fi',
  'jq -n --argjson approvals "$MERGED" \'{"type":"allow","data":{"approvals":$approvals}}\'',
].join('\n');

const PLAN_APPROVAL_RESET_SCRIPT = [
  'jq -n \'{"type":"record_state","stateForHook":{"__PLAN_APPROVAL_HOOK_ID__":{"approvals":null,"approval_count":0}}}\'',
].join('\n');

/**
 * Review-approval hook script: the reviewer's `approved: true` verdict on the
 * Review → QA channel. The codex +1 check is the separate
 * `codex_review_approved` hook ordered after this one.
 */
const REVIEW_APPROVAL_SCRIPT = [
  'APPROVED=$(jq -r \'(.data.approved // .approved // false)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'PR_URL=$(jq -r \'(.data.pr_url // .pr_url // empty)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
  'if [ "$APPROVED" != "true" ]; then echo "Review handoff requires approved=true" >&2; exit 1; fi',
  'if [ -n "$PR_URL" ]; then jq -n --arg url "$PR_URL" \'{"type":"allow","data":{"approved":true,"pr_url":$url}}\'; else jq -n \'{"type":"allow","data":{"approved":true}}\'; fi',
].join('\n');

/**
 * Detects a legacy COMBINED codex-bearing approval hook script — the pre-#2409
 * `buildApprovalsScript` / `buildReviewApprovalScript` baked the full codex +1
 * wait (gh-api reaction lookup + a 2h timeout-allow) INLINE in the approval
 * hook's bash. Identified by the CONJUNCTION of two markers both emitted only
 * by those builders: the `((NOW_EPOCH - START_EPOCH)) -lt N` timeout comparison
 * AND the `test("codex"` codex-bot login filter (the gh-api reaction lookup).
 * Requiring both means a user-authored script that merely reuses the timeout
 * arithmetic — but performs no codex lookup — is not mistaken for the combined
 * form (which would wrongly clobber it). The approval-only scripts
 * (`APPROVALS_SCRIPT` / `REVIEW_APPROVAL_SCRIPT`) and the feedback reset script
 * emit neither marker. Used by the gateless re-emit pass to upgrade such a hook
 * to approval-only so the declarative codex_review_approved hook is the single
 * codex path (preserving its canonical-PR precedence over the legacy
 * `.data.pr_url` read).
 */
const LEGACY_COMBINED_CODEX_TIMEOUT_RE = /\(\(NOW_EPOCH - START_EPOCH\)\) -lt \d+/;
function isLegacyCombinedCodexScript(source: string): boolean {
  return LEGACY_COMBINED_CODEX_TIMEOUT_RE.test(source) && source.includes('test("codex"');
}

type Pattern = {
  gateId: string;
  hookId: string;
  routeSpecific?: boolean;
  label: string;
  method: WorkflowHook['method'];
  /** Bash source for a script-validator hook. Mutually exclusive with `builtInId`. */
  script?: string;
  /** Built-in validator id for a declarative hook (e.g. `review_posted`, an
   *  `external_state` preset). Mutually exclusive with `script`. */
  builtInId?: WorkflowHookValidatorId;
  from?: string;
  to?: string;
};

const KNOWN_GATE_PATTERNS: Record<string, Pattern> = {
  'review-posted-gate': {
    gateId: 'review-posted-gate',
    hookId: 'review-posted',
    routeSpecific: true,
    label: 'Review Posted',
    method: 'send_message',
    builtInId: 'review_posted',
  },
  'plan-approval-gate': {
    gateId: 'plan-approval-gate',
    hookId: 'plan-approval',
    routeSpecific: true,
    label: 'Plan Approval',
    method: 'send_message',
    script: APPROVALS_SCRIPT,
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
    validator: gate.validator ?? null,
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
      // Recognise the converted form (a `review_posted` built-in validator
      // reference). The legacy inline-bash form (pre-#835) is NOT fully migrated
      // yet: the comparableGateShape guard above flags its script→validator shape
      // change as customisation, and even when recognised the migration preserves
      // the existing bash route hook instead of replacing it
      // (findExistingRouteHookId). Pre-conversion spaces therefore keep their
      // (still-functional) bash hook; full legacy migration is a tracked
      // follow-up. Spaces seeded after #835 get the validator hook.
      return (
        fields.length === 2 &&
        fields.some((field) => field.name === 'pr_url') &&
        fields.some((field) => field.name === 'review_url') &&
        (!!gate.script || !!gate.validator)
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
  // A `builtInId` pattern emits a declarative built-in validator hook (e.g. the
  // `review_posted` external_state preset) — no script. Otherwise emit the bash
  // script-validator hook.
  const validator: WorkflowHook['validator'] = pattern.builtInId
    ? { kind: 'built_in', id: pattern.builtInId }
    : {
        kind: 'script',
        interpreter: 'bash',
        // Script patterns always carry a source — the migrate flow's
        // `needsScript && !script` guard rejects any that don't before reaching
        // here. The default param (`script = pattern.script`) widens to
        // `string | undefined` only because Pattern.script is now optional.
        source: script!,
        timeoutMs: 30000,
      };
  return {
    id: routeHookId(pattern, sourceNode, targetNode, agentSlot),
    enabled: true,
    label: pattern.label,
    sourceNode,
    targetNode,
    method: pattern.method,
    classification: 'validation',
    order: 0,
    validator,
    authorizedCallers: [
      {
        sourceNode,
        ...(agentSlot ? { agentSlots: [agentSlot] } : {}),
      },
    ],
  };
}

/**
 * Builds the `codex_review_approved` hook for an approval channel whose source
 * node carries the legacy `requireCodexApproval` flag. It is ordered AFTER the
 * approval hook (order 1 vs 0): the approval hook's non-retryable block
 * short-circuits the codex hook until the votes / reviewer-approved condition
 * passes, so the codex wait window starts at the approval handoff — identical
 * to the legacy combined bash.
 *
 * `method` is the action the hook fires on (send_message for approval channels,
 * or a terminal action). `sourceNodeName`/`targetNodeName` default to the
 * channel's resolved endpoints but can be overridden for a wildcard `from: '*'`
 * channel (one hook per requiring source node).
 */
function makeCodexApprovalHook(
  method: WorkflowHook['method'],
  channel: WorkflowChannel,
  nodes: WorkflowNode[] | undefined,
  sourceNodeName = resolveChannelNodeName(channel.from, nodes),
  targetNodeName = typeof channel.to === 'string'
    ? resolveChannelNodeName(channel.to, nodes)
    : undefined
): WorkflowHook {
  const agentSlot = channelAgentSlot(channel, nodes);
  const sourceComponent = hookIdComponent(sourceNodeName ?? '');
  const targetComponent = hookIdComponent(targetNodeName ?? '');
  const slotComponent = agentSlot ? `:${hookIdComponent(agentSlot)}` : '';
  return {
    id: `codex-approval:${sourceComponent}:${targetComponent}${slotComponent}`,
    enabled: true,
    label: 'Codex Review',
    sourceNode: sourceNodeName ?? '',
    ...(targetNodeName ? { targetNode: targetNodeName } : {}),
    method,
    classification: 'validation',
    order: 1,
    validator: { kind: 'built_in', id: 'codex_review_approved' },
    authorizedCallers: [
      {
        sourceNode: sourceNodeName ?? '',
        ...(agentSlot ? { agentSlots: [agentSlot] } : {}),
      },
    ],
  };
}

/**
 * Emit `codex_review_approved` hooks for an approval-gated channel whose source
 * node(s) carry the legacy `requireCodexApproval` flag. For a named `from` a
 * single hook is emitted; for a wildcard `from: '*'`, one hook per requiring
 * source node (mirrors the legacy runtime which injected codex for any source of
 * a wildcard approval gate). Returns the emitted hook ids.
 */
function emitCodexHooksForChannel(
  hooksById: Map<string, WorkflowHook>,
  method: WorkflowHook['method'],
  channel: WorkflowChannel,
  nodes: WorkflowNode[] | undefined,
  requiringSourceNames: string[],
  keptCodexHookIds: Set<string>,
  allChannelSources?: boolean
): string[] {
  // Resolve every target: a single string `to`, or each entry of a fan-out
  // array `to`. A `'*'` target resolves to undefined (no targetNode binding).
  const toRefs =
    typeof channel.to === 'string'
      ? [channel.to]
      : Array.isArray(channel.to)
        ? channel.to.filter((t): t is string => typeof t === 'string')
        : [];
  const targetNodes = toRefs.map((ref) =>
    ref === '*' ? undefined : resolveChannelNodeName(ref, nodes)
  );
  // When `allChannelSources` is true (gate-level codex feature), expand a
  // wildcard `from: '*'` to ALL nodes — the gate feature applies to every
  // source, not just node-flagged ones. When false (node-flag codex), use only
  // the requiring sources.
  let sources: string[];
  if (channel.from === '*') {
    sources = allChannelSources ? (nodes ?? []).map((n) => n.name) : requiringSourceNames;
  } else {
    sources = [resolveChannelNodeName(channel.from, nodes)].filter(Boolean) as string[];
  }
  const emitted: string[] = [];
  for (const source of sources) {
    for (const targetNode of targetNodes) {
      const hook = makeCodexApprovalHook(method, channel, nodes, source, targetNode);
      const existingId = findExistingRouteHookId(hooksById.values(), hook);
      const hookId = existingId ?? hook.id;
      if (!existingId) hooksById.set(hook.id, hook);
      keptCodexHookIds.add(hookId);
      emitted.push(hookId);
    }
  }
  return emitted;
}

function equivalentValidators(
  existing: WorkflowHook['validator'],
  hook: WorkflowHook['validator']
): boolean {
  if (existing.kind !== hook.kind) return false;
  if (existing.kind === 'built_in' && hook.kind === 'built_in') {
    return existing.id === hook.id;
  }
  if (existing.kind === 'script' && hook.kind === 'script') {
    return (
      existing.interpreter === hook.interpreter &&
      existing.source === hook.source &&
      existing.timeoutMs === hook.timeoutMs &&
      JSON.stringify(existing.externalLookups ?? []) === JSON.stringify(hook.externalLookups ?? [])
    );
  }
  return false;
}

function equivalentGeneratedHook(existing: WorkflowHook, hook: WorkflowHook): boolean {
  return (
    existing.method === hook.method &&
    existing.sourceNode === hook.sourceNode &&
    existing.targetNode === hook.targetNode &&
    existing.classification === hook.classification &&
    equivalentValidators(existing.validator, hook.validator) &&
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

/**
 * Attach the `codex_review_approved` built-in validator to a retained approval
 * gate (gate-on-external-state). The gate evaluator runs the validator before
 * field evaluation, so codex gates the OPENING while approval votes still
 * accumulate in gate data (unlike a send_message hook, which would run before
 * the handler that writes the votes).
 */
function attachCodexValidator(gate: Gate): Gate {
  return {
    ...gate,
    validator: { kind: 'built_in', id: 'codex_review_approved' },
  };
}

/**
 * Strip a MIGRATION-GENERATED `codex_review_approved` validator from a retained
 * gate ONLY when the gate still carries the legacy `codex_review_bot` feature
 * marker. The marker is the migration's provenance signal: it was set by the
 * old feature mechanism and is retained during migration. When codex is
 * disabled (the marker is cleared by the editor toggle, or no source requires
 * it), both the marker and the generated validator are removed together. A gate
 * with NO marker and a `codex_review_approved` validator was explicitly
 * authored by the user — it is preserved.
 */
function stripGeneratedCodexValidator(gate: Gate): Gate {
  if (
    gate.validator?.kind === 'built_in' &&
    gate.validator.id === 'codex_review_approved' &&
    hasEnabledGateFeature(gate, 'codex_review_bot')
  ) {
    const { validator: _generated, ...rest } = gate;
    return rest;
  }
  return gate;
}

export function migrateWorkflowGateProgressionToHooks<T extends SpaceWorkflowLike>(
  workflow: T
): WorkflowMigrationResult<T> {
  const warnings: WorkflowMigrationWarning[] = [];
  const hooksById = new Map((workflow.hooks ?? []).map((hook) => [hook.id, hook]));
  const gatesById = new Map((workflow.gates ?? []).map((gate) => [gate.id, gate]));
  const migratedGateIds = new Set<string>();
  const planApprovalHookIds = new Set<string>();
  const planApprovalCodexHookIds = new Set<string>();
  const planApprovalSourceNodes = new Set<string>();
  const planApprovalTargetNodes = new Set<string>();
  // Codex hook ids emitted THIS pass — a generated codex hook is kept when its
  // source node still carries the flag OR it was re-emitted this pass (e.g. a
  // feature-tied hook whose gate still carries the retired feature). A hook
  // with neither signal is a stale one from a cleared toggle and is dropped.
  const keptCodexHookIds = new Set<string>();
  // Gates that stay gate-based (custom / non-migratable built-in) and require
  // codex — their codex enforcement is attached as the gate's built-in
  // validator (gate-on-external-state) so approval votes accumulate in gate data
  // ahead of the codex check.
  const codexValidatorGateIds = new Set<string>();
  // Nodes that carry the legacy `requireCodexApproval` flag. The codex
  // requirement is resolved into a declarative `codex_review_approved` hook on
  // ANY approval-gated channel from such a node — including custom (non-built-in)
  // gates that stay gate-based — so removing the runtime injection does not
  // silently drop codex enforcement on user-authored workflows (#2304 compat).
  const requiringCodexNodeNames = new Set(
    (workflow.nodes ?? []).filter((n) => n.requireCodexApproval === true).map((n) => n.name)
  );

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
    // A gate requires a codex hook when it either (a) still carries the legacy
    // `codex_review_bot` feature (the retired gate-level trigger — the previous
    // generic feature mechanism compiled a codex script into ANY feature gate,
    // so no approval-shape requirement applies), or (b) its source node(s)
    // carry the legacy `requireCodexApproval` flag on an unscripted approval
    // gate (the old runtime injected codex for approval gates only). This is the
    // #2303/#2304 compat shim: the codex requirement becomes a declarative
    // preset hook on the workflow data, and the runtime no longer infers it from
    // the flag or feature.
    const sourceRequiresCodex =
      channel.from === '*'
        ? requiringCodexNodeNames.size > 0
        : sourceNode?.requireCodexApproval === true;
    const gateHasCodexFeature = !!gate && hasEnabledGateFeature(gate, 'codex_review_bot');
    const legacyCodexRequired =
      !!gate &&
      (gateHasCodexFeature || (!gate.script && isApprovalGate(gate) && sourceRequiresCodex));
    const script = pattern?.script;
    // A `builtInId` pattern (e.g. review-posted → `review_posted`) emits a
    // declarative validator hook and carries no bash script, so a missing
    // `script` is expected for those — only fail when a script pattern has none.
    const needsScript = !pattern?.builtInId;
    if (
      !pattern ||
      (needsScript && !script) ||
      (pattern.from !== undefined && pattern.from !== fromNode) ||
      (pattern.to !== undefined && pattern.to !== toNode) ||
      !canMigrateChannel(channel, workflow.nodes) ||
      !isBuiltInGateShape(gate, workflow)
    ) {
      // Custom / non-built-in gate: the channel stays gate-based. Codex
      // enforcement is attached as the gate's built-in VALIDATOR (the
      // gate-on-external-state primitive, same as review-posted-gate) — NOT a
      // send_message hook. A hook on send_message would run BEFORE the handler
      // that auto-merges the approval vote into gate data, so while codex is
      // pending the vote would never be written and a map/count approval gate
      // could never accumulate votes (repeated sends replace the single queued
      // action, replaying only the last vote). As a gate validator, the
      // send_message handler writes the vote first, then the gate evaluates
      // fields AND codex — votes accumulate, and the gate only opens when both
      // pass. This applies even to a shared gate where only SOME sources require
      // codex: vote-safety (a P1 deadlock) outweighs the over-scoping of
      // non-requiring sources (a fail-closed, more-restrictive behavior). The
      // ONLY gates that keep the per-source hook fallback are those a validator
      // cannot attach to — an existing non-codex validator (the evaluator runs
      // one validator exclusively) or a poll (`validateGate` forbids
      // validator+poll).
      if (legacyCodexRequired) {
        // Codex can be enforced as the gate's built-in VALIDATOR
        // (gate-on-external-state), where the send_message handler writes votes
        // first, then the gate evaluates codex + fields. A gate with a POLL,
        // SCRIPT, or existing non-codex VALIDATOR cannot combine with a codex
        // validator (validateGate forbids it). For POLL/SCRIPT gates, the old
        // runtime DID enforce codex (it injected a codex script alongside the
        // poll/script via getEffectiveGate) — so per-source send_message hooks
        // are emitted to preserve that enforcement. These gates are NOT vote-
        // count gates (a poll/script is a custom check, not an approval-vote
        // map), so the hook-before-vote-write deadlock does not apply. Only
        // gates with an existing non-codex VALIDATOR skip codex entirely (the
        // validator runs exclusively in the gate evaluator, and the hook engine
        // would duplicate it).
        const gateHasNonCodexValidator =
          !!gate?.validator && gate.validator.id !== 'codex_review_approved';
        const gateHasPoll = !!gate?.poll;
        const gateHasScript = !!gate?.script;
        // A gate that is BOTH a vote-count approval gate (map/count fields)
        // AND has a poll/script cannot safely get a per-source send_message
        // codex hook — the hook runs before the handler writes votes, so codex
        // pending would deadlock vote accumulation. For these incompatible
        // gates, codex is NOT enforced (matching the old runtime's limitation).
        const gateIsVoteCountGate = !!gate && isApprovalGate(gate);
        const useGateValidator = !gateHasNonCodexValidator && !gateHasPoll && !gateHasScript;
        const canEmitHook = !gateHasNonCodexValidator && !gateIsVoteCountGate;
        if (useGateValidator) {
          codexValidatorGateIds.add(channel.gateId);
        } else if (canEmitHook) {
          // POLL or SCRIPT gate that is NOT a vote-count gate: emit per-source
          // hooks. The old runtime enforced codex here via script injection.
          const codexIds = emitCodexHooksForChannel(
            hooksById,
            'send_message',
            channel,
            workflow.nodes,
            Array.from(requiringCodexNodeNames),
            keptCodexHookIds,
            gateHasCodexFeature
          );
          if (pattern?.gateId === 'plan-approval-gate') {
            for (const id of codexIds) planApprovalCodexHookIds.add(id);
          }
        }
        // else: existing non-codex validator — codex is NOT enforced (the
        // validator runs exclusively; adding a hook would duplicate it).
      }
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
    if (legacyCodexRequired) {
      const codexIds = emitCodexHooksForChannel(
        hooksById,
        pattern.method,
        channel,
        workflow.nodes,
        Array.from(requiringCodexNodeNames),
        keptCodexHookIds,
        gateHasCodexFeature
      );
      if (pattern.gateId === 'plan-approval-gate') {
        for (const id of codexIds) planApprovalCodexHookIds.add(id);
      }
    }
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
      // Reset the approval hook's vote state AND the codex hook's wait window so
      // every review cycle gets a fresh codex wait (the combined legacy bash
      // cleared both on revision feedback).
      const approvalState = Array.from(planApprovalHookIds)
        .map((hookId) => `"${hookId}":{"approvals":null,"approval_count":0}`)
        .join(',');
      const codexState = Array.from(planApprovalCodexHookIds)
        .map((hookId) => `"${hookId}":{"codex_wait_started_at":null,"codex_wait_head_oid":null}`)
        .join(',');
      const stateForHook = [approvalState, codexState].filter(Boolean).join(',');
      const hook = makeHook(
        planFeedbackResetPattern,
        planFeedbackChannel,
        workflow.nodes,
        PLAN_APPROVAL_RESET_SCRIPT.replace(
          '"__PLAN_APPROVAL_HOOK_ID__":{"approvals":null,"approval_count":0}',
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

  const retainedGateIds = new Set(
    channels.flatMap((channel) => ('gateId' in channel && channel.gateId ? [channel.gateId] : []))
  );
  const gates = (workflow.gates ?? [])
    .filter((gate) => !migratedGateIds.has(gate.id) || retainedGateIds.has(gate.id))
    .map((gate) =>
      codexValidatorGateIds.has(gate.id)
        ? attachCodexValidator(markDeprecatedGate(gate))
        : stripGeneratedCodexValidator(markDeprecatedGate(gate))
    );

  // Drop stale generated codex hooks: when a user clears a node's
  // `requireCodexApproval` toggle, serialization omits the flag but keeps the
  // previously generated `codex-approval:*` hooks. The runtime no longer reads
  // the node flag, so without this pass the supposedly-disabled codex hook would
  // keep blocking handoffs. Keyed on the SOURCE NODE FLAG (stable across passes
  // — the migration never clears it), so re-migration of an already-migrated
  // workflow is idempotent: a flagged source keeps its hook, a cleared source
  // drops it. Only generated-pattern hooks are removed; a deliberately added
  // (non-generated-id) codex hook is preserved.
  for (const hook of Array.from(hooksById.values())) {
    const isGeneratedCodex =
      hook.id.startsWith('codex-approval:') &&
      hook.validator.kind === 'built_in' &&
      hook.validator.id === 'codex_review_approved';
    if (
      isGeneratedCodex &&
      !requiringCodexNodeNames.has(hook.sourceNode) &&
      !keptCodexHookIds.has(hook.id)
    ) {
      hooksById.delete(hook.id);
    }
  }

  // Re-emit codex hooks for gateless channels whose source node requires codex
  // (toggle cleared then re-enabled on an already-migrated channel). Without
  // this pass, re-enabling `requireCodexApproval` on a gateless channel would
  // silently leave the route without codex enforcement.
  // SCOPED to routes that have an approval hook (script validator) — the old
  // runtime's `requireCodexApproval` only affected approval gates, so a
  // feedback/post-approval route should NOT get codex enforcement even if the
  // source node carries the flag.
  for (const channel of workflow.channels ?? []) {
    if (channel.gateId) continue;
    const fromNode = resolveChannelNodeName(channel.from, workflow.nodes);
    const sourceNode = workflow.nodes?.find((node) => node.name === fromNode);
    if (sourceNode?.requireCodexApproval !== true) continue;
    const targetNames =
      typeof channel.to === 'string'
        ? [channel.to]
        : Array.isArray(channel.to)
          ? channel.to.filter((t): t is string => typeof t === 'string')
          : [];
    for (const targetRef of targetNames) {
      const targetNode =
        targetRef === '*' ? undefined : resolveChannelNodeName(targetRef, workflow.nodes);
      // Collect the route's ENABLED script approval hooks (the migration's signal
      // that this WAS an approval channel). Disabled hooks never run at runtime
      // (`resolveMatchingHooks` drops `enabled: false`), so they neither mark the
      // route as codex-enforcing nor get upgraded. Non-approval routes (feedback,
      // post-approval) are skipped — requireCodexApproval never applied to them.
      const routeScriptHooks = Array.from(hooksById.values()).filter(
        (hook) =>
          hook.enabled !== false &&
          hook.sourceNode === fromNode &&
          hook.targetNode === targetNode &&
          hook.method === 'send_message' &&
          hook.validator.kind === 'script'
      );
      if (routeScriptHooks.length === 0) continue;
      // Upgrade EVERY legacy combined codex-bearing approval script on the route
      // (pre-#2409 buildApprovalsScript / buildReviewApprovalScript baked the
      // full 2h codex +1 wait inline) to the approval-only form, so the
      // declarative codex_review_approved hook emitted below is the SINGLE codex
      // enforcement path — otherwise the legacy inline wait and the new hook
      // would both block (~4h). Upgrading (rather than suppressing the hook)
      // preserves the declarative validator's canonical-PR precedence
      // (`codexApprovalPrUrl` resolves the run's primary PR link artifact),
      // which the legacy inline script's `.data.pr_url` read lacks. Every script
      // hook on the route is examined (not just the first) so a legacy script is
      // upgraded regardless of its position. Scoped to non-template workflows:
      // templates never carry a combined script (they migrate to approval-only),
      // and a pre-#2409 saved template's revision-feedback reset hook clears
      // codex state under the legacy id — upgrading would move it to a new id the
      // reset doesn't target (a per-cycle reset regression). Non-template
      // workflows have no reset hook (reset generation is template-only), so the
      // upgrade is safe there; templates stay at the #2409 baseline.
      if (!workflow.templateName) {
        for (const scriptHook of routeScriptHooks) {
          if (
            scriptHook.validator.kind === 'script' &&
            (scriptHook.id.startsWith('plan-approval:') ||
              scriptHook.id.startsWith('review-approval:')) &&
            isLegacyCombinedCodexScript(scriptHook.validator.source)
          ) {
            const upgradedSource = scriptHook.id.startsWith('review-approval:')
              ? REVIEW_APPROVAL_SCRIPT
              : APPROVALS_SCRIPT;
            hooksById.set(scriptHook.id, {
              ...scriptHook,
              validator: {
                kind: 'script',
                interpreter: 'bash',
                source: upgradedSource,
                timeoutMs: 30_000,
              },
            });
          }
        }
      }
      const hasRouteHook = Array.from(hooksById.values()).some(
        (hook) =>
          hook.sourceNode === fromNode &&
          hook.targetNode === targetNode &&
          hook.validator.kind === 'built_in' &&
          hook.validator.id === 'codex_review_approved'
      );
      if (!hasRouteHook) {
        emitCodexHooksForChannel(
          hooksById,
          'send_message',
          channel,
          workflow.nodes,
          Array.from(requiringCodexNodeNames),
          keptCodexHookIds,
          false
        );
      }
    }
  }

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
