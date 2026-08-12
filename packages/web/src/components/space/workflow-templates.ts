/**
 * workflow-templates.ts
 *
 * Shared utility types and functions for building workflow templates and node
 * drafts. Extracted from WorkflowEditor.tsx so they can be used by both the
 * visual editor (VisualWorkflowEditor.tsx) and any future editors without
 * pulling in the full legacy component.
 */

import type {
  DeclarativeToolGuard,
  HandoffTransition,
  SpaceWorkerAgent,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowNodeAgent,
  PostApprovalRoute,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { NodeDraft } from './WorkflowNodeCard';

// ============================================================================
// Template Definitions
// ============================================================================

export interface WorkflowTemplate {
  label: string;
  description: string;
  /** Template start node name. */
  startStepName?: string;
  /** Template end node name. */
  endStepName?: string;
  /** Legacy shorthand for single-agent linear templates. */
  stepRoles?: string[]; // agent role names to look up from agent list
  /** Rich step definitions for multi-agent templates. */
  steps?: WorkflowTemplateStep[];
  /** Optional workflow-level channels to seed with the template. */
  channels?: WorkflowChannel[];
  /** Optional workflow hooks to seed with the template. */
  hooks?: import('@hyperneo/shared').WorkflowHook[];
  /** Optional tags to seed with the template. */
  tags?: string[];
  /** Legacy workflow-level post-approval route; migrated onto the end node when loaded. */
  postApproval?: PostApprovalRoute;
}

export interface WorkflowTemplateStep {
  /** Display name for the node. */
  name: string;
  /** Single-agent role/name lookup key. Ignored when agentSlots is provided. */
  role?: string;
  /** Explicit agent ID to use (skips role lookup when set). */
  agentId?: string;
  /** Multi-agent slot definitions for parallel node execution. */
  agentSlots?: WorkflowTemplateAgentSlot[];
  /** Optional default node system prompt. */
  systemPrompt?: string;
  /** Optional model override for single-agent templates. */
  model?: string;
  /** Optional thinking-level override for single-agent templates. */
  thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
  /** Optional default node instructions. */
  instructions?: string;
  /** Per-slot fresh-context flag (clear model context each handoff). */
  resetContextPerTurn?: boolean;
  /** Optional post-approval route triggered when this node approves the task. */
  postApproval?: PostApprovalRoute;
  /** Require codex[bot] approval on outgoing approval gates from this node. */
  requireCodexApproval?: boolean;
  /** Custom poll interval (ms) for the codex review bot. */
  codexPollIntervalMs?: number;
  /** Custom timeout (seconds) for the codex review bot reaction check. */
  codexTimeoutSeconds?: number;
  /**
   * Per-agent declarative tool guards for single-agent nodes (e.g. the coder's
   * raw-merge blocker). Preserved through workflowToTemplate → buildTemplateNodes
   * so cloned built-in templates keep their runtime enforcement.
   */
  toolGuards?: DeclarativeToolGuard[];
  /**
   * Declared outbound handoff transitions. Preserved through workflowToTemplate
   * → buildTemplateNodes so a workflow cloned via the template picker keeps its
   * handoff contract (gates/hooks/channels already clone).
   */
  handoffTransitions?: HandoffTransition[];
}

export interface WorkflowTemplateAgentSlot {
  /** Unique slot name inside the node (e.g. "Reviewer 1"). */
  name: string;
  /** Agent role/name lookup key used to assign the slot. */
  role: string;
  /** Explicit agent ID to use for this slot (skips role lookup when set). */
  agentId?: string;
  /** Optional model override for this slot. */
  model?: string;
  /** Optional thinking-level override for this slot. */
  thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
  /** Optional default slot system prompt. */
  systemPrompt?: string;
  /** Optional default slot instructions. */
  instructions?: string;
  /** Per-slot fresh-context flag (clear model context each handoff). */
  resetContextPerTurn?: boolean;
  /** Per-slot declarative tool guards (mirrors WorkflowNodeAgent.toolGuards). */
  toolGuards?: DeclarativeToolGuard[];
}

// ============================================================================
// Private helpers
// ============================================================================

function makeLocalId(): string {
  return generateUUID();
}

function capitalizeRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function normalizeAgentLookup(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

const TEMPLATE_ROLE_ALIASES: Record<string, string[]> = {
  planner: ['planner', 'plan'],
  coder: ['coder', 'code', 'developer', 'engineer'],
  reviewer: ['reviewer', 'review'],
  research: ['research', 'researcher'],
  qa: ['qa', 'quality', 'tester', 'test'],
  general: ['general', 'done', 'summary'],
};

const TEMPLATE_FALLBACK_USAGE_KEY = '__template-fallback__';

function resolveTemplateAgent(
  roleOrName: string,
  agents: SpaceWorkerAgent[],
  usageByRole: Map<string, number>
): SpaceWorkerAgent | undefined {
  const key = normalizeAgentLookup(roleOrName);
  if (!key) return undefined;

  const aliases = TEMPLATE_ROLE_ALIASES[key] ?? [key];
  const aliasSet = new Set(aliases);
  const matches = agents.filter((a) => {
    const normalizedName = normalizeAgentLookup(a.name);
    if (!normalizedName) return false;
    if (normalizedName === key) return true;
    if (normalizedName.includes(key)) return true;
    const tokens = normalizedName.split(' ');
    return tokens.some((token) => aliasSet.has(token));
  });

  if (matches.length === 0) return undefined;

  // Prefer distinct matches for repeated slots of the same role, then fall back
  // to the last available match if there are more slots than agents.
  const used = usageByRole.get(key) ?? 0;
  usageByRole.set(key, used + 1);
  return matches[Math.min(used, matches.length - 1)];
}

function getTemplateStepDefs(template: WorkflowTemplate): WorkflowTemplateStep[] {
  if (Array.isArray(template.steps) && template.steps.length > 0) {
    return template.steps;
  }

  const stepRoles = template.stepRoles ?? [];
  return stepRoles.map((role) => ({ name: capitalizeRole(role), role }));
}

function extractInstructionText(
  value:
    | string
    | null
    | undefined
    | {
        value?: string | null;
      }
): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.value !== 'string') return undefined;
  const trimmed = value.value.trim();
  return trimmed ? trimmed : undefined;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Filter agents for step assignment: exclude any agent whose name or role is
 * 'leader' (case-insensitive). The 'leader' role is reserved for the
 * orchestration layer and must not be assigned to workflow steps.
 */
export function filterAgents(agents: SpaceWorkerAgent[]): SpaceWorkerAgent[] {
  return agents.filter((a) => a.name.toLowerCase() !== 'leader');
}

/** Convert a persisted workflow into a template picker entry. */
export function workflowToTemplate(workflow: SpaceWorkflow): WorkflowTemplate {
  const startNodeName = workflow.nodes.find((node) => node.id === workflow.startNodeId)?.name;
  const endNodeName = workflow.nodes.find((node) => node.id === workflow.endNodeId)?.name;

  const steps: WorkflowTemplateStep[] = workflow.nodes.map((node) => {
    const postApproval =
      node.postApproval ?? (node.id === workflow.endNodeId ? workflow.postApproval : undefined);
    if ((node.agents?.length ?? 0) > 1) {
      return {
        name: node.name,
        agentSlots: (node.agents ?? []).map((agent) => ({
          name: agent.name || agent.agentId,
          role: agent.name || agent.agentId,
          agentId: agent.agentId,
          model: agent.model,
          systemPrompt: extractInstructionText(agent.customPrompt),
          resetContextPerTurn: agent.resetContextPerTurn,
          toolGuards: agent.toolGuards?.map((guard) => ({ ...guard })),
        })),
        postApproval: postApproval ? { ...postApproval } : undefined,
        requireCodexApproval: node.requireCodexApproval,
        codexPollIntervalMs: node.codexPollIntervalMs,
        codexTimeoutSeconds: node.codexTimeoutSeconds,
        ...(node.transitions?.length
          ? { handoffTransitions: node.transitions.map((t) => ({ ...t })) }
          : {}),
      };
    }

    const primary = node.agents?.[0];
    return {
      name: node.name,
      role: primary?.name ?? primary?.agentId ?? '',
      agentId: primary?.agentId,
      model: primary?.model,
      systemPrompt: extractInstructionText(primary?.customPrompt),
      resetContextPerTurn: primary?.resetContextPerTurn,
      toolGuards: primary?.toolGuards?.map((guard) => ({ ...guard })),
      postApproval: postApproval ? { ...postApproval } : undefined,
      requireCodexApproval: node.requireCodexApproval,
      codexPollIntervalMs: node.codexPollIntervalMs,
      codexTimeoutSeconds: node.codexTimeoutSeconds,
      ...(node.transitions?.length
        ? { handoffTransitions: node.transitions.map((t) => ({ ...t })) }
        : {}),
    };
  });

  return {
    label: workflow.name,
    description: workflow.description ?? '',
    startStepName: startNodeName,
    endStepName: endNodeName,
    steps,
    channels: (workflow.channels ?? []).map((channel) => ({
      ...channel,
      to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
    })),
    hooks: (workflow.hooks ?? []).map((hook) => ({ ...hook })),
    tags: [...(workflow.tags ?? [])],
  };
}

/**
 * Convert daemon-provided built-in template workflows into editor template entries.
 */
export function getAvailableTemplates(workflows: SpaceWorkflow[]): WorkflowTemplate[] {
  return workflows
    .map((workflow) => workflowToTemplate(workflow))
    .filter((template) => Boolean(template.startStepName?.trim() && template.endStepName?.trim()));
}

/**
 * Build workflow node drafts from a template definition.
 * Supports both legacy single-agent stepRoles and multi-agent steps.
 */
export function buildTemplateNodes(
  template: WorkflowTemplate,
  agents: SpaceWorkerAgent[]
): NodeDraft[] {
  const usageByRole = new Map<string, number>();
  const stepDefs = getTemplateStepDefs(template);

  return stepDefs.map((step, index) => {
    const name = step.name?.trim() || `Step ${index + 1}`;

    if (Array.isArray(step.agentSlots) && step.agentSlots.length > 0) {
      const agentSlots: WorkflowNodeAgent[] = step.agentSlots.map((slot, slotIndex) => {
        const assigned =
          (slot.agentId ? agents.find((agent) => agent.id === slot.agentId) : undefined) ??
          resolveTemplateAgent(slot.role, agents, usageByRole) ??
          (() => {
            const fallbackUsed = usageByRole.get(TEMPLATE_FALLBACK_USAGE_KEY) ?? 0;
            usageByRole.set(TEMPLATE_FALLBACK_USAGE_KEY, fallbackUsed + 1);
            if (agents.length === 0) return undefined;
            return agents[Math.min(fallbackUsed, agents.length - 1)];
          })();
        return {
          agentId: assigned?.id ?? '',
          name: slot.name?.trim() || `${capitalizeRole(slot.role)} ${slotIndex + 1}`,
          model: slot.model?.trim() || undefined,
          thinkingLevel: slot.thinkingLevel,
          customPrompt: slot.systemPrompt?.trim() ? { value: slot.systemPrompt.trim() } : undefined,
          ...(slot.resetContextPerTurn ? { resetContextPerTurn: true } : {}),
          ...(slot.toolGuards
            ? { toolGuards: slot.toolGuards.map((guard) => ({ ...guard })) }
            : {}),
        };
      });

      return {
        localId: makeLocalId(),
        name,
        agentId: '',
        agents: agentSlots,
        customPrompt: step.systemPrompt?.trim() ? { value: step.systemPrompt.trim() } : undefined,
        postApproval: step.postApproval ? { ...step.postApproval } : undefined,
        // Seed the sticky step-level field so the post-approval toggle cannot
        // drop the hidden merge gate on a template-picker draft.
        requirePrMerge: step.postApproval?.requirePrMerge === true ? true : undefined,
        requireCodexApproval: step.requireCodexApproval,
        codexPollIntervalMs: step.codexPollIntervalMs,
        codexTimeoutSeconds: step.codexTimeoutSeconds,
        ...(step.handoffTransitions?.length
          ? { handoffTransitions: step.handoffTransitions.map((t) => ({ ...t })) }
          : {}),
      };
    }

    const role = step.role?.trim() ?? '';
    const assigned =
      (step.agentId ? agents.find((agent) => agent.id === step.agentId) : undefined) ??
      (role ? resolveTemplateAgent(role, agents, usageByRole) : undefined) ??
      (() => {
        const fallbackUsed = usageByRole.get(TEMPLATE_FALLBACK_USAGE_KEY) ?? 0;
        usageByRole.set(TEMPLATE_FALLBACK_USAGE_KEY, fallbackUsed + 1);
        if (agents.length === 0) return undefined;
        return agents[Math.min(fallbackUsed, agents.length - 1)];
      })();
    const resolvedCustomPrompt = step.systemPrompt?.trim()
      ? { value: step.systemPrompt.trim() }
      : undefined;
    const resolvedRoleName =
      role || assigned?.name?.trim() || name.toLowerCase().replace(/\s+/g, '-') || 'agent';
    return {
      localId: makeLocalId(),
      name,
      agentId: assigned?.id ?? '',
      agents: [
        {
          agentId: assigned?.id ?? '',
          name: resolvedRoleName,
          model: step.model?.trim() || undefined,
          thinkingLevel: step.thinkingLevel,
          customPrompt: resolvedCustomPrompt,
          ...(step.resetContextPerTurn ? { resetContextPerTurn: true } : {}),
          ...(step.toolGuards
            ? { toolGuards: step.toolGuards.map((guard) => ({ ...guard })) }
            : {}),
        },
      ],
      // Step-level model/thinkingLevel/customPrompt left undefined to avoid
      // duplicating slot values. The NodeConfigPanel fallback
      // (slot.field ?? step.field) reads from the slot when present.
      model: undefined,
      thinkingLevel: undefined,
      customPrompt: undefined,
      postApproval: step.postApproval ? { ...step.postApproval } : undefined,
      // Seed the sticky step-level field so the post-approval toggle cannot
      // drop the hidden merge gate on a template-picker draft.
      requirePrMerge: step.postApproval?.requirePrMerge === true ? true : undefined,
      requireCodexApproval: step.requireCodexApproval,
      codexPollIntervalMs: step.codexPollIntervalMs,
      codexTimeoutSeconds: step.codexTimeoutSeconds,
      ...(step.handoffTransitions?.length
        ? { handoffTransitions: step.handoffTransitions.map((t) => ({ ...t })) }
        : {}),
    };
  });
}
