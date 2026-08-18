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

export function getToolDisplayName(toolName: string): string {
  const config = getToolConfig(toolName);
  return config.displayName || toolName;
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

export function hasCustomRenderer(toolName: string): boolean {
  const config = getToolConfig(toolName);
  return !!config.customRenderer;
}

export function getCustomRenderer(toolName: string) {
  const config = getToolConfig(toolName);
  return config.customRenderer;
}

export function shouldExpandByDefault(toolName: string): boolean {
  const config = getToolConfig(toolName);
  return config.defaultExpanded || false;
}
