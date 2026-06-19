/**
 * Worker agents page for Space configuration.
 *
 * Shows ephemeral workflow-defined agent slots aggregated from workflow definitions.
 */

import { useMemo } from 'preact/hooks';
import type { SpaceWorkflow, WorkflowNodeAgent } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';

interface WorkerAgentInfo {
  workflowId: string;
  nodeId: string;
  agentId: string;
  name: string;
  description: string;
  toolPermissions: string[];
  usedIn: string[];
}

const DEFAULT_WORKER_DESCRIPTIONS: Record<string, string> = {
  coder: 'Implements code changes and prepares pull requests for review.',
  reviewer: 'Reviews implementation quality, correctness, and project fit.',
  review: 'Reviews implementation quality, correctness, and project fit.',
  qa: 'Validates behavior, tests changes, and reports regressions.',
  research: 'Investigates code, docs, and product context before implementation.',
  planner: 'Breaks goals into concrete implementation steps and tradeoffs.',
  general: 'Handles general workflow tasks that do not need a specialist role.',
};

function titleCaseName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function describeAgent(name: string, slot: WorkflowNodeAgent): string {
  const prompt = slot.customPrompt?.value?.trim();
  if (prompt) return prompt;
  return DEFAULT_WORKER_DESCRIPTIONS[name.toLowerCase()] ?? `${titleCaseName(name)} worker agent.`;
}

function getToolPermissions(slot: WorkflowNodeAgent): string[] {
  const permissions = new Set<string>();

  for (const serverName of Object.keys(slot.extraMcpServers ?? {})) {
    permissions.add(serverName);
  }
  for (const guard of slot.toolGuards ?? []) {
    permissions.add(`${guard.matcher} guard`);
  }
  if ((slot.disabledSkillIds?.length ?? 0) > 0) {
    permissions.add(`${slot.disabledSkillIds?.length} disabled skills`);
  }
  if ((slot.eventInterests?.length ?? 0) > 0) {
    permissions.add('event subscriptions');
  }

  return [...permissions].sort((a, b) => a.localeCompare(b));
}

