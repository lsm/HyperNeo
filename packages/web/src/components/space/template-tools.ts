import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';

export function templateToolsList(template: SpaceLongHorizonAgentTemplate | undefined): string[] {
  const tools = template?.toolPermissions?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool): tool is string => typeof tool === 'string');
}

export function trackAddedTools(added: string[], baseline: string[], current: string[]): string[] {
  const stillAdded = added.filter((tool) => current.includes(tool));
  const newlyAdded = current.filter(
    (tool) => !baseline.includes(tool) && !stillAdded.includes(tool)
  );
  return [...stillAdded, ...newlyAdded];
}

export function trackRemovedTools(
  removed: string[],
  baseline: string[],
  current: string[]
): string[] {
  const stillRemoved = removed.filter((tool) => !current.includes(tool));
  const newlyRemoved = baseline.filter(
    (tool) => !current.includes(tool) && !stillRemoved.includes(tool)
  );
  return [...stillRemoved, ...newlyRemoved];
}

export function rebaseTemplateTools(
  current: string[],
  nextBaseline: string[],
  explicit: boolean,
  added: string[],
  removed: string[]
): string[] {
  if (explicit) return current;
  const kept = nextBaseline.filter((tool) => !removed.includes(tool));
  return [...kept, ...added.filter((tool) => !kept.includes(tool))];
}

export function differsFromBaseline(tools: string[], baseline: string[]): boolean {
  if (tools.length !== baseline.length) return true;
  return tools.some((tool) => !baseline.includes(tool));
}
