import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

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

export interface ToolsFormState {
  tools: string[];
  overridden: boolean;
  explicit: boolean;
  added: string[];
  removed: string[];
}

export type ToolsChangeOriginKind = 'preset' | 'edit';

export type ToolsGate = { value: null } | { reason: ToolsFormState };

function inherited(baseline: string[]): ToolsFormState {
  return { tools: baseline, overridden: false, explicit: false, added: [], removed: [] };
}

export function gateInheritPreset(
  origin: ToolsChangeOriginKind,
  overridden: boolean,
  baseline: string[]
): ToolsGate {
  if (origin !== 'preset' || overridden) return { value: null };
  return { reason: inherited(baseline) };
}

export function gatePresetChoice(
  origin: ToolsChangeOriginKind,
  tools: string[],
  state: ToolsFormState
): ToolsGate {
  if (origin !== 'preset') return { value: null };
  return {
    reason: {
      tools,
      overridden: true,
      explicit: true,
      added: state.added,
      removed: state.removed,
    },
  };
}

export function gateExplicitEdit(
  tools: string[],
  baseline: string[],
  state: ToolsFormState
): ToolsGate {
  if (!state.explicit) return { value: null };
  if (!differsFromBaseline(tools, baseline)) return { reason: inherited(baseline) };
  return {
    reason: {
      tools,
      overridden: true,
      explicit: true,
      added: trackAddedTools(state.added, [], tools),
      removed: state.removed,
    },
  };
}

export function applyBaselineEdit(
  tools: string[],
  baseline: string[],
  state: ToolsFormState
): ToolsFormState {
  const removed = trackRemovedTools(state.removed, baseline, tools);
  const added = trackAddedTools(state.added, baseline, tools);
  if (added.length === 0 && removed.length === 0 && !differsFromBaseline(tools, baseline)) {
    return inherited(baseline);
  }
  return { tools, overridden: true, explicit: false, added, removed };
}

export const decideToolsChange = (superpipe({})('agent-tools-change') as PipelineAPI)
  .input(['origin', 'tools', 'overridden', 'baseline', 'state'])
  .pipe(gateInheritPreset, ['origin', 'overridden', 'baseline'], 'result:decided')
  .pipe(gatePresetChoice, ['origin', 'tools', 'state'], 'result:decided')
  .pipe(gateExplicitEdit, ['tools', 'baseline', 'state'], 'result:decided')
  .pipe(applyBaselineEdit, ['tools', 'baseline', 'state'], 'decided')
  .end('decided') as (
  origin: ToolsChangeOriginKind,
  tools: string[],
  overridden: boolean,
  baseline: string[],
  state: ToolsFormState
) => ToolsFormState;
