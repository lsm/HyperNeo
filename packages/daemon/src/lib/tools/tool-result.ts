export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
