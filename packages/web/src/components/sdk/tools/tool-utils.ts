import { getToolConfig, getCategoryColors } from './tool-registry.ts';
import type { ToolIconSize } from './tool-types.ts';

export function getToolSummary(toolName: string, input: unknown): string {
  const config = getToolConfig(toolName);

  if (config.summaryExtractor) {
    const summary = config.summaryExtractor(input);
    if (summary) return summary;
  }

  return 'Tool execution';
}

export function getInvokedOperationName(toolName: string, input: unknown): string | null {
  if (!isInvokeTool(toolName) || !input || typeof input !== 'object' || !('name' in input))
    return null;
  return typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null;
}

function isInvokeTool(toolName: string): boolean {
  return (
    toolName === 'invoke' ||
    (toolName.startsWith('mcp__') && toolName.split('__').slice(2).join('__') === 'invoke')
  );
}

export function getToolHeader(
  toolName: string,
  input?: unknown
): { name: string; detail: string | null } {
  if (isInvokeTool(toolName)) {
    const operation = getInvokedOperationName(toolName, input);
    return { name: operation ? `invoke ${operation}` : 'invoke', detail: null };
  }
  const config = getToolConfig(toolName);
  return { name: config.displayName || toolName, detail: getToolSummary(toolName, input) };
}

export function getToolDisplayName(toolName: string, input?: unknown): string {
  return getToolHeader(toolName, input).name;
}

export function getToolColors(toolName: string) {
  const config = getToolConfig(toolName);

  if (config.colors) {
    return config.colors;
  }

  return getCategoryColors(config.category);
}

export function getIconSizeClasses(size: ToolIconSize): string {
  switch (size) {
    case 'xs':
      return 'w-3 h-3';
    case 'sm':
      return 'w-4 h-4';
    case 'md':
      return 'w-5 h-5';
    case 'lg':
      return 'w-6 h-6';
    case 'xl':
      return 'w-8 h-8';
    default:
      return 'w-5 h-5';
  }
}

export function formatElapsedTime(seconds: number): string {
  if (seconds < 1) {
    return `${(seconds * 1000).toFixed(0)}ms`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function formatJSON(data: unknown, indent: number = 2): string {
  try {
    return JSON.stringify(data, null, indent);
  } catch {
    return String(data);
  }
}

export function getOutputDisplayText(output: unknown): string {
  if (output === null || output === undefined) {
    return '';
  }

  if (typeof output === 'string') {
    return output;
  }

  if (typeof output === 'object') {
    if ('content' in output) {
      return getOutputDisplayText(output.content);
    }

    return formatJSON(output);
  }

  return String(output);
}
