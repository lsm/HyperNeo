import type { Database } from '../sqlite-compat.ts';

const indexes: readonly [string, string, string?][] = [
  [
    'status_projection',
    'session_id, send_status, message_type, user_status_eligible, timestamp, id, sdk_uuid',
  ],
  ['input_kind_time', 'session_id, message_type, input_kind, timestamp'],
  [
    'consumed_input_time',
    'session_id, send_status, message_type, timestamp',
    "message_type = 'user' AND send_status = 'consumed' AND input_kind IS NOT NULL",
  ],
  [
    'restart_prompt',
    'session_id, send_status, message_type, parent_tool_use_id, COALESCE(has_tool_result, 0), timestamp, id, sdk_uuid',
    "message_type = 'user' AND send_status = 'consumed' AND parent_tool_use_id IS NULL AND sdk_uuid IS NOT NULL AND COALESCE(has_tool_result, 0) = 0",
  ],
  [
    'task_input',
    'session_id, task_id, task_input_eligible, timestamp, sdk_uuid',
    "message_type = 'user' AND consumed_seq IS NOT NULL",
  ],
  ['open_action', 'session_id, message_subtype, resolved', "message_type = 'hyperneo_action'"],
  [
    'first_block_time',
    "session_id, COALESCE(first_block_type, 'text'), timestamp, message_type, parent_tool_use_id, send_status, input_kind",
  ],
  [
    'consumed_boundary',
    'session_id, consumed_seq, sdk_uuid',
    "message_type = 'user' AND parent_tool_use_id IS NULL AND COALESCE(send_status, 'consumed') = 'consumed' AND COALESCE(is_replay, 0) = 0 AND COALESCE(internal_compaction_turn, 0) = 0 AND COALESCE(first_block_type, 'text') <> 'tool_result'",
  ],
  [
    'result_boundary',
    'session_id, consumed_seq',
    "message_type = 'result' AND is_terminal = 1 AND parent_tool_use_id IS NULL",
  ],
  [
    'start_receipt',
    'task_id, message_type, parent_tool_use_id, timestamp, seq, session_id, sdk_uuid',
    "message_type = 'user' AND parent_tool_use_id IS NULL AND sdk_uuid IS NOT NULL AND info_level IS NOT NULL AND COALESCE(is_replay, 0) = 0 AND COALESCE(internal_compaction_turn, 0) = 0 AND COALESCE(first_block_type, 'text') <> 'tool_result'",
  ],
  [
    'result_time',
    'session_id, message_type, parent_tool_use_id, timestamp',
    "message_type = 'result' AND parent_tool_use_id IS NULL AND COALESCE(internal_compaction_turn, 0) = 0",
  ],
  [
    'exchange_time',
    'session_id, timestamp, seq',
    "parent_tool_use_id IS NULL AND COALESCE(internal_compaction_turn, 0) = 0 AND (message_type = 'result' OR (message_type = 'user' AND COALESCE(send_status, 'consumed') = 'consumed' AND COALESCE(first_block_type, 'text') <> 'tool_result'))",
  ],
  ['bg_task_time', 'session_id, message_subtype_norm, bg_task_id, timestamp'],
  ['bg_tool_time', 'session_id, message_subtype_norm, bg_tool_use_id, timestamp'],
];

export function createSdkMessageFilterIndexes(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sdk_messages' AND type = 'table'").get()
  )
    return;
  for (const [name, columns, predicate] of indexes)
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_${name} ON sdk_messages (${columns})${predicate ? ` WHERE ${predicate}` : ''}`
    );
}
