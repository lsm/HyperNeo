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

export interface ToolsChangeInput {
  origin: 'preset' | 'edit';
  tools: string[];
  overridden: boolean;
  baseline: string[];
  state: ToolsFormState;
}

export type ToolsGate<T> = { value: T } | { reason: ToolsFormState };

function inherited(baseline: string[]): ToolsFormState {
  return { tools: baseline, overridden: false, explicit: false, added: [], removed: [] };
}

export function gateInheritPreset(input: ToolsChangeInput): ToolsGate<ToolsChangeInput> {
  if (input.origin !== 'preset' || input.overridden) return { value: input };
  return { reason: inherited(input.baseline) };
}

export function gatePresetChoice(input: ToolsChangeInput): ToolsGate<ToolsChangeInput> {
  if (input.origin !== 'preset') return { value: input };
  return {
    reason: {
      tools: input.tools,
      overridden: true,
      explicit: true,
      added: input.state.added,
      removed: input.state.removed,
    },
  };
}

export function gateExplicitEdit(input: ToolsChangeInput): ToolsGate<ToolsChangeInput> {
  if (!input.state.explicit) return { value: input };
  const added = trackAddedTools(input.state.added, [], input.tools);
  if (!differsFromBaseline(input.tools, input.baseline))
    return { reason: inherited(input.baseline) };
  return {
    reason: {
      tools: input.tools,
      overridden: true,
      explicit: true,
      added,
      removed: input.state.removed,
    },
  };
}

export function applyBaselineEdit(input: ToolsChangeInput): ToolsFormState {
  const removed = trackRemovedTools(input.state.removed, input.baseline, input.tools);
  const added = trackAddedTools(input.state.added, input.baseline, input.tools);
  if (
    added.length === 0 &&
    removed.length === 0 &&
    !differsFromBaseline(input.tools, input.baseline)
  ) {
    return inherited(input.baseline);
  }
  return { tools: input.tools, overridden: true, explicit: false, added, removed };
}

export const decideToolsChange = (superpipe({})('agent-tools-change') as PipelineAPI)
  .input(['input'])
  .pipe(gateInheritPreset, 'input', 'result:decided')
  .pipe(gatePresetChoice, 'decided', 'result:decided')
  .pipe(gateExplicitEdit, 'decided', 'result:decided')
  .pipe(applyBaselineEdit, 'decided', 'decided')
  .end('decided') as (input: ToolsChangeInput) => ToolsFormState;
