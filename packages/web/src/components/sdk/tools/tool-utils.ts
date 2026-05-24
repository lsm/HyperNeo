/**
 * Tool Utilities - Shared helper functions for tool rendering
 */

import { getToolConfig, getCategoryColors } from './tool-registry.ts';
import type { ToolIconSize } from './tool-types.ts';

/**
 * Get tool summary text
 */
export function getToolSummary(toolName: string, input: unknown): string {
  const config = getToolConfig(toolName);

  // Try custom extractor first
  if (config.summaryExtractor) {
    const summary = config.summaryExtractor(input);
    if (summary) return summary;
  }

  // Fallback to tool ID
  return 'Tool execution';
}

/**
 * Get tool display name
 */
export function getToolDisplayName(toolName: string): string {
  const config = getToolConfig(toolName);
  return config.displayName || toolName;
}

/**
 * Get tool colors based on category
 */
export function getToolColors(toolName: string) {
  const config = getToolConfig(toolName);

  // Use custom colors if provided
  if (config.colors) {
    return config.colors;
  }

  // Use category colors
  return getCategoryColors(config.category);
}

/**
 * Get icon size classes
 */
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

/**
 * Format elapsed time
 */
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

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Format JSON for display (internal use)
 */
function formatJSON(data: unknown, indent: number = 2): string {
  try {
    return JSON.stringify(data, null, indent);
  } catch {
    return String(data);
  }
}

/**
 * Get output display text
 */
export function getOutputDisplayText(output: unknown): string {
  if (output === null || output === undefined) {
    return '';
  }

  if (typeof output === 'string') {
    return output;
  }

  if (typeof output === 'object') {
    // Check for common output formats
    if ('content' in output) {
      return getOutputDisplayText(output.content);
    }

    // Format as JSON
    return formatJSON(output);
  }

  return String(output);
}

/**
 * Check if tool has custom renderer
 */
export function hasCustomRenderer(toolName: string): boolean {
  const config = getToolConfig(toolName);
  return !!config.customRenderer;
}

/**
 * Get custom renderer component
 */
export function getCustomRenderer(toolName: string) {
  const config = getToolConfig(toolName);
  return config.customRenderer;
}

/**
 * Should tool result be expanded by default?
 */
export function shouldExpandByDefault(toolName: string): boolean {
  const config = getToolConfig(toolName);
  return config.defaultExpanded || false;
}
