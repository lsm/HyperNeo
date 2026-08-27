import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';

import { Database as BunDatabase } from 'bun:sqlite';
import {
  BACKGROUND_TASK_METADATA_SQL,
  NAMED_QUERY_REGISTRY,
} from '../../src/lib/rpc-handlers/live-query-handlers';
import { createTables } from '../../src/storage/schema/index';
import { createSpaceTables } from '../../tests/unit/helpers/space-test-db';

const SEED_ROWS = 30_000;
const INSERT_ITERATIONS = 5_000;
const SAMPLES = 5;
const HOT_SESSION = 'session-hot';
const HOT_TASK = 'task-hot';
const BASE_TIME_MS = Date.UTC(2026, 0, 1);

const log = (message = ''): void => {
  process.stdout.write(`${message}\n`);
};

type Variant = 'baseline' | 'candidate';

type IndexDefinition = {
  name: string;
  ddl: string;
};

type MeasurementName =
  | 'insert'
  | 'latest-page'
  | 'status-page'
  | 'uuid-lookup'
  | 'task-sessions'
  | 'task-session-exists'
  | 'task-session-max-turn';

type Measurement = {
  nsPerOp: number;
  checksum: number;
};

type Sample = {
  measurements: Record<MeasurementName, Measurement>;
  plans: Record<string, string[]>;
};

type PlanDefinition = {
  name: string;
  sql: string;
  params: readonly unknown[];
};

const INDEXES: readonly IndexDefinition[] = [
  {
    name: 'idx_sdk_messages_session_uuid',
    ddl: 'idx_sdk_messages_session_uuid(session_id, sdk_uuid)',
  },
  {
    name: 'idx_sdk_messages_unnormalized_replacements',
    ddl: 'idx_sdk_messages_unnormalized_replacements(id) WHERE replacement_metadata_normalized = 0',
  },
  {
    name: 'idx_sdk_messages_session_timestamp_id',
    ddl: 'idx_sdk_messages_session_timestamp_id(session_id, timestamp DESC, id DESC)',
  },
  {
    name: 'idx_sdk_messages_parent_tool_use_id',
    ddl: 'idx_sdk_messages_parent_tool_use_id(session_id, parent_tool_use_id)',
  },
  {
    name: 'idx_sdk_messages_renderable_terminal',
    ddl: 'idx_sdk_messages_renderable_terminal(session_id, is_renderable, is_terminal, timestamp, id)',
  },
  {
    name: 'idx_sdk_messages_session_subtype_parent',
    ddl: 'idx_sdk_messages_session_subtype_parent(session_id, message_subtype_norm, parent_tool_use_id)',
  },
  {
    name: 'idx_sdk_messages_send_status_timestamp',
    ddl: 'idx_sdk_messages_send_status_timestamp(session_id, send_status, timestamp)',
  },
  {
    name: 'idx_sdk_messages_task_id',
    ddl: 'idx_sdk_messages_task_id(task_id, timestamp)',
  },
  {
    name: 'idx_sdk_messages_task_session',
    ddl: 'idx_sdk_messages_task_session(task_id, session_id)',
  },
  {
    name: 'idx_sdk_messages_task_turn',
    ddl: 'idx_sdk_messages_task_turn(task_id, conversation_turn_index)',
  },
  {
    name: 'idx_sdk_messages_task_session_turn',
    ddl: 'idx_sdk_messages_task_session_turn(task_id, session_id, conversation_turn_index)',
  },
];

const INSERT_SQL = `INSERT INTO sdk_messages (
  id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin,
  is_renderable, is_terminal, conversation_turn_index, parent_tool_use_id, task_id, sdk_uuid,
  consumed_seq, replacement_metadata_normalized
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;

const LATEST_PAGE_SQL = `SELECT id, sdk_message, timestamp, send_status, origin, rowid
FROM sdk_messages
WHERE session_id = ?
  AND parent_tool_use_id IS NULL
  AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
  AND message_subtype_norm NOT IN ('thinking_tokens', 'task_progress')
