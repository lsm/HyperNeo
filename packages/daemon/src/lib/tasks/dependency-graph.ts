export interface TaskDependencyNode {
  id: string;
  dependsOn?: readonly string[];
}

export function buildTaskDependencyGraph(
  tasks: readonly TaskDependencyNode[],
  taskId: string,
  dependsOn: readonly string[]
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.id === taskId) {
      adj.set(task.id, [...dependsOn]);
    } else {
      adj.set(task.id, [...(task.dependsOn ?? [])]);
    }
  }
  return adj;
}

export function hasTaskDependencyCycle(adj: ReadonlyMap<string, readonly string[]>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) {
    color.set(id, WHITE);
  }

  const dfs = (node: string): boolean => {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) ?? []) {
      const c = color.get(neighbor);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(neighbor)) return true;
    }
    color.set(node, BLACK);
    return false;
  };

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE && dfs(id)) return true;
  }
  return false;
}
