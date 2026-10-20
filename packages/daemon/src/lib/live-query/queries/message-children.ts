import type { Database } from '../../../storage/sqlite-compat.ts';

export function expandSessionMessages(
  rows: Record<string, unknown>[],
  params: ReadonlyArray<unknown>,
  db: Database
): Record<string, unknown>[] {
  const ids = new Set<string>();
  for (const row of rows) {
    try {
      const message = JSON.parse(row.content as string);
      if (message?.type !== 'assistant' || !Array.isArray(message.message?.content)) continue;
      for (const block of message.message.content)
        if (block?.type === 'tool_use' && block.id != null)
          ids.add(
            typeof block.id === 'object'
              ? JSON.stringify(block.id)
              : String(typeof block.id === 'boolean' ? Number(block.id) : block.id)
          );
    } catch {}
  }
  const keys = [...ids];
  const children: Record<string, unknown>[] = [];
  for (let offset = 0; offset < keys.length; offset += 900) {
    const batch = keys.slice(offset, offset + 900);
    children.push(
      ...(db
        .prepare(`SELECT id, sdk_message AS content,
      CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER) AS timestamp,
      send_status AS sendStatus, origin, rowid AS rowid, message_type AS messageType, NULL AS deliveryRetryInfo
      FROM sdk_messages WHERE session_id = ? AND parent_tool_use_id IN (${batch.map(() => '?').join(',')})
      AND message_subtype_norm != 'thinking_tokens'`)
        .all(params[0], ...batch) as Record<string, unknown>[])
    );
  }
  return [...rows, ...children].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp) || Number(a.rowid) - Number(b.rowid)
  );
}