ORDER BY timestamp DESC, rowid DESC
LIMIT ?`;

const STATUS_PAGE_SQL = `SELECT rowid AS row_id
FROM sdk_messages
WHERE session_id = ?
  AND send_status = ?
  AND message_type = 'user'
  AND json_valid(sdk_message)
  AND json_extract(sdk_message, '$.type') = 'user'
ORDER BY timestamp ASC, rowid ASC
LIMIT ?`;

const UUID_LOOKUP_SQL = `SELECT id, sdk_message, timestamp
FROM sdk_messages
WHERE session_id = ? AND sdk_uuid = ?
LIMIT 1`;

const TASK_SESSIONS_SQL = `SELECT DISTINCT session_id
FROM sdk_messages
WHERE task_id = ?`;

const TASK_SESSION_EXISTS_SQL = `SELECT 1
FROM sdk_messages
WHERE task_id = ? AND session_id = ?
LIMIT 1`;

const TASK_SESSION_MAX_TURN_SQL = `SELECT MAX(conversation_turn_index) AS m
FROM sdk_messages
WHERE task_id = ? AND session_id = ?`;

function namedQuery(name: string, params: readonly unknown[]): PlanDefinition {
  const query = NAMED_QUERY_REGISTRY.get(name);
  if (!query) throw new Error(`Named query ${name} is not registered`);
  return { name: `live.${name}`, sql: query.sql, params };
}

function buildPlanDefinitions(): PlanDefinition[] {
  const definitions: PlanDefinition[] = [
    {
      name: 'write.insert-values',
      sql: INSERT_SQL,
      params: rowParams(SEED_ROWS + INSERT_ITERATIONS + 1),
    },
    {
      name: 'point.id-read',
      sql: 'SELECT sdk_message, send_status FROM sdk_messages WHERE id = ?',
      params: ['msg-1'],
    },
    {
      name: 'point.id-exists',
      sql: 'SELECT 1 FROM sdk_messages WHERE id = ? LIMIT 1',
      params: ['msg-1'],
    },
    {
      name: 'point.id-update',
      sql: 'UPDATE sdk_messages SET consumed_seq = ? WHERE id = ?',
      params: [1, 'msg-1'],
    },
    {
      name: 'point.id-list',
      sql: 'SELECT id, task_id FROM sdk_messages WHERE id IN (?, ?, ?)',
      params: ['msg-1', 'msg-2', 'msg-3'],
    },
    {
      name: 'turn.task-max',
      sql: 'SELECT MAX(conversation_turn_index) FROM sdk_messages WHERE task_id = ?',
      params: [HOT_TASK],
    },
    {
      name: 'turn.task-session-max',
      sql: TASK_SESSION_MAX_TURN_SQL,
      params: [HOT_TASK, HOT_SESSION],
    },
    {
      name: 'session.renderable-page',
      sql: `SELECT id, message_type, sdk_message, timestamp FROM sdk_messages
        WHERE session_id = ? AND parent_tool_use_id IS NULL AND is_renderable = 1
          AND message_type IN ('user', 'assistant')
          AND NOT EXISTS (
            SELECT 1 FROM sdk_message_replacements replacement
            WHERE replacement.session_id = sdk_messages.session_id
              AND replacement.target_uuid = COALESCE(sdk_messages.sdk_uuid, sdk_messages.id)
          )
          AND (message_type != 'user' OR send_status IN ('consumed', 'failed'))
        ORDER BY timestamp DESC, rowid DESC LIMIT ? OFFSET ?`,
      params: [HOT_SESSION, 20, 0],
    },
    {
      name: 'session.latest-page',
      sql: LATEST_PAGE_SQL,
      params: [HOT_SESSION, 200],
    },
    {
      name: 'session.before-rowid-page',
      sql: `${LATEST_PAGE_SQL.replace('ORDER BY', 'AND (timestamp < ? OR (timestamp = ? AND rowid < ?))\nORDER BY')}`,
      params: [
        HOT_SESSION,
        new Date(BASE_TIME_MS + 20_000).toISOString(),
        new Date(BASE_TIME_MS + 20_000).toISOString(),
        20_000,
        200,
      ],
    },
    {
      name: 'session.since-timestamp-page',
      sql: `${LATEST_PAGE_SQL.replace('ORDER BY', 'AND timestamp >= ?\nORDER BY')}`,
      params: [HOT_SESSION, new Date(BASE_TIME_MS + 10_000).toISOString(), 200],
    },
    {
      name: 'session.child-hydration',
      sql: `SELECT id, sdk_message, timestamp FROM sdk_messages
        WHERE session_id = ? AND parent_tool_use_id IN (?, ?, ?)
          AND message_subtype_norm != 'thinking_tokens'
        ORDER BY timestamp ASC, rowid ASC`,
      params: [HOT_SESSION, 'tool-7', 'tool-14', 'tool-21'],
    },
    {
      name: 'session.by-type',
      sql: `SELECT sdk_message FROM sdk_messages
        WHERE session_id = ? AND message_type = ?
        ORDER BY timestamp ASC LIMIT ?`,
      params: [HOT_SESSION, 'user', 100],
    },
    {
      name: 'session.by-type-subtype',
      sql: `SELECT sdk_message FROM sdk_messages
        WHERE session_id = ? AND message_type = ? AND message_subtype = ?
        ORDER BY timestamp ASC LIMIT ?`,
      params: [HOT_SESSION, 'system', 'task_progress', 100],
    },
    {
      name: 'session.latest-visible',
      sql: `SELECT id, sdk_message, timestamp FROM sdk_messages
        WHERE session_id = ? AND parent_tool_use_id IS NULL
          AND message_subtype_norm NOT IN ('thinking_tokens', 'task_progress')
          AND (message_type != 'user' OR send_status IN ('consumed', 'failed'))
        ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
      params: [HOT_SESSION],
    },
    {
      name: 'session.visible-count',
      sql: `SELECT COUNT(*) FROM sdk_messages
        WHERE session_id = ? AND parent_tool_use_id IS NULL
          AND (message_type != 'user' OR send_status IN ('consumed', 'failed'))
          AND message_subtype_norm NOT IN ('thinking_tokens', 'task_progress')`,
      params: [HOT_SESSION],
    },
    {
      name: 'status.count',
      sql: 'SELECT COUNT(*) FROM sdk_messages WHERE session_id = ? AND send_status = ?',
      params: [HOT_SESSION, 'consumed'],
    },
    {
      name: 'status.page',
      sql: STATUS_PAGE_SQL,
      params: [HOT_SESSION, 'consumed', 200],
    },
    {
      name: 'status.page-unbounded',
      sql: STATUS_PAGE_SQL.replace('\nLIMIT ?', ''),
      params: [HOT_SESSION, 'consumed'],
    },
    {
      name: 'status.rowid-hydration',
      sql: 'SELECT id, sdk_message, timestamp FROM sdk_messages WHERE rowid IN (?, ?, ?)',
      params: [1, 2, 3],
    },
    {
      name: 'uuid.session-status',
      sql: `SELECT id, sdk_message, timestamp FROM sdk_messages
        WHERE session_id = ? AND send_status = ? AND sdk_uuid = ?
        ORDER BY timestamp ASC, rowid ASC LIMIT 1`,
      params: [HOT_SESSION, 'consumed', 'uuid-1'],
    },
    {
      name: 'uuid.session-type',
      sql: `SELECT sdk_message, timestamp FROM sdk_messages
        WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
        ORDER BY timestamp ASC, rowid ASC LIMIT 1`,
      params: [HOT_SESSION, 'uuid-1'],
    },
    {
      name: 'uuid.delivery-transition',
      sql: `SELECT id FROM sdk_messages
        WHERE session_id = ? AND message_type = 'user' AND sdk_uuid = ?
          AND send_status IN ('deferred', 'enqueued', 'submitted')
        ORDER BY timestamp ASC LIMIT 1`,
      params: [HOT_SESSION, 'uuid-1'],
    },
    {
      name: 'uuid.batch-job-lookup',
      sql: `SELECT sdk_uuid FROM sdk_messages
        WHERE session_id = ? AND sdk_uuid IN (?, ?, ?)
          AND send_status IN ('enqueued', 'submitted')`,
      params: [HOT_SESSION, 'uuid-1', 'uuid-2', 'uuid-3'],
    },
    {
      name: 'timestamp.range-read',
      sql: 'SELECT id, sdk_uuid FROM sdk_messages WHERE session_id = ? AND timestamp > ?',
      params: [HOT_SESSION, new Date(BASE_TIME_MS + 10_000).toISOString()],
    },
    {
      name: 'timestamp.range-delete',
      sql: 'DELETE FROM sdk_messages WHERE session_id = ? AND timestamp > ?',
      params: [HOT_SESSION, new Date(BASE_TIME_MS + 40_000).toISOString()],
    },
    {
      name: 'timestamp.assistant-after-id',
      sql: `SELECT id, sdk_message FROM sdk_messages
        WHERE session_id = ? AND message_type = 'assistant'
          AND timestamp > (SELECT timestamp FROM sdk_messages WHERE id = ?)
        ORDER BY timestamp ASC`,
      params: [HOT_SESSION, 'msg-1'],
    },
    {
      name: 'terminal.success-after-watermark',
      sql: `SELECT 1 FROM sdk_messages r
        WHERE r.session_id = ? AND r.message_type = 'result' AND r.is_terminal = 1
          AND r.message_subtype = 'success' AND r.parent_tool_use_id IS NULL
          AND r.consumed_seq IS NOT NULL AND r.consumed_seq >= (
            SELECT m.consumed_seq FROM sdk_messages m
            WHERE m.session_id = ? AND m.sdk_uuid = ?
            ORDER BY m.consumed_seq IS NULL, m.consumed_seq DESC LIMIT 1
          )
        LIMIT 1`,
      params: [HOT_SESSION, HOT_SESSION, 'uuid-1'],
    },
    {
      name: 'terminal.error-after-watermark',
      sql: `SELECT r.message_subtype FROM sdk_messages r
        WHERE r.session_id = ? AND r.message_type = 'result' AND r.is_terminal = 1
          AND r.message_subtype IS NOT NULL AND r.message_subtype != 'success'
          AND r.parent_tool_use_id IS NULL AND r.consumed_seq IS NOT NULL
          AND r.consumed_seq >= (
            SELECT m.consumed_seq FROM sdk_messages m
            WHERE m.session_id = ? AND m.sdk_uuid = ?
            ORDER BY m.consumed_seq IS NULL, m.consumed_seq DESC LIMIT 1
          )
        ORDER BY r.consumed_seq DESC LIMIT 1`,
      params: [HOT_SESSION, HOT_SESSION, 'uuid-1'],
    },
    {
      name: 'task.sessions-distinct',
      sql: TASK_SESSIONS_SQL,
      params: [HOT_TASK],
    },
    {
      name: 'task.session-exists',
      sql: TASK_SESSION_EXISTS_SQL,
      params: [HOT_TASK, HOT_SESSION],
    },
    {
      name: 'task.timeline-bounded',
      sql: `SELECT * FROM (
        SELECT id, session_id, sdk_message, timestamp FROM sdk_messages
        WHERE task_id = ? AND parent_tool_use_id IS NULL
        ORDER BY timestamp DESC, id DESC LIMIT 1000
      ) ORDER BY timestamp ASC, id ASC`,
      params: [HOT_TASK],
    },
    {
      name: 'task.pending-search-cleanup',
      sql: 'SELECT id FROM sdk_messages WHERE task_id = ?',
      params: [HOT_TASK],
    },
    {
      name: 'replacement.unnormalized',
      sql: `SELECT id, sdk_message FROM sdk_messages
        WHERE replacement_metadata_normalized = 0 ORDER BY id`,
      params: [],
    },
    {
      name: 'search.session-rebuild',
      sql: `SELECT sm.id FROM sdk_messages sm
        WHERE sm.session_id = ? AND json_valid(sm.sdk_message)
          AND sm.message_type IN ('user', 'assistant')
          AND NOT EXISTS (
            SELECT 1 FROM sdk_message_replacements replacement
            WHERE replacement.session_id = sm.session_id
              AND replacement.target_uuid = COALESCE(sm.sdk_uuid, sm.id)
              AND replacement.source_message_id != sm.id
          )`,
      params: [HOT_SESSION],
    },
    {
      name: 'space.session-list-no-cursor',
      sql: `SELECT id, timestamp FROM sdk_messages
        WHERE session_id = ? AND message_subtype_norm NOT IN ('thinking_tokens')
        ORDER BY timestamp DESC, id DESC LIMIT ?`,
      params: [HOT_SESSION, 100],
    },
    {
      name: 'space.session-list-timestamp-cursor',
      sql: `SELECT id, timestamp FROM sdk_messages
        WHERE session_id = ? AND timestamp < ?
          AND message_subtype_norm NOT IN ('thinking_tokens')
        ORDER BY timestamp DESC, id DESC LIMIT ?`,
      params: [HOT_SESSION, new Date(BASE_TIME_MS + 20_000).toISOString(), 100],
    },
    {
      name: 'space.session-list-composite-cursor',
      sql: `SELECT id, timestamp FROM sdk_messages
        WHERE session_id = ? AND (timestamp < ? OR (timestamp = ? AND id < ?))
          AND message_subtype_norm NOT IN ('thinking_tokens')
        ORDER BY timestamp DESC, id DESC LIMIT ?`,
      params: [
        HOT_SESSION,
        new Date(BASE_TIME_MS + 20_000).toISOString(),
        new Date(BASE_TIME_MS + 20_000).toISOString(),
        'msg-20000',
        100,
      ],
    },
    {
      name: 'scope.workflow-task-sessions',
      sql: `SELECT DISTINCT session_id FROM sdk_messages
        WHERE task_id IN (SELECT id FROM space_tasks WHERE workflow_run_id = ?)`,
      params: ['run-hot'],
    },
    {
      name: 'migration.visible-count-backfill',
      sql: `SELECT COUNT(*) FROM sdk_messages sm
        WHERE sm.session_id = ? AND sm.parent_tool_use_id IS NULL
          AND sm.message_subtype_norm NOT IN ('thinking_tokens')`,
      params: [HOT_SESSION],
    },
    namedQuery('sessionGroupMessages.byGroup', ['group-hot']),
    namedQuery('spaceTaskActivity.byTask', [HOT_TASK]),
    namedQuery('spaceTaskMessages.byTask', [HOT_TASK]),
    namedQuery('spaceTaskMessages.byTask.compact', [HOT_TASK, 20]),
    namedQuery('spaceTaskActiveTurn.byTask', [HOT_TASK]),
    namedQuery('actorMessages.byTask', [HOT_TASK]),
    namedQuery('actorMessages.byWorkflowRun', ['run-hot', 100, 0]),
    namedQuery('taskMilestones.byTask', [HOT_TASK]),
    {
      name: 'live.backgroundTaskMetadata',
      sql: BACKGROUND_TASK_METADATA_SQL,
      params: Array.from({ length: 7 }, () => HOT_SESSION),
    },
    namedQuery('messages.bySession', [HOT_SESSION, 200]),
  ];
  return definitions;
}

