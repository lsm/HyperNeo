import { joinedSdkMessageBody } from '../../../storage/repositories/sdk-message-body-read.ts';
import { toSqlStringList } from '../../../storage/sql-string-list.ts';
import { HIDDEN_SYSTEM_SUBTYPES } from '@hyperneo/shared/sdk/type-guards';
import type { TableChangeScope } from '../../../storage/reactive-database.ts';
import { activeDeliveryJobsCtes } from './task-delivery.ts';
import { capMessageOutput } from '../../rpc-handlers/message-output-cap.ts';
import { thinMessage } from '../../rpc-handlers/message-thinning.ts';
import { sendStatusToDeliveryStatus } from '@hyperneo/shared';

export const DEBOUNCE_SDK_MESSAGES_MS = 250;

const EXCLUDED_FROM_PAGINATION_SQL_LIST = toSqlStringList([
  ...HIDDEN_SYSTEM_SUBTYPES,
  'thinking_tokens',
]);

const BACKGROUND_TASK_METADATA_SUBTYPES = ['task_started', 'task_updated', 'task_notification'];

const BACKGROUND_TASK_METADATA_BATCH_SIZE = 300;

const BACKGROUND_TASK_METADATA_SOURCE_SUBTYPES: ReadonlySet<string> = new Set([
  ...BACKGROUND_TASK_METADATA_SUBTYPES,
  'task_progress',
]);

export function mayChangeBackgroundTaskMetadata(scope: TableChangeScope): boolean {
  if (scope.messageSubtype === undefined) return true;
  return (
    scope.messageSubtype !== null &&
    BACKGROUND_TASK_METADATA_SOURCE_SUBTYPES.has(scope.messageSubtype)
  );
}

export const MAX_MESSAGES_BY_SESSION_WINDOW = 200;

const BACKGROUND_TASK_METADATA_ARMS_SQL = BACKGROUND_TASK_METADATA_SUBTYPES.map(
  (subtype) => `SELECT * FROM (
    SELECT
      id,
      timestamp,
      send_status,
      origin,
      rowid AS rowid,
      COALESCE(bg_task_id, task_id) AS task_id
    FROM sdk_messages
    WHERE session_id = ?
      AND parent_tool_use_id IS NULL
      AND message_subtype_norm = '${subtype.replace(/'/g, "''")}'
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ${BACKGROUND_TASK_METADATA_BATCH_SIZE}
  )`
).join(`
  UNION ALL
`);

export const BACKGROUND_TASK_METADATA_SQL = `
WITH recent_metadata AS (
  SELECT * FROM (
    ${BACKGROUND_TASK_METADATA_ARMS_SQL}
  )
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ${BACKGROUND_TASK_METADATA_BATCH_SIZE}
),
recent_progress AS (
  SELECT
    id,
    timestamp,
    send_status,
    origin,
    rowid AS rowid,
    COALESCE(bg_task_id, task_id) AS task_id
  FROM sdk_messages
  WHERE session_id = ?
    AND parent_tool_use_id IS NULL
    AND message_subtype_norm = 'task_progress'
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ${BACKGROUND_TASK_METADATA_BATCH_SIZE}
),
terminal_task_ids AS MATERIALIZED (
  SELECT DISTINCT COALESCE(bg_task_id, task_id) AS task_id
  FROM sdk_messages
  WHERE session_id = ?
    AND parent_tool_use_id IS NULL
    AND message_subtype_norm = 'task_notification'
),
recent_task_ids AS (
  SELECT DISTINCT candidate.task_id
  FROM (
    SELECT task_id FROM recent_metadata
    UNION ALL
    SELECT task_id FROM recent_progress
  ) candidate
  WHERE candidate.task_id IS NOT NULL AND candidate.task_id != ''
    AND candidate.task_id NOT IN (
      SELECT task_id FROM terminal_task_ids WHERE task_id IS NOT NULL
    )
),
task_starts AS (
  SELECT
    id,
    timestamp,
    send_status,
    origin,
    rowid AS rowid,
    COALESCE(bg_task_id, task_id) AS task_id
  FROM sdk_messages
  WHERE session_id = ?
    AND parent_tool_use_id IS NULL
    AND message_subtype_norm = 'task_started'
    AND COALESCE(bg_task_id, task_id) IN (SELECT task_id FROM recent_task_ids)
    AND id NOT IN (SELECT id FROM recent_metadata)
),
latest_progress AS (
  SELECT
    id,
    timestamp,
    send_status,
    origin,
    rowid AS rowid,
    task_id
  FROM (
    SELECT
      id,
      timestamp,
      send_status,
      origin,
      rowid AS rowid,
      COALESCE(bg_task_id, task_id) AS task_id,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(
          bg_tool_use_id,
          ''
        )
        ORDER BY timestamp DESC, rowid DESC
      ) AS rn
    FROM sdk_messages
    WHERE session_id = ?
      AND parent_tool_use_id IS NULL
      AND message_subtype_norm = 'task_progress'
      AND COALESCE(
        bg_tool_use_id,
        ''
      ) != ''
      AND COALESCE(bg_task_id, task_id) IN (SELECT task_id FROM recent_task_ids)
  )
  WHERE rn = 1
)
SELECT
  metadata.id,
  ${joinedSdkMessageBody('split_body', 'original')} AS content,
  CAST((julianday(metadata.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS timestamp,
  metadata.send_status AS sendStatus,
  metadata.origin AS origin
FROM (
  SELECT * FROM recent_metadata
  UNION ALL
  SELECT * FROM task_starts
  UNION ALL
  SELECT * FROM latest_progress
) metadata
JOIN sdk_messages original ON original.rowid = metadata.rowid
LEFT JOIN sdk_message_bodies split_body ON split_body.seq = metadata.rowid
ORDER BY timestamp DESC, metadata.rowid DESC
`.trim();

