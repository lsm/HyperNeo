import type {
  SpaceTaskStatus,
  SpaceWorkerAgent,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowNode,
  WorkflowNodeAgent,
  WorkflowRunStatus,
  WorkerAgentModelPoolEntry,
} from './space.ts';

export function resolveNodeAgents(node: WorkflowNode): WorkflowNodeAgent[] {
  if (node.agents && node.agents.length > 0) {
    return node.agents;
  }

  const legacyRecord = node as unknown as Record<string, unknown>;
  const legacyAgentId = legacyRecord['agentId'] as string | undefined;
  if (legacyAgentId) {
    return [{ agentId: legacyAgentId, name: node.name }];
  }

  throw new Error(
    `WorkflowNode "${node.name}" (id: ${node.id}) has no agents defined. ` +
      'At least one agent must be provided.'
  );
}

export function modelPoolEntryKey(entry: Pick<WorkerAgentModelPoolEntry, 'model'>): string {
  return entry.model;
}

export interface ModelPoolPickInput {
  entry: WorkerAgentModelPoolEntry;
  running: number;
  cap: number;
  left: number;
  score: number;
}

export function scoreModelPoolEntries(
  entries: WorkerAgentModelPoolEntry[],
  runningCounts: Readonly<Record<string, number>>
): ModelPoolPickInput[] {
  return entries.map((entry) => {
    const cap = Math.max(1, Math.floor(Number(entry.maxConcurrent) || 1));
    const running = Math.max(0, Math.floor(runningCounts[modelPoolEntryKey(entry)] ?? 0));
    const left = Math.max(0, cap - running);
    const weight = Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0;
    const score = Math.min(left * weight, Number.MAX_SAFE_INTEGER);
    return { entry, running, cap, left, score };
  });
}

export function pickModelPoolEntry(
  entries: WorkerAgentModelPoolEntry[],
  runningCounts: Readonly<Record<string, number>>,
  random: () => number = Math.random
): WorkerAgentModelPoolEntry | null {
  if (entries.length === 0) return null;
  const eligible = scoreModelPoolEntries(entries, runningCounts).filter((item) => item.score > 0);
  const total = eligible.reduce((sum, item) => sum + item.score, 0);
  if (total <= 0) return null;
  let cursor = random() * total;
  for (const item of eligible) {
    cursor -= item.score;
    if (cursor <= 0) return item.entry;
  }
  return eligible[eligible.length - 1].entry;
}

const WORKFLOW_RUN_EXECUTION_STATUS_LABELS: Record<WorkflowRunStatus | 'failed', string> = {
  pending: 'Queued',
  in_progress: 'Running',
  blocked: 'Waiting',
  done: 'Succeeded',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export function getWorkflowRunExecutionStatusLabel(status: WorkflowRunStatus | 'failed'): string {
  return WORKFLOW_RUN_EXECUTION_STATUS_LABELS[status];
}

export function isWorkflowRunSucceeded(status: WorkflowRunStatus | 'failed'): status is 'done' {
  return status === 'done';
}

export function isWorkflowRunTerminal(status: WorkflowRunStatus | 'failed'): boolean {
  return status === 'done' || status === 'cancelled' || status === 'failed';
}

export function isWorkflowRunWaiting(status: WorkflowRunStatus | 'failed'): status is 'blocked' {
  return status === 'blocked';
}

export function isRateOrUsageLimited(
  status: SpaceTaskStatus
): status is 'rate_limited' | 'usage_limited' {
  return status === 'rate_limited' || status === 'usage_limited';
}

export function isWorkflowRecoveryTransition(
  from: SpaceTaskStatus,
  to: SpaceTaskStatus
): to is 'open' | 'in_progress' {
  return (
    (from === 'done' && to === 'in_progress') ||
    (from === 'blocked' && (to === 'open' || to === 'in_progress')) ||
    (from === 'cancelled' && (to === 'open' || to === 'in_progress')) ||
    (from === 'stopped' && to === 'in_progress') ||
    (isRateOrUsageLimited(from) && to === 'in_progress')
  );
}

export function findNodeByName(nodes: WorkflowNode[], name: string): WorkflowNode | undefined {
  return nodes.find((n) => n.name === name);
}

export function getChannelsFromNode(
  channels: WorkflowChannel[],
  nodeName: string
): WorkflowChannel[] {
  return channels.filter((ch) => ch.from === nodeName || ch.from === '*');
}

export function getChannelsToNode(
  channels: WorkflowChannel[],
  nodeName: string
): WorkflowChannel[] {
  return channels.filter((ch) => {
    const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
    return toList.includes(nodeName) || toList.includes('*');
  });
}

export function findChannel(
  channels: WorkflowChannel[],
  fromNode: string,
  toNode: string
): WorkflowChannel | undefined {
  return channels.find((ch) => {
    if (ch.from !== fromNode && ch.from !== '*') return false;
    if (ch.to === toNode || ch.to === '*') return true;
    if (Array.isArray(ch.to)) return ch.to.includes(toNode) || ch.to.includes('*');
    return false;
  });
}

export function validateChannels(workflow: SpaceWorkflow, agents: SpaceWorkerAgent[]): string[] {
  const errors: string[] = [];

  const agentIdSet = new Set(agents.map((a) => a.id));
  const knownNodeNames = new Set<string>();
  const seenNodeNames = new Set<string>();

  for (const node of workflow.nodes) {
    if (seenNodeNames.has(node.name)) {
      errors.push(
        `Node name "${node.name}" appears more than once in this workflow. ` +
          'Node names must be unique within a workflow (they are used as channel addressing keys).'
      );
    } else {
      seenNodeNames.add(node.name);
      knownNodeNames.add(node.name);
    }

    let nodeAgents: WorkflowNodeAgent[];
    try {
      nodeAgents = resolveNodeAgents(node);
    } catch (err) {
      errors.push((err as Error).message);
      continue;
    }

    for (const na of nodeAgents) {
      if (!agentIdSet.has(na.agentId)) {
        errors.push(
          `Agent with id "${na.agentId}" in node "${node.name}" not found in space agents.`
        );
      }
    }
  }

  const channels = workflow.channels ?? [];

  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const loc = `workflow.channels[${i}]`;

    if (!ch.id?.trim()) {
      errors.push(`${loc}: channel is missing a required id.`);
    }

    if (ch.from !== '*' && !knownNodeNames.has(ch.from)) {
      errors.push(
        `${loc}.from "${ch.from}" does not match any node name in this workflow. ` +
          `Known nodes: [${[...knownNodeNames].join(', ')}].`
      );
    }

    const toList: string[] = Array.isArray(ch.to) ? ch.to : [ch.to];

    if (toList.length > 1 && toList.includes('*')) {
      errors.push(
        `${loc}.to mixes wildcard '*' with explicit names. ` +
          "Use a plain '*' string (not an array) to target all nodes."
      );
    }

    for (const toRef of toList) {
      if (toRef === '*') continue;
      if (!knownNodeNames.has(toRef)) {
        errors.push(
          `${loc}.to "${toRef}" does not match any node name in this workflow. ` +
            `Known nodes: [${[...knownNodeNames].join(', ')}].`
        );
      }
    }
  }

  return errors;
}
