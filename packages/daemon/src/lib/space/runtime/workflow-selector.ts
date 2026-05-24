/**
 * Workflow Selector
 *
 * Pure function for resolving a SpaceWorkflow from an explicit workflowId.
 * Has no runtime dependencies — takes only data inputs so it can be tested
 * in isolation without any DB or manager instances.
 *
 * Design (per M7 spec):
 *   - Workflow selection has two modes: explicit workflowId OR AI auto-select.
 *   - When workflowId is provided, this function finds it in availableWorkflows.
 *   - When no workflowId is provided, this function returns null — the Space
 *     agent LLM is expected to call list_workflows first and pick explicitly.
 *   - There is no tag-based matching, no keyword-based matching, and no
 *     heuristic fallback. LLM reasoning replaces static heuristics.
 *
 * See: docs/plans/multi-agent-v2-customizable-agents-workflows/07-workflow-selection-intelligence.md
 */

import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowSelectionContext {
  /** The space this selection is scoped to. */
  spaceId: string;
  /**
   * Available workflows to select from.
   * Must all belong to the given spaceId — callers are responsible for pre-filtering.
   */
  availableWorkflows: SpaceWorkflow[];
  /**
   * Optional explicit workflow ID. When provided, the function returns that
   * workflow if found in availableWorkflows, otherwise null.
   *
   * When omitted, returns null — the caller (LLM agent) must call list_workflows
   * and then provide an explicit workflowId.
   */
  workflowId?: string;
}

// ---------------------------------------------------------------------------
// Core selection logic
// ---------------------------------------------------------------------------

/**
 * Resolve a workflow from the available set given an explicit workflowId.
 *
 * Returns null in two cases:
 *   1. No workflowId provided — the LLM agent must pick one via list_workflows.
 *   2. workflowId provided but not found in availableWorkflows.
 *
 * The function is pure and deterministic: given the same inputs it always
 * returns the same output.
 */
export function selectWorkflow(context: WorkflowSelectionContext): SpaceWorkflow | null {
  const { availableWorkflows, workflowId } = context;

  if (!workflowId) {
    // No explicit ID: return null — LLM agent must call list_workflows and pick.
    return null;
  }

  // Explicit ID provided: find it in the available set (or null if not found).
  return availableWorkflows.find((w) => w.id === workflowId) ?? null;
}
