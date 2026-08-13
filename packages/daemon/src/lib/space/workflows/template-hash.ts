/**
 * ⚠️ IMPORTANT: WORKFLOW FINGERPRINT RULES ⚠️
 *
 * This module computes a canonical hash of workflow templates for drift detection.
 * The fingerprint is derived from the FULL workflow structure — all hook fields,
 * channel fields, and node prompt fields are automatically included via exhaustive
 * JSON serialization.
 *
 * When adding new fields to Channel or WorkflowNodeAgent types, NO changes to
 * this file are needed — the exhaustive serialization ensures new fields are
 * captured automatically.
 *
 * Hash changes trigger template re-seeding on daemon restart. This is expected
 * and correct behavior — it ensures all spaces get the latest template structure.
 *
 * DO NOT hand-craft field lists or string formats for structural entities.
 * Always use JSON.stringify on the relevant subset of each object.
 */

import type { SpaceWorkflow } from '@hyperneo/shared';
import { createHash } from 'node:crypto';

/**
 * Canonical shape used for hashing — uses only template-portable fields.
 * Agent UUIDs are excluded because they differ per-space.
 */
interface WorkflowFingerprint {
  description: string;
  instructions: string;
  nodeNames: string[];
  /**
   * Exhaustive JSON serialization of each channel.
   * All structurally-meaningful fields are included automatically.
   */
  channels: string[];
  /**
   * Exhaustive JSON serialization of each hook binding (Layer-2 placement).
   * All structurally-meaningful fields are included automatically.
   */
  hookBindings: string[];
  /**
   * Exhaustive JSON serialization of each custom (script) hook defined on the
   * workflow, so a change to a custom hook's script/contract is detected as drift.
   */
  customHooks: string[];
  /**
   * Per-agent custom prompt entries, sorted. Format:
   * `<nodeName>|<agentName>|<customPrompt>` (empty string when absent).
   * Captures the most frequently updated field — agent behavior changes.
   */
  nodePrompts: string[];
  /**
   * Per-agent fresh-context (resetContextPerTurn) flags, sorted. Format:
   * `<nodeName>|<agentName>` — only agents with the flag set. Detects changes
   * to the per-slot fresh-eyes behavior so it re-stamps into installed spaces.
   * Optional: omitted (not `[]`) when no slot has the flag, so templates with
   * no reset-enabled slot keep a stable hash across the upgrade that introduces
   * this field.
   */
  nodeAgentResetContext?: string[];
  /**
   * Minimum space autonomy level required to auto-close the workflow.
   * Affects autonomy gating behavior.
   */
  completionAutonomyLevel: number;
  /**
   * Node-level post-approval routes, sorted. Format:
   * `<nodeName>|<targetAgent>|<instructions>`. Detects changes to the
   * post-approval handoff so seeder re-stamping triggers when built-in
   * templates gain or modify node routes.
   */
  nodePostApproval: string[];
  /**
   * Legacy workflow-level post-approval route. Kept in the fingerprint so
   * clearing old template-level routes also triggers a re-stamp.
   */
  legacyPostApproval: string;
}

/**
 * Compare two strings for deterministic sorting (used by transitions below).
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Extract the canonical fingerprint of a workflow for hash comparison.
 * Sorts all collections to ensure deterministic output regardless of insertion order.
 */
