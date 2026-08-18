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

export interface WorkflowTemplate {
  label: string;
  description: string;
  startStepName?: string;
  endStepName?: string;
  stepRoles?: string[];
  steps?: WorkflowTemplateStep[];
  channels?: WorkflowChannel[];
  hooks?: import('@hyperneo/shared').WorkflowHook[];
  tags?: string[];
  postApproval?: PostApprovalRoute;
}

export interface WorkflowTemplateStep {
  name: string;
  role?: string;
  agentId?: string;
  agentSlots?: WorkflowTemplateAgentSlot[];
  systemPrompt?: string;
  model?: string;
  thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
  instructions?: string;
  resetContextPerTurn?: boolean;
  postApproval?: PostApprovalRoute;
  toolGuards?: DeclarativeToolGuard[];
  handoffTransitions?: HandoffTransition[];
}

export interface WorkflowTemplateAgentSlot {
  name: string;
  role: string;
  agentId?: string;
  model?: string;
  thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
  systemPrompt?: string;
  instructions?: string;
  resetContextPerTurn?: boolean;
  toolGuards?: DeclarativeToolGuard[];
}

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

export function filterAgents(agents: SpaceWorkerAgent[]): SpaceWorkerAgent[] {
  return agents.filter((a) => a.name.toLowerCase() !== 'leader');
}

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

export function getAvailableTemplates(workflows: SpaceWorkflow[]): WorkflowTemplate[] {
  return workflows
    .map((workflow) => workflowToTemplate(workflow))
    .filter((template) => Boolean(template.startStepName?.trim() && template.endStepName?.trim()));
}

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
        requirePrMerge: step.postApproval?.requirePrMerge === true ? true : undefined,
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
      model: undefined,
      thinkingLevel: undefined,
      customPrompt: undefined,
      postApproval: step.postApproval ? { ...step.postApproval } : undefined,
      requirePrMerge: step.postApproval?.requirePrMerge === true ? true : undefined,
      ...(step.handoffTransitions?.length
        ? { handoffTransitions: step.handoffTransitions.map((t) => ({ ...t })) }
        : {}),
    };
  });
}