export function getWorkerAgentsFromWorkflows(workflows: SpaceWorkflow[]): WorkerAgentInfo[] {
  const agentsByKey = new Map<string, WorkerAgentInfo>();
  const baseAgents = new Map(spaceStore.agents.value.map((agent) => [agent.id, agent]));

  for (const workflow of workflows) {
    const workflowAgentKeys = new Set<string>();
    for (const node of workflow.nodes) {
      for (const slot of node.agents ?? []) {
        const name = slot.name?.trim();
        if (!name) continue;

        const agentId = slot.agentId?.trim() ?? '';
        const nodeId = node.id?.trim() ?? '';
        const key = `${workflow.id}:${nodeId}:${agentId}:${name}`;
        let agent = agentsByKey.get(key);
        if (!agent) {
          agent = {
            workflowId: workflow.id,
            nodeId,
            agentId,
            name,
            description: '',
            toolPermissions: [],
            usedIn: [],
          };
          agentsByKey.set(key, agent);
        }
        if (slot.customPrompt?.value?.trim()) {
          agent.description = slot.customPrompt.value.trim();
        } else if (!agent.description) {
          agent.description = describeAgent(name, slot);
        }

        for (const permission of getToolPermissions(slot)) {
          if (!agent.toolPermissions.includes(permission)) agent.toolPermissions.push(permission);
        }

        const baseAgent = baseAgents.get(agentId);
        for (const tool of baseAgent?.tools ?? []) {
          if (!agent.toolPermissions.includes(tool)) agent.toolPermissions.push(tool);
        }

        workflowAgentKeys.add(key);
      }
    }

    for (const key of workflowAgentKeys) {
      const agent = agentsByKey.get(key);
      if (agent && !agent.usedIn.includes(workflow.name)) agent.usedIn.push(workflow.name);
    }
  }

  return [...agentsByKey.values()]
    .map((agent) => ({
      ...agent,
      toolPermissions: agent.toolPermissions.sort((a, b) => a.localeCompare(b)),
      usedIn: agent.usedIn.sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      const byWorkflow = a.workflowId.localeCompare(b.workflowId);
      if (byWorkflow !== 0) return byWorkflow;
      const byNode = a.nodeId.localeCompare(b.nodeId);
      if (byNode !== 0) return byNode;
      const byAgentId = a.agentId.localeCompare(b.agentId);
      if (byAgentId !== 0) return byAgentId;
      return a.name.localeCompare(b.name);
    });
}

function AgentIcon() {
  return (
    <svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
      />
    </svg>
  );
}

function WorkerAgentCard({ agent }: { agent: WorkerAgentInfo }) {
  return (
    <div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
      <div class="flex min-w-0 items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-sm font-medium text-gray-100">{titleCaseName(agent.name)}</h3>
          <p class="mt-1 font-mono text-xs text-blue-300">{agent.name}</p>
          <p class="font-mono text-xs text-gray-600">{agent.agentId}</p>
        </div>
        <span class="rounded border border-white/10 bg-dark-800 px-2 py-1 text-xs text-gray-500">
          Read-only
        </span>
      </div>

      <p class="mt-3 line-clamp-3 text-xs leading-5 text-gray-500">{agent.description}</p>

      <div class="mt-4 space-y-3">
        <div>
          <p class="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Tool permissions
          </p>
          {agent.toolPermissions.length === 0 ? (
            <p class="mt-1 text-xs text-gray-600">Default workflow permissions</p>
          ) : (
            <div class="mt-2 flex flex-wrap gap-1.5">
              {agent.toolPermissions.map((permission) => (
                <span
                  key={permission}
                  class="rounded border border-white/10 bg-dark-800 px-1.5 py-0.5 font-mono text-xs text-gray-400"
                >
                  {permission}
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          <p class="text-xs font-semibold uppercase tracking-wider text-gray-400">Used in</p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            {agent.usedIn.map((workflowName) => (
              <span
                key={workflowName}
                class="rounded border border-blue-400/20 bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-200"
              >
                {workflowName}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SpaceAgentList() {
  const loading = spaceStore.loading.value;
  const workflowDetails = spaceStore.workflowDetails.value;
  const agents = spaceStore.agents.value;
  const workflowDetailsLoaded = spaceStore.workflowDetailsLoaded.value;
  const workerAgents = useMemo(
    () => getWorkerAgentsFromWorkflows(workflowDetails),
    [workflowDetails, agents]
  );

  if (loading || !workflowDetailsLoaded) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center">
          <span class="text-xs text-gray-600 animate-pulse">Loading agents...</span>
        </div>
      </div>
    );
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="mb-3 flex flex-shrink-0 flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="flex min-w-0 items-start gap-3">
          <div class="mt-0.5 h-8 w-1 flex-shrink-0 rounded-full bg-blue-400/70" />
          <div class="min-w-0">
            <p class="text-xs font-semibold uppercase tracking-wider text-gray-300">
              Worker Agents · {workerAgents.length} configured
            </p>
            <p class="mt-1 text-xs text-gray-500">
              Short-term agents that execute within workflows. They are created on-demand when tasks
              run and do not persist between sessions.
            </p>
          </div>
        </div>
        <span class="rounded border border-white/10 bg-dark-800 px-2 py-1 text-xs text-gray-500">
          Defined by workflow templates
        </span>
      </div>

      <div class="scrollbar-dark min-h-0 flex-1 overflow-y-auto pr-3">
        <div class="min-h-[calc(100%+1px)] space-y-3 pb-4">
          {workerAgents.length === 0 ? (
            <div class="flex flex-col items-center justify-center py-12 text-center">
              <div class="w-10 h-10 rounded-full bg-dark-800 flex items-center justify-center mb-3">
                <AgentIcon />
              </div>
              <p class="text-sm text-gray-400 font-medium">No worker agents configured.</p>
              <p class="text-xs text-gray-600 mt-1">Create a workflow to define worker agents.</p>
            </div>
          ) : (
            <div class="grid gap-3 lg:grid-cols-2">
              {workerAgents.map((agent) => (
                <WorkerAgentCard
                  key={`${agent.workflowId}:${agent.nodeId}:${agent.agentId}:${agent.name}`}
                  agent={agent}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
