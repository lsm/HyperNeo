export const SESSION_BILLING_TERMINAL = `message_type='result' AND is_terminal=1 AND parent_tool_use_id IS NULL
  AND COALESCE(internal_compaction_turn,0)=0
  AND NOT (COALESCE(recovery_intercepted,0)=1 AND COALESCE(recovery_billing_terminal,0)=0)`;

export const CONSUMED_INPUT = `message_type = 'user' AND parent_tool_use_id IS NULL
  AND COALESCE(send_status, 'consumed') = 'consumed'
  AND COALESCE(is_replay, 0) = 0
  AND COALESCE(internal_compaction_turn, 0) = 0
  AND COALESCE(first_block_type, 'text') <> 'tool_result'`;