function sessionIdFor(index: number): string {
  if (index < SEED_ROWS / 2) return HOT_SESSION;
  return `session-${(index % 31) + 1}`;
}

function taskIdFor(index: number): string {
  return index % 5 === 0 ? `task-${index % 8}` : HOT_TASK;
}

function messageShape(index: number): {
  type: string;
  subtype: string | null;
  isRenderable: number;
  isTerminal: number;
} {
  if (index % 29 === 0) {
    return {
      type: 'result',
      subtype: index % 58 === 0 ? 'success' : 'error',
      isRenderable: 1,
      isTerminal: 1,
    };
  }
  if (index % 11 === 0) {
    return { type: 'system', subtype: 'task_progress', isRenderable: 0, isTerminal: 0 };
  }
  if (index % 7 === 0) {
    return { type: 'system', subtype: 'task_notification', isRenderable: 1, isTerminal: 0 };
  }
  if (index % 3 === 0) {
    return { type: 'user', subtype: null, isRenderable: 1, isTerminal: 0 };
  }
  return { type: 'assistant', subtype: null, isRenderable: 1, isTerminal: 0 };
}

function rowParams(index: number): unknown[] {
  const shape = messageShape(index);
  const status = index % 19 === 0 ? 'deferred' : index % 23 === 0 ? 'failed' : 'consumed';
  const sdkUuid = `uuid-${index}`;
  const payload = JSON.stringify({
    type: shape.type,
    subtype: shape.subtype,
    uuid: sdkUuid,
    message: { content: [{ type: 'text', text: `synthetic message ${index} ${'x'.repeat(96)}` }] },
    tool_use_id: index % 11 === 0 ? `tool-${index % 97}` : undefined,
    task_id: taskIdFor(index),
    is_error: shape.subtype === 'error',
  });
  return [
    `msg-${index}`,
    sessionIdFor(index),
    shape.type,
    shape.subtype,
    payload,
    new Date(BASE_TIME_MS + Math.floor(index / 3) * 10).toISOString(),
    status,
    index % 13 === 0 ? 'system' : 'human',
    shape.isRenderable,
    shape.isTerminal,
    Math.floor(index / 8),
    index % 7 === 0 ? `tool-${index % 97}` : null,
    taskIdFor(index),
    sdkUuid,
    status === 'consumed' ? index : null,
  ];
}

