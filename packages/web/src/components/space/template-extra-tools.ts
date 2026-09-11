import { KNOWN_TOOLS } from '@hyperneo/shared';
import type { ToolsSelection } from './ToolsEditor';

export function extraToolsOf(tools: string[]): string[] {
  return tools.filter((tool) => !(KNOWN_TOOLS as readonly string[]).includes(tool));
}

export function withoutExtraTool(selection: ToolsSelection, tool: string): ToolsSelection {
  const tools = selection.tools.filter((t) => t !== tool);
  return { tools, toolsOverridden: tools.length > 0 };
}

export function withExtraTool(selection: ToolsSelection, entry: string): ToolsSelection {
  if (selection.tools.includes(entry)) return selection;
  return { tools: [...selection.tools, entry], toolsOverridden: true };
}