export function buildWorkflowFingerprint(workflow: SpaceWorkflow): WorkflowFingerprint {
  const nodeNames = workflow.nodes.map((n) => n.name).sort();

  // Exhaustive JSON serialization of channels — all fields included automatically.
  const channels = (workflow.channels ?? [])
    .map((c) => {
      // Normalize single-element `to` arrays to a string so that `"Reviewer"`
      // and `["Reviewer"]` produce the same hash (runtime treats them equivalently).
      const normalizedTo = Array.isArray(c.to)
        ? c.to.length === 1
          ? c.to[0]
          : [...c.to].sort()
        : c.to;
      return JSON.stringify({
        from: c.from,
        to: normalizedTo,
        maxCycles: c.maxCycles ?? null,
        label: c.label ?? null,
      });
    })
    .sort();

  const hookBindings = (workflow.hookBindings ?? [])
    .map((binding) => JSON.stringify(binding))
    .sort();

  const customHooks = (workflow.customHooks ?? []).map((hook) => JSON.stringify(hook)).sort();

  // Serialize per-agent custom prompts.
  // Format: `<nodeName>|<agentName>|<mode>|<customPrompt>` — mode is `replace` when the
  // slot replaces the agent's base prompt, else `append`; customPrompt is empty when absent.
  // The mode is included so a pure append→replace toggle changes the fingerprint (and thus
  // drift detection), not just the prompt text.
  const nodePrompts = workflow.nodes
    .flatMap((n) =>
      n.agents.map(
        (a) =>
          `${n.name}|${a.name}|${a.replaceAgentPrompt ? 'replace' : 'append'}|${a.customPrompt?.value ?? ''}`
      )
    )
    .sort();

  // Serialize per-agent fresh-context (resetContextPerTurn) flags so a template
  // change to this flag is detected as drift and re-stamped into installed
  // spaces. Format: `<nodeName>|<agentName>` — only agents with the flag set.
  // IMPORTANT: only included when at least one slot has the flag. Omitting the
  // key entirely when empty keeps the hash identical for templates with no
  // reset-enabled slot, so an upgrade does NOT mass-restamp unrelated built-ins
  // (which would overwrite operator edits to their autonomy/hooks/prompts).
  const nodeAgentResetContextEntries = workflow.nodes
    .flatMap((n) => n.agents.filter((a) => a.resetContextPerTurn).map((a) => `${n.name}|${a.name}`))
    .sort();

  // Serialize per-agent structural tool guards (e.g. the merger's raw-merge
  // block, task #866) so a change to a slot's toolGuards is detected as drift
  // and re-stamped into installed spaces via mergeNodeStructuralFieldsFromTemplate
  // (which overwrites toolGuards from the template). Only emitted when at least
  // one slot has guards — see the resetContext comment for why empty is omitted.
  const nodeAgentToolGuardsEntries = workflow.nodes
    .flatMap((n) =>
      n.agents
        .filter((a) => Array.isArray(a.toolGuards) && a.toolGuards.length > 0)
        .map((a) => `${n.name}|${a.name}|${JSON.stringify(a.toolGuards)}`)
    )
    .sort();

  // Serialize per-agent static external-event interests (e.g. the implementer
  // slot's primaryLink PR-event interest, task #907) so a change to a slot's
  // eventInterests is detected as drift and re-stamped into installed spaces
  // via mergeNodeStructuralFieldsFromTemplate (which overwrites eventInterests
  // from the template). Only emitted when at least one slot has interests —
  // see the resetContext comment for why empty is omitted (so this upgrade does
  // not mass-restamp built-ins whose slots carry no event interest).
  const nodeAgentEventInterestsEntries = workflow.nodes
    .flatMap((n) =>
      n.agents
        .filter((a) => Array.isArray(a.eventInterests) && a.eventInterests.length > 0)
        .map((a) => `${n.name}|${a.name}|${JSON.stringify(a.eventInterests)}`)
    )
    .sort();

  // Serialize node-level post-approval routes (include requirePrMerge so a
  // change to the completion-safety flag is detected as drift / a customized row).
  const nodePostApproval = workflow.nodes
    .filter((n) => n.postApproval)
    .map(
      (n) =>
        `${n.name}|${n.postApproval?.targetAgent ?? ''}|${n.postApproval?.instructions ?? ''}|${n.postApproval?.requirePrMerge ? '1' : '0'}`
    )
    .sort();

  // Serialize legacy workflow-level post-approval route (include requirePrMerge).
  const legacyPostApproval = workflow.postApproval
    ? `${workflow.postApproval.targetAgent}|${workflow.postApproval.instructions ?? ''}|${workflow.postApproval.requirePrMerge ? '1' : '0'}`
    : '';

  // Serialize node-level handoff transitions (the first-class handoff contract)
  // so a change to a node's declared outbound transitions is detected as drift
  // and re-stamped into installed spaces via mergeNodeStructuralFieldsFromTemplate.
  // Only emitted when a node declares at least one transition. Each transition is
  // serialized as an explicit ordered shape (not the raw object) and the per-node
  // list is sorted by id so reordering transitions in the editor does not produce
  // false drift — same canonicalization approach used for gates/channels above.
  const nodeTransitions = workflow.nodes
    .filter((n) => n.transitions && n.transitions.length > 0)
    .map((n) => {
      const serialized = n
        .transitions!.slice()
        .sort((a, b) => compareStrings(a.id, b.id))
        .map((t) => ({
          id: t.id,
          target: t.target,
          label: t.label ?? null,
          hookId: t.hookId ?? null,
          maxCycles: t.maxCycles ?? null,
        }));
      return `${n.name}|${JSON.stringify(serialized)}`;
    })
    .sort();

  return {
    description: workflow.description ?? '',
    instructions: workflow.instructions ?? '',
    nodeNames,
    channels,
    hookBindings,
    customHooks,
    nodePrompts,
    // Only emitted when non-empty — see the comment on the declaration above.
    ...(nodeAgentResetContextEntries.length > 0
      ? { nodeAgentResetContext: nodeAgentResetContextEntries }
      : {}),
    ...(nodeAgentToolGuardsEntries.length > 0
      ? { nodeAgentToolGuards: nodeAgentToolGuardsEntries }
      : {}),
    ...(nodeAgentEventInterestsEntries.length > 0
      ? { nodeAgentEventInterests: nodeAgentEventInterestsEntries }
      : {}),
    completionAutonomyLevel: workflow.completionAutonomyLevel,
    nodePostApproval,
    legacyPostApproval,
    ...(nodeTransitions.length > 0 ? { nodeTransitions } : {}),
  };
}

/**
 * Compute the SHA-256 hex hash of a workflow's canonical fingerprint.
 * Used to track template versions and detect drift.
 */
export function computeWorkflowHash(workflow: SpaceWorkflow): string {
  const fp = buildWorkflowFingerprint(workflow);
  const json = JSON.stringify(fp);
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Returns true when two workflows have the same structural fingerprint.
 * Uses hash comparison internally.
 */
export function workflowsMatchFingerprint(a: SpaceWorkflow, b: SpaceWorkflow): boolean {
  return computeWorkflowHash(a) === computeWorkflowHash(b);
}
