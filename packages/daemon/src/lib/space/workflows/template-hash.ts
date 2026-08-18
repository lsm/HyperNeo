import type { SpaceWorkflow } from '@hyperneo/shared';
import { createHash } from 'node:crypto';

interface WorkflowFingerprint {
  description: string;
  instructions: string;
  nodeNames: string[];
  channels: string[];
  hooks: string[];
  nodePrompts: string[];
  nodeAgentResetContext?: string[];
  completionAutonomyLevel: number;
  nodePostApproval: string[];
  legacyPostApproval: string;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildWorkflowFingerprint(workflow: SpaceWorkflow): WorkflowFingerprint {
  const nodeNames = workflow.nodes.map((n) => n.name).sort();

  const channels = (workflow.channels ?? [])
    .map((c) => {
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

  const hooks = (workflow.hooks ?? []).map((hook) => JSON.stringify(hook)).sort();

  const nodePrompts = workflow.nodes
    .flatMap((n) =>
      n.agents.map(
        (a) =>
          `${n.name}|${a.name}|${a.replaceAgentPrompt ? 'replace' : 'append'}|${a.customPrompt?.value ?? ''}`
      )
    )
    .sort();

  const nodeAgentResetContextEntries = workflow.nodes
    .flatMap((n) => n.agents.filter((a) => a.resetContextPerTurn).map((a) => `${n.name}|${a.name}`))
    .sort();

  const nodeAgentToolGuardsEntries = workflow.nodes
    .flatMap((n) =>
      n.agents
        .filter((a) => Array.isArray(a.toolGuards) && a.toolGuards.length > 0)
        .map((a) => `${n.name}|${a.name}|${JSON.stringify(a.toolGuards)}`)
    )
    .sort();

  const nodeAgentEventInterestsEntries = workflow.nodes
    .flatMap((n) =>
      n.agents
        .filter((a) => Array.isArray(a.eventInterests) && a.eventInterests.length > 0)
        .map((a) => `${n.name}|${a.name}|${JSON.stringify(a.eventInterests)}`)
    )
    .sort();

  const nodePostApproval = workflow.nodes
    .filter((n) => n.postApproval)
    .map(
      (n) =>
        `${n.name}|${n.postApproval?.targetAgent ?? ''}|${n.postApproval?.instructions ?? ''}|${n.postApproval?.requirePrMerge ? '1' : '0'}`
    )
    .sort();

  const legacyPostApproval = workflow.postApproval
    ? `${workflow.postApproval.targetAgent}|${workflow.postApproval.instructions ?? ''}|${workflow.postApproval.requirePrMerge ? '1' : '0'}`
    : '';

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
    hooks,
    nodePrompts,
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

export function computeWorkflowHash(workflow: SpaceWorkflow): string {
  const fp = buildWorkflowFingerprint(workflow);
  const json = JSON.stringify(fp);
  return createHash('sha256').update(json).digest('hex');
}

export function workflowsMatchFingerprint(a: SpaceWorkflow, b: SpaceWorkflow): boolean {
  return computeWorkflowHash(a) === computeWorkflowHash(b);
}
