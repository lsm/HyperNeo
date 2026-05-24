/**
 * Shared ToolResult type and jsonResult helper for Space MCP tool handlers.
 *
 * Extracted from space-agent-tools.ts and task-agent-tools.ts to eliminate
 * duplication. Both files previously defined identical types inline.
 */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