const SEED_PARAMS = Array.from({ length: SEED_ROWS }, (_, index) => rowParams(index));
const INSERT_PARAMS = Array.from({ length: INSERT_ITERATIONS }, (_, index) =>
  rowParams(SEED_ROWS + index)
);
const PLAN_DEFINITIONS = buildPlanDefinitions();

function createFixture(
  variant: Variant,
  droppedIndex = 'idx_sdk_messages_task_session'
): BunDatabase {
  const db = new BunDatabase(':memory:');
  createTables(db);
  createSpaceTables(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session
    ON sdk_messages(task_id, session_id)`);
  db.exec('PRAGMA foreign_keys = OFF');
  if (variant === 'candidate') {
    db.exec(`DROP INDEX ${droppedIndex}`);
  }
  const insert = db.prepare(INSERT_SQL);
  const seed = db.transaction(() => {
    for (const params of SEED_PARAMS) insert.run(...(params as [never]));
  });
  seed();
  db.exec('ANALYZE');
  return db;
}

function queryPlans(db: BunDatabase): Record<string, string[]> {
  return Object.fromEntries(
    PLAN_DEFINITIONS.map(({ name, sql, params }) => {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [never])) as Array<{
        detail: string;
      }>;
      return [name, rows.map((row) => row.detail)];
    })
  );
}

function measure(iterations: number, run: (index: number) => number): Measurement {
  let checksum = 0;
  const start = Bun.nanoseconds();
  for (let index = 0; index < iterations; index++) checksum += run(index);
  return { nsPerOp: (Bun.nanoseconds() - start) / iterations, checksum };
}

function warm(run: (index: number) => number, iterations = 100): void {
  for (let index = 0; index < iterations; index++) run(index);
}

function collectMeasurements(variant: Variant): Record<MeasurementName, Measurement> {
  const db = createFixture(variant);
  const latestPage = db.prepare(LATEST_PAGE_SQL);
  const statusPage = db.prepare(STATUS_PAGE_SQL);
  const uuidLookup = db.prepare(UUID_LOOKUP_SQL);
  const taskSessions = db.prepare(TASK_SESSIONS_SQL);
  const taskSessionExists = db.prepare(TASK_SESSION_EXISTS_SQL);
  const taskSessionMaxTurn = db.prepare(TASK_SESSION_MAX_TURN_SQL);
  const latestRunner = (): number =>
    (latestPage.all(HOT_SESSION, 200) as Array<{ id: string }>).length;
  const statusRunner = (): number =>
    (statusPage.all(HOT_SESSION, 'consumed', 200) as Array<{ row_id: number }>).length;
  const uuidRunner = (index: number): number => {
    const row = uuidLookup.get(HOT_SESSION, `uuid-${index % (SEED_ROWS / 2)}`) as
      | { id: string }
      | undefined;
    return row?.id.length ?? 0;
  };
  const taskSessionsRunner = (): number =>
    (taskSessions.all(HOT_TASK) as Array<{ session_id: string }>).length;
  const taskSessionExistsRunner = (index: number): number =>
    taskSessionExists.get(HOT_TASK, index % 2 === 0 ? HOT_SESSION : `session-${(index % 31) + 1}`)
      ? 1
      : 0;
  const taskSessionMaxTurnRunner = (index: number): number => {
    const row = taskSessionMaxTurn.get(
      HOT_TASK,
      index % 2 === 0 ? HOT_SESSION : `session-${(index % 31) + 1}`
    ) as { m: number | null };
    return row.m ?? 0;
  };
  warm(latestRunner);
  warm(statusRunner);
  warm(uuidRunner);
  warm(taskSessionsRunner);
  warm(taskSessionExistsRunner);
  warm(taskSessionMaxTurnRunner);
  const measurements: Record<MeasurementName, Measurement> = {
    'latest-page': measure(1_000, latestRunner),
    'status-page': measure(1_000, statusRunner),
    'uuid-lookup': measure(5_000, uuidRunner),
    'task-sessions': measure(500, taskSessionsRunner),
    'task-session-exists': measure(5_000, taskSessionExistsRunner),
    'task-session-max-turn': measure(1_000, taskSessionMaxTurnRunner),
    insert: { nsPerOp: 0, checksum: 0 },
  };
  const insert = db.prepare(INSERT_SQL);
  const insertTransaction = db.transaction(() =>
    measure(INSERT_ITERATIONS, (index) => {
      const result = insert.run(...(INSERT_PARAMS[index] as [never]));
      return result.changes;
    })
  );
  measurements.insert = insertTransaction();
  db.close();
  return measurements;
}

function collectSample(variant: Variant): Sample {
  const measurements = collectMeasurements(variant);
  const planDb = createFixture(variant);
  const plans = queryPlans(planDb);
  planDb.close();
  return { measurements, plans };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function formatSamples(values: readonly number[]): string {
  return `${median(values).toFixed(1)} [${values.map((value) => value.toFixed(1)).join(', ')}]`;
}

function runChild(variant: Variant): Sample {
  const output = execFileSync(process.execPath, [import.meta.path, '--variant', variant], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output) as Sample;
}

function verifyChecksums(samples: Record<Variant, Sample[]>): void {
  for (const name of Object.keys(samples.baseline[0].measurements) as MeasurementName[]) {
    const checksums = [...samples.baseline, ...samples.candidate].map(
      (sample) => sample.measurements[name].checksum
    );
    if (!checksums.every((checksum) => checksum === checksums[0])) {
      throw new Error(`Inconsistent checksum for ${name}: ${checksums.join(', ')}`);
    }
  }
}

function summarize(samples: Record<Variant, Sample[]>): void {
  const names = Object.keys(samples.baseline[0].measurements) as MeasurementName[];
  log(
    'measurement                     baseline ns/op: median [samples]              candidate ns/op: median [samples]       delta'
  );
  for (const name of names) {
    const baseline = samples.baseline.map((sample) => sample.measurements[name].nsPerOp);
    const candidate = samples.candidate.map((sample) => sample.measurements[name].nsPerOp);
    const baselineMedian = median(baseline);
    const candidateMedian = median(candidate);
    const delta = ((candidateMedian - baselineMedian) / baselineMedian) * 100;
    log(
      `${name.padEnd(28)} ${formatSamples(baseline).padStart(44)} ${formatSamples(candidate).padStart(44)} ${`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`.padStart(9)}`
    );
  }
}

function printPlanChanges(samples: Record<Variant, Sample[]>): void {
  const baseline = samples.baseline[0].plans;
  const candidate = samples.candidate[0].plans;
  log('\nEXPLAIN QUERY PLAN changes');
  let changes = 0;
  for (const name of Object.keys(baseline)) {
    if (JSON.stringify(baseline[name]) === JSON.stringify(candidate[name])) continue;
    changes++;
    log(`\n${name}`);
    log(`  baseline:  ${baseline[name].join(' | ') || '(no read loop)'}`);
    log(`  candidate: ${candidate[name].join(' | ') || '(no read loop)'}`);
  }
  if (changes === 0) log('(none)');
}

function referencedIndexes(plans: Record<string, string[]>): Set<string> {
  const referenced = new Set<string>();
  for (const index of INDEXES) {
    if (
      Object.values(plans).some((details) => details.some((detail) => detail.includes(index.name)))
    ) {
      referenced.add(index.name);
    }
  }
  return referenced;
}

function classifyIndexes(): void {
  const baselineDb = createFixture('baseline');
  const baselinePlans = queryPlans(baselineDb);
  baselineDb.close();
  const baselineReferences = referencedIndexes(baselinePlans);
  log('index classification');
  for (const index of INDEXES) {
    const candidateDb = createFixture('candidate', index.name);
    const candidatePlans = queryPlans(candidateDb);
    candidateDb.close();
    const affected = Object.keys(baselinePlans).filter(
      (name) => JSON.stringify(baselinePlans[name]) !== JSON.stringify(candidatePlans[name])
    );
    const classification =
      index.name === 'idx_sdk_messages_task_session' ? 'redundant' : 'required';
    log(
      `${index.name}\t${classification}\treferenced=${baselineReferences.has(index.name)}\taffected=${affected.join(',') || 'none'}`
    );
  }
}

const variantFlag = process.argv.indexOf('--variant');
const variant = process.argv[variantFlag + 1] as Variant | undefined;

if (process.argv.includes('--classify')) {
  classifyIndexes();
} else if (variant === 'baseline' || variant === 'candidate') {
  process.stdout.write(JSON.stringify(collectSample(variant)));
} else {
  const samples: Record<Variant, Sample[]> = {
    baseline: Array.from({ length: SAMPLES }, () => runChild('baseline')),
    candidate: Array.from({ length: SAMPLES }, () => runChild('candidate')),
  };
  verifyChecksums(samples);
  const sqliteVersion = new BunDatabase(':memory:')
    .prepare('SELECT sqlite_version() AS version')
    .get() as { version: string };
  log(`Bun ${Bun.version}; SQLite ${sqliteVersion.version}`);
  log(`${process.platform} ${process.arch}; ${cpus()[0]?.model ?? 'unknown CPU'}`);
  log(
    `${SEED_ROWS.toLocaleString()} deterministic synthetic rows; ${SAMPLES} fresh processes per variant`
  );
  log(`baseline indexes: ${INDEXES.map((index) => index.ddl).join('; ')}`);
  log('candidate change: DROP INDEX idx_sdk_messages_task_session');
  summarize(samples);
  printPlanChanges(samples);
}