export const MESSAGES_BY_SESSION_SQL = `
WITH latest_shutdown_boundary AS MATERIALIZED (
  SELECT id
  FROM sdk_messages
  WHERE session_id = ?1
    AND parent_tool_use_id IS NULL
    AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
  ORDER BY timestamp DESC, id DESC
  LIMIT 1
),
${activeDeliveryJobsCtes(`AND json_extract(jq.payload, '$.sessionId') = ?1`)},
active_delivery_ranked AS (
  SELECT
    message_uuid,
    json_object(
      'count', retry_count,
      'runAt', run_at,
      'max', max_retries
    ) AS deliveryRetryInfo,
    ROW_NUMBER() OVER (
      PARTITION BY message_uuid
      ORDER BY retry_count DESC, job_rowid DESC
    ) AS retry_rank
  FROM active_delivery_candidates
),
active_delivery_retry AS MATERIALIZED (
  SELECT message_uuid, deliveryRetryInfo
  FROM active_delivery_ranked
  WHERE retry_rank = 1
),
top_level AS (
  SELECT
    id,
    timestamp,
    send_status,
    rowid AS rowid,
    message_type,
    active_delivery_retry.deliveryRetryInfo AS deliveryRetryInfo
  FROM sdk_messages
  LEFT JOIN active_delivery_retry ON active_delivery_retry.message_uuid = sdk_messages.sdk_uuid
  WHERE session_id = ?1
    AND parent_tool_use_id IS NULL
    -- Task #862: surface ALL user-message delivery states (deferred / enqueued
    -- / submitted / consumed / failed) so the UI can badge queued / processing
    -- / retrying explicitly instead of inferring from system/init. Daemon-side
    -- reads (SDKMessageRepository.getSDKMessages) keep the consumed/failed
    -- visibility filter, so prompt context / rewind are unaffected; only the
    -- web transcript feed widens.
    AND message_subtype_norm NOT IN (${EXCLUDED_FROM_PAGINATION_SQL_LIST})
    AND (
      message_type != 'system'
      OR message_subtype_norm != 'informational'
      OR COALESCE(info_level, 0) != 1
    )
    AND (
      message_type != 'system'
      OR message_subtype_norm != 'worker_shutting_down'
      OR id = (SELECT id FROM latest_shutdown_boundary)
    )
  -- Cap window orders by (timestamp, rowid) so a LiveQuery limit that cuts
  -- through same-millisecond hook_started/progress/response rows keeps the
  -- later phases (insertion order) instead of dropping the terminal response
  -- by random UUID.
  ORDER BY timestamp DESC, rowid DESC
  LIMIT ?2
)
SELECT
  t.id,
  ${joinedSdkMessageBody('split_body', 'body')} AS content,
  CAST((julianday(t.timestamp) - 2440587.5) * 86400000 AS INTEGER) AS timestamp,
  t.send_status AS sendStatus,
  body.origin AS origin,
  t.rowid AS rowid,
  t.message_type AS messageType,
  t.deliveryRetryInfo AS deliveryRetryInfo
FROM top_level t
JOIN sdk_messages body ON body.rowid = t.rowid
LEFT JOIN sdk_message_bodies split_body ON split_body.seq = t.rowid
ORDER BY timestamp ASC, rowid ASC
`.trim();

export function mapMessageRow(row: Record<string, unknown>): Record<string, unknown> {
  return mapMessageRowAs(row, capMessageOutput);
}

export function mapThinMessageRow(row: Record<string, unknown>): Record<string, unknown> {
  return mapMessageRowAs(row, thinMessage);
}

function mapMessageRowAs(
  row: Record<string, unknown>,
  shape: (message: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  const contentRaw = row.content;
  let parsed: Record<string, unknown> = {};
  if (typeof contentRaw === 'string') {
    try {
      parsed = JSON.parse(contentRaw) as Record<string, unknown>;
    } catch {
      parsed = { type: 'unknown', rawContent: contentRaw };
    }
  }

  const extras: Record<string, unknown> = {
    id: row.id,
    timestamp: typeof row.timestamp === 'number' ? row.timestamp : Number(row.timestamp ?? 0),
    rowid: typeof row.rowid === 'number' ? row.rowid : Number(row.rowid ?? 0),
    origin: row.origin != null ? row.origin : undefined,
  };
  if (parsed.type === 'user') {
    let retryCount = 0;
    let retryInfo: { count?: number; runAt?: number; max?: number } | null = null;
    const raw = row.deliveryRetryInfo;
    if (typeof raw === 'string' && raw.length > 0) {
      try {
        retryInfo = JSON.parse(raw) as { count?: number; runAt?: number; max?: number };
        retryCount = Number(retryInfo?.count ?? 0);
      } catch {}
    }
    const deliveryStatus = sendStatusToDeliveryStatus(row.sendStatus as string | null, {
      retrying: retryCount > 0,
    });
    if (deliveryStatus) extras.deliveryStatus = deliveryStatus;
    if (retryCount > 0 && retryInfo) {
      extras.deliveryRetry = {
        count: retryCount,
        runAt: typeof retryInfo.runAt === 'number' ? retryInfo.runAt : undefined,
        maxRetries: typeof retryInfo.max === 'number' ? retryInfo.max : undefined,
      };
    }
  }

  return { ...shape(parsed), ...extras };
}

export function messageRowFingerprint(row: Record<string, unknown>): unknown {
  return row.messageType === 'hyperneo_action'
    ? row
    : {
        content: row.content,
        timestamp: row.timestamp,
        sendStatus: row.sendStatus,
        origin: row.origin,
        rowid: row.rowid,
        deliveryRetryInfo: row.deliveryRetryInfo,
      };
}
