export const SDK_MESSAGE_COLUMN_TYPES = {
  input_kind: 'TEXT',
  is_replay: 'INTEGER',
  is_synthetic: 'INTEGER',
  is_error: 'INTEGER',
  internal_compaction_turn: 'INTEGER',
  recovery_intercepted: 'INTEGER',
  recovery_billing_terminal: 'INTEGER',
  info_level: 'INTEGER',
  resolved: 'INTEGER',
  bg_task_id: 'TEXT',
  bg_tool_use_id: 'TEXT',
  hook_id: 'TEXT',
  first_block_type: 'TEXT',
  has_tool_result: 'INTEGER',
  tool_result_only: 'INTEGER',
  user_status_eligible: 'INTEGER',
  task_input_eligible: 'INTEGER',
} as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scalar(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return Number(value);
  return typeof value === 'string' || typeof value === 'number' ? value : JSON.stringify(value);
}

function flag(value: unknown): string | number | null {
  return typeof value === 'string' ? JSON.stringify(value) : scalar(value);
}

function sqliteInteger(value: unknown): number {
  if (typeof value === 'string') return Number(/^[ \t\n\r\f\v]*[+-]?\d+/.exec(value)?.[0] ?? 0);
  return typeof value === 'number' || typeof value === 'boolean' ? Math.trunc(Number(value)) : 0;
}

export function deriveSdkMessageColumns(message: unknown, taskId: string | null = null) {
  const m = record(message);
  const content = record(m.message).content;
  const blocks = Array.isArray(content) ? content.map(record) : [];
  const hasToolResult = blocks.some((block) => block.type === 'tool_result');
  const hasText = blocks.some(
    (block) =>
      block.type === 'text' && String(scalar(block.text) ?? '').replace(/^ +| +$/g, '') !== ''
  );
  return {
    input_kind: scalar(m.inputKind),
    is_replay: flag(m.isReplay),
    is_synthetic: flag(m.isSynthetic),
    is_error: flag(m.is_error),
    internal_compaction_turn: flag(m.internal_compaction_turn),
    recovery_intercepted: flag(m.recovery_intercepted),
    recovery_billing_terminal: flag(m.recovery_billing_terminal),
    info_level: Number(m.level === 'info'),
    resolved: flag(m.resolved),
    bg_task_id: scalar(m.task_id) ?? taskId,
    bg_tool_use_id: scalar(m.tool_use_id),
    hook_id: scalar(m.hook_id),
    first_block_type: scalar(blocks[0]?.type),
    has_tool_result: Number(hasToolResult),
    tool_result_only: Number(hasToolResult && !hasText),
    user_status_eligible: Number(
      m.type === 'user' && (m.isReplay === undefined || m.isReplay === false)
    ),
    task_input_eligible: Number(
      m.type === 'user' &&
        (m.inputKind === 'task' ||
          (m.inputKind === undefined && sqliteInteger(m.isSynthetic) === 1))
    ),
  };
}
