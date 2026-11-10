import type { SpaceTask } from '@hyperneo/shared';

export function buildProposalTaskDescription(
  description: string,
  reason: string,
  evidenceEpisodeIds: string[]
): string {
  const parts = [description.trim()];
  if (reason.trim()) parts.push(`Proposal reason:\n${reason.trim()}`);
  if (evidenceEpisodeIds.length > 0) {
    parts.push(
      `Evolution evidence episodes:\n${evidenceEpisodeIds.map((id) => `- ${id}`).join('\n')}`
    );
  }
  return parts.filter(Boolean).join('\n\n');
}

export function validateTaskDependencies(params: {
  taskId: string;
  dependsOn: string[];
  tasks: SpaceTask[];
}): void {
  const taskIds = new Set(params.tasks.map((task) => task.id));
  for (const depId of params.dependsOn) {
    if (depId === params.taskId) throw new Error('A task cannot depend on itself');
    if (!taskIds.has(depId)) throw new Error(`Dependency task not found in space: ${depId}`);
  }
  if (params.dependsOn.length === 0) return;

  const adj = new Map<string, string[]>();
  for (const task of params.tasks) {
    adj.set(task.id, [...(task.dependsOn ?? [])]);
  }
  adj.set(params.taskId, [...params.dependsOn]);
  if (hasDependencyCycle(adj)) {
    throw new Error('Adding these dependencies would create a circular dependency');
  }
}

function hasDependencyCycle(adj: Map<string, string[]>): boolean {
  const white = 0;
  const gray = 1;
  const black = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, white);

  const dfs = (node: string): boolean => {
    color.set(node, gray);
    for (const neighbor of adj.get(node) ?? []) {
      const state = color.get(neighbor);
      if (state === gray) return true;
      if (state === white && dfs(neighbor)) return true;
    }
    color.set(node, black);
    return false;
  };

  for (const id of adj.keys()) {
    if (color.get(id) === white && dfs(id)) return true;
  }
  return false;
}
