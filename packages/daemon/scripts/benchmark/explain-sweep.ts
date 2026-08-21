import { Database } from 'bun:sqlite';
import {
  BACKGROUND_TASK_METADATA_SQL,
  NAMED_QUERY_REGISTRY,
} from '../../src/lib/rpc-handlers/live-query-handlers';

const DB_PATH = process.env.BENCH_DB_PATH ?? '/tmp/hyperneo-bench/daemon-clone.db';

const db = new Database(DB_PATH);
db.exec('PRAGMA query_only = ON');
db.exec('PRAGMA busy_timeout = 10000');

function getSql(name: string): string {
  const q = NAMED_QUERY_REGISTRY.get(name);
  if (!q) throw new Error(`query ${name} not found`);
  return q.sql;
}

const largeSession =
  'coder:04062505-780f-4881-a3be-9cb9062790fb:3abb5921-557f-43a9-91ce-fd3366294b11:9317e2ff';
const smallSession = '3a4a1989-7093-4b8e-bb18-0248d528a9dd';
const taskId = '510825ad-25a6-4614-a298-d8c31a2495a3';
const spaceId = '4631f3ce-18c0-4279-9ffa-af3e917ad7b4';

const USER_STATUS_MESSAGE_SQL = `message_type = 'user'
  AND json_valid(sdk_message)
  AND json_extract(sdk_message, '$.type') = 'user'
  AND (
    json_type(sdk_message, '$.isReplay') IS NULL
    OR json_type(sdk_message, '$.isReplay') = 'false'
  )`;

const STATUS_COUNT_SQL = `SELECT COUNT(*) AS count FROM sdk_messages
  WHERE session_id = ? AND send_status = ?`;

const STATUS_USER_COUNT_SQL = `SELECT COUNT(*) AS count FROM sdk_messages
  WHERE session_id = ? AND send_status = ? AND ${USER_STATUS_MESSAGE_SQL}`;

const STATUS_USER_PROJECT_SQL = `SELECT rowid AS row_id FROM sdk_messages
  WHERE session_id = ? AND send_status = ? AND ${USER_STATUS_MESSAGE_SQL}
  ORDER BY timestamp ASC, rowid ASC
  LIMIT ?`;

const STATUS_USER_HYDRATE_SQL = `SELECT rowid AS row_id, id, sdk_message, timestamp FROM sdk_messages
  WHERE rowid IN (?, ?, ?, ?, ?)`;

const EXCLUDED_FROM_PAGINATION_SQL_LIST = (
  [
    'session_state_changed',
    'commands_changed',
    'task_started',
    'task_progress',
    'task_updated',
    'mirror_error',
    'elicitation_complete',
    'background_tasks_changed',
    'control_request_progress',
    'thinking_tokens',
  ] as string[]
)
  .map((s) => `'${s.replace(/'/g, "''")}'`)
  .join(', ');

const MESSAGES_BY_STATUS_SQL = `SELECT id, sdk_message, timestamp FROM sdk_messages
  WHERE session_id = ? AND send_status = ?
  ORDER BY timestamp ASC, rowid ASC`;

const RENDERABLE_TEXT_MESSAGES_SQL = `SELECT id, message_type, sdk_message, timestamp FROM sdk_messages
  WHERE session_id = ?
    AND parent_tool_use_id IS NULL
    AND is_renderable = 1
    AND message_type IN ('user', 'assistant')
    AND NOT EXISTS (
      SELECT 1
      FROM sdk_message_replacements replacement
      WHERE replacement.session_id = sdk_messages.session_id
        AND replacement.target_uuid = COALESCE(sdk_messages.sdk_uuid, sdk_messages.id)
    )
    AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ? OFFSET ?`;

const RECOMPUTE_VISIBLE_COUNT_SQL = `SELECT COUNT(*) AS n FROM sdk_messages
  WHERE session_id = ?
    AND parent_tool_use_id IS NULL
    AND (message_type != 'user'
         OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
    AND message_subtype_norm NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})`;

const queries: Array<{ name: string; sql: string; params: unknown[] }> = [
  {
    name: 'messages.bySession large',
    sql: getSql('messages.bySession'),
    params: [largeSession, 200],
  },
  {
    name: 'messages.bySession small',
    sql: getSql('messages.bySession'),
    params: [smallSession, 200],
  },
  { name: 'sessions.list', sql: getSql('sessions.list'), params: [0] },
  { name: 'spaceSessions.bySpace', sql: getSql('spaceSessions.bySpace'), params: [spaceId] },
  { name: 'actorMessages.byTask', sql: getSql('actorMessages.byTask'), params: [taskId] },
  { name: 'spaceTaskMessages.byTask', sql: getSql('spaceTaskMessages.byTask'), params: [taskId] },
  {
    name: 'spaceTaskMessages.byTask.compact',
    sql: getSql('spaceTaskMessages.byTask.compact'),
    params: [taskId],
  },
  { name: 'taskMilestones.byTask', sql: getSql('taskMilestones.byTask'), params: [taskId] },
  { name: 'spaceTaskActivity.byTask', sql: getSql('spaceTaskActivity.byTask'), params: [taskId] },
  {
    name: 'backgroundTaskMetadata',
    sql: BACKGROUND_TASK_METADATA_SQL,
    params: [smallSession, smallSession, smallSession, smallSession, smallSession],
  },
  { name: 'status.count', sql: STATUS_COUNT_SQL, params: [largeSession, 'consumed'] },
  { name: 'status.userCount', sql: STATUS_USER_COUNT_SQL, params: [largeSession, 'consumed'] },
  {
    name: 'status.userProject',
    sql: STATUS_USER_PROJECT_SQL,
    params: [largeSession, 'consumed', 20],
  },
  { name: 'status.userHydrate', sql: STATUS_USER_HYDRATE_SQL, params: [1, 2, 3, 4, 5] },
  { name: 'messages.byStatus', sql: MESSAGES_BY_STATUS_SQL, params: [largeSession, 'consumed'] },
  {
    name: 'renderableTextMessages',
    sql: RENDERABLE_TEXT_MESSAGES_SQL,
    params: [largeSession, 20, 0],
  },
  { name: 'recomputeVisibleCount', sql: RECOMPUTE_VISIBLE_COUNT_SQL, params: [largeSession] },
];

for (const { name, sql, params } of queries) {
  console.log(`=== ${name} ===`);
  try {
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    const rows = stmt.all(...params);
    for (const row of rows) {
      console.log(JSON.stringify(row));
    }
  } catch (err) {
    console.log('ERROR:', err instanceof Error ? err.message : String(err));
  }
  console.log();
}
