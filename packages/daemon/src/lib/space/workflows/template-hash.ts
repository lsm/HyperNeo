/**
 * ⚠️ IMPORTANT: GATE/CHANNEL FINGERPRINT RULES ⚠️
 *
 * This module computes a canonical hash of workflow templates for drift detection.
 * The fingerprint is derived from the FULL workflow structure — all hook fields,
 * gate fields, channel fields, and node prompt fields are automatically included via exhaustive
 * JSON serialization.
 *
 * When adding new fields to Gate, GatePoll, Channel, or WorkflowNodeAgent types,
 * NO changes to this file are needed — the exhaustive serialization ensures
 * new fields are captured automatically.
 *
 * Hash changes trigger template re-seeding on daemon restart. This is expected
 * and correct behavior — it ensures all spaces get the latest template structure.
 *
 * DO NOT hand-craft field lists or string formats for structural entities.
 * Always use JSON.stringify on the relevant subset of each object.
 */

import type { GateField, GateFieldCheck, SpaceWorkflow } from '@hyperneo/shared';
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
   * Exhaustive JSON serialization of each gate.
   * All structurally-meaningful fields (id, requiredLevel, resetOnCycle, fields,
   * script, poll) are included automatically — no hand-crafted string format.
   */
  gates: string[];
  /**
   * Exhaustive JSON serialization of each workflow hook.
   * All structurally-meaningful fields are included automatically.
   */
  hooks: string[];
  /**
   * Per-agent custom prompt entries, sorted. Format:
   * `<nodeName>|<agentName>|<customPrompt>` (empty string when absent).
   * Captures the most frequently updated field — agent behavior changes.
   */
  nodePrompts: string[];
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
   * Node-level Codex approval flags, sorted. Format: `<nodeName>|true`.
   * Detects changes to the requireCodexApproval toggle so drift detection
   * catches user edits and template changes that flip this flag.
   */
  nodeCodexFlags: string[];
  /**
   * Node-level Codex poll intervals, sorted. Format: `<nodeName>|<ms>`.
   * Empty string when absent. Detects changes to custom poll intervals.
   */
  nodeCodexPollIntervals: string[];
  /**
   * Node-level Codex review bot timeouts (seconds), sorted. Format:
   * `<nodeName>|<seconds>`. Empty string when absent. Detects changes to
   * custom per-node codex reaction-check timeouts.
   */
  nodeCodexTimeouts: string[];
  /**
   * Legacy workflow-level post-approval route. Kept in the fingerprint so
   * clearing old template-level routes also triggers a re-stamp.
   */
  legacyPostApproval: string;
}

/**
 * Locale-independent string comparison for deterministic ordering.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Total-order comparator for gate fields. Sorts by name, then type, then
 * serialized check — ensuring deterministic ordering even when field names
 * are duplicated (which is not enforced by runtime validation).
 */
function compareGateFields(a: GateField, b: GateField): number {
  return (
    compareStrings(a.name, b.name) ||
    compareStrings(a.type, b.type) ||
    compareStrings(JSON.stringify(serializeCheck(a.check)), JSON.stringify(serializeCheck(b.check)))
  );
}

/**
 * Serialize a gate field check into a deterministic object with keys in fixed
 * order. This avoids reliance on JSON key insertion order from imported objects,
 * which can vary across parse/serialize round-trips.
 */
function serializeCheck(check: GateFieldCheck): Record<string, unknown> {
  if (check.op === 'count') {
    return { op: 'count', match: check.match, min: check.min };
  }
  // Scalar checks: op is always present; value only when defined.
  const result: Record<string, unknown> = { op: check.op };
  if ('value' in check && check.value !== undefined) {
    result.value = check.value;
  }
  return result;
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
        gateId: c.gateId ?? null,
        maxCycles: c.maxCycles ?? null,
        label: c.label ?? null,
      });
    })
    .sort();

  // Exhaustive JSON serialization of gates — all structurally-meaningful fields
  // included automatically. No hand-crafted string format that can drift from
  // the type definition.
  const gates = (workflow.gates ?? [])
    .map((g) =>
      JSON.stringify({
        id: g.id,
        requiredLevel: g.requiredLevel ?? 0,
        resetOnCycle: g.resetOnCycle,
        fields: (g.fields ?? [])
          .slice()
          .sort(compareGateFields)
          .map((f) => ({
            name: f.name,
            type: f.type,
            writers: [...f.writers].sort(),
            check: serializeCheck(f.check),
          })),
        features: g.features ?? null,
        script: g.script ? g.script.source : null,
        poll: g.poll
          ? {
              intervalMs: g.poll.intervalMs,
              target: g.poll.target,
              messageTemplate: g.poll.messageTemplate ?? '',
              script: g.poll.script,
            }
          : null,
      })
    )
    .sort();

  const hooks = (workflow.hooks ?? []).map((hook) => JSON.stringify(hook)).sort();

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

  // Serialize node-level post-approval routes.
  const nodePostApproval = workflow.nodes
    .filter((n) => n.postApproval)
    .map(
      (n) => `${n.name}|${n.postApproval?.targetAgent ?? ''}|${n.postApproval?.instructions ?? ''}`
    )
    .sort();

  // Serialize node-level Codex approval flags.
  const nodeCodexFlags = workflow.nodes
    .filter((n) => n.requireCodexApproval)
    .map((n) => `${n.name}|true`)
    .sort();

  // Serialize node-level Codex poll intervals.
  const nodeCodexPollIntervals = workflow.nodes
    .filter((n) => n.codexPollIntervalMs)
    .map((n) => `${n.name}|${n.codexPollIntervalMs}`)
    .sort();

  // Serialize node-level Codex review bot timeouts (seconds).
  const nodeCodexTimeouts = workflow.nodes
    .filter((n) => n.codexTimeoutSeconds)
    .map((n) => `${n.name}|${n.codexTimeoutSeconds}`)
    .sort();

  // Serialize legacy workflow-level post-approval route.
  const legacyPostApproval = workflow.postApproval
    ? `${workflow.postApproval.targetAgent}|${workflow.postApproval.instructions ?? ''}`
    : '';

  return {
    description: workflow.description ?? '',
    instructions: workflow.instructions ?? '',
    nodeNames,
    channels,
    gates,
    hooks,
    nodePrompts,
    completionAutonomyLevel: workflow.completionAutonomyLevel,
    nodePostApproval,
    nodeCodexFlags,
    nodeCodexPollIntervals,
    nodeCodexTimeouts,
    legacyPostApproval,
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
