import { statSync } from 'node:fs';
import {
  MESSAGES_BY_SESSION_SQL,
  BACKGROUND_TASK_METADATA_SQL,
} from '../../src/lib/rpc-handlers/live-query-handlers';
import {
  LIST_SPACE_WORKFLOWS_SQL,
  LIST_SPACE_WORKFLOW_NODES_SQL,
} from '../../src/storage/repositories/space-workflow-repository';
import {
  GET_ERROR_TERMINAL_RESULT_SUBTYPE_AFTER_SQL,
  HAS_RECOVERY_INTERCEPTED_RESULT_AFTER_SQL,
  HAS_TERMINAL_RESULT_AFTER_SQL,
  MESSAGE_SUPERSEDED_PROBE_SQL,
  SEARCHABLE_USER_STATUS_PROBE_SQL,
  buildMessageSearchAdmissionLookupSql,
  detectMessageSearchAdmissionFeatures,
} from '../../src/storage/repositories/sdk-message-repository';
import { buildJobQueueCandidateSelection } from '../../src/storage/repositories/job-queue-repository';
import { decideMessageSearchAdmission } from '../../src/storage/repositories/message-search-admission';
import { extractVisibleSearchText } from '../../src/storage/message-search';
import {
  createSQLiteQueryDescriptor,
  normalizeSQLiteQuery,
} from '../../src/storage/sqlite-query-normalization';
import { Database } from '../../src/storage/sqlite-compat';
import type { Database as CompatDatabase } from '../../src/storage/sqlite-compat';

export const LIVE_SCALE_QUERY_PROFILES = [
  'messages-by-session',
  'space-workflows',
  'consumed-seq-watermarks',
  'message-search-admission',
  'job-queue-candidate',
] as const;

export type LiveScaleQueryProfileName = (typeof LIVE_SCALE_QUERY_PROFILES)[number];

export interface LiveScaleQueryOptions {
  dbPath: string;
  profiles: LiveScaleQueryProfileName[];
  implicitAll: boolean;
  sessionId?: string;
  spaceId?: string;
  messageId?: string;
  messageUuid?: string;
  queue?: string;
  limit: number;
  warmup: number;
  iterations: number;
  thresholdMs: number;
  profileThresholdsMs: Partial<Record<LiveScaleQueryProfileName, number>>;
  busyTimeoutMs: number;
  json: boolean;
  noFail: boolean;
}

export type LiveScaleQueryParseResult =
  | { ok: true; options: LiveScaleQueryOptions }
  | { ok: false; error: string };

export interface LiveScaleQueryStatementReport {
  fingerprint: string;
  normalizedSql: string;
  normalizedSqlTruncated: boolean;
  plan: Array<{ id: number; parent: number; detail: string }>;
}

export interface LiveScaleQueryCaseReport {
  name: string;
  status: 'passed' | 'failed';
  thresholdMs: number;
  samplesMs: number[];
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  rowsReturned: { min: number; max: number };
  statementsPerIteration: { min: number; max: number };
  statements: LiveScaleQueryStatementReport[];
}

export interface LiveScaleQueryProfileReport {
  name: LiveScaleQueryProfileName;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  reasonCode?: string;
  cases: LiveScaleQueryCaseReport[];
}

export interface LiveScaleQueryReport {
  schemaVersion: 1;
  generatedAt: string;
  database: {
    readOnly: true;
    queryOnly: boolean;
    bytes: number;
    pageSize: number;
    pageCount: number;
    userVersion: number;
  };
  run: {
    selectedProfiles: LiveScaleQueryProfileName[];
    warmupIterations: number;
    measuredIterations: number;
    defaultThresholdMs: number;
    profileThresholdsMs: Partial<Record<LiveScaleQueryProfileName, number>>;
    limit: number;
  };
  inputs: Record<string, { source: 'override' | 'discovered' | 'missing'; resolved: boolean }>;
  profiles: LiveScaleQueryProfileReport[];
  summary: {
    passedProfiles: number;
    failedProfiles: number;
    skippedProfiles: number;
    errorProfiles: number;
    thresholdFailures: number;
    exitCode: number;
  };
}

export class LiveScaleQuerySetupError extends Error {
  constructor(
    public readonly reasonCode: string,
    message: string
  ) {
    super(message);
    this.name = 'LiveScaleQuerySetupError';
  }
}

export const LIVE_SCALE_QUERY_USAGE = `usage: bun packages/daemon/scripts/benchmark/live-scale-query-regression.ts --db <path> [flags]

Runs the daemon hot-query set against a strictly read-only database connection.
The database is opened with { readonly: true } plus PRAGMA query_only = ON and is
never written, pruned, checkpointed, or analyzed from this path.

flags:
  --db <path>                   database file (required; BENCH_DB_PATH fallback)
  --profile <name>[,<name>]     repeatable/comma-separated profile selector:
                                messages-by-session, space-workflows,
                                consumed-seq-watermarks, message-search-admission,
                                job-queue-candidate, all (default: all)
  --session-id <id>             explicit input override (bound, never printed)
  --space-id <id>               explicit input override
  --message-id <id>             explicit input override
  --message-uuid <uuid>         explicit input override
  --queue <name>                explicit input override
  --limit <n>                   window size for bounded queries (default 200)
  --warmup <n>                  warmup iterations excluded from stats (default 1)
  --iterations <n>              measured iterations per case (default 5)
  --threshold-ms <n>            p95 gate in milliseconds (default 250)
  --profile-threshold-ms <profile>=<n>
                                per-profile p95 gate override, repeatable
  --busy-timeout-ms <n>         sqlite busy timeout (default 10000)
  --json                        emit the machine report on stdout
  --no-fail                     exit 0 despite threshold regressions (report-only)
  --help                        show this help

exit codes: 0 pass, 1 threshold/input regression, 2 usage/open/verification error`;

const DISCOVERY_SESSION_SQL =
  'SELECT session_id FROM sdk_messages WHERE session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1';
const DISCOVERY_SESSION_EXISTS_SQL = 'SELECT 1 FROM sdk_messages WHERE session_id = ? LIMIT 1';
const DISCOVERY_SPACE_SQL = 'SELECT space_id FROM space_workflows ORDER BY rowid DESC LIMIT 1';
const DISCOVERY_WATERMARK_SQL =
  'SELECT session_id, sdk_uuid FROM sdk_messages WHERE consumed_seq IS NOT NULL AND sdk_uuid IS NOT NULL AND session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1';
const DISCOVERY_SESSION_FOR_UUID_SQL =
  'SELECT session_id FROM sdk_messages WHERE sdk_uuid = ? AND consumed_seq IS NOT NULL AND session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1';
const DISCOVERY_UUID_FOR_SESSION_SQL =
  'SELECT sdk_uuid FROM sdk_messages WHERE session_id = ? AND sdk_uuid IS NOT NULL AND consumed_seq IS NOT NULL ORDER BY rowid DESC LIMIT 1';
const DISCOVERY_WATERMARK_PAIR_SQL =
  'SELECT 1 FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ? AND consumed_seq IS NOT NULL LIMIT 1';
const DISCOVERY_MESSAGE_SQL =
  "SELECT id FROM sdk_messages WHERE json_valid(sdk_message) AND message_type IN ('user', 'assistant', 'system') ORDER BY CASE message_type WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END, rowid DESC LIMIT 1";
const DISCOVERY_PENDING_QUEUE_SQL =
  'SELECT queue FROM job_queue WHERE status = ? ORDER BY rowid DESC LIMIT 1';
const DISCOVERY_ANY_QUEUE_SQL = 'SELECT queue FROM job_queue ORDER BY rowid DESC LIMIT 1';

const READ_ONLY_SQL_PATTERN = /^(select|with|explain)/;

interface AnyStatement {
  all: (...args: never[]) => unknown[];
  get: (...args: never[]) => unknown;
}

interface CaseExecution {
  rows: number;
  statements: number;
}

interface CaseSpec {
  name: string;
  statements: Array<{ sql: string; params: unknown[] }>;
  run: () => CaseExecution;
}

type InputSource = 'override' | 'discovered' | 'missing';

export function assertReadOnlyQuerySql(sql: string): void {
  if (!READ_ONLY_SQL_PATTERN.test(normalizeSQLiteQuery(sql))) {
    throw new LiveScaleQuerySetupError(
      'statement-rejected',
      'live-scale harness rejected a statement that is not a read-only query'
    );
  }
}

export function summarizeSamples(samples: number[]): {
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
} {
  if (samples.length === 0) {
    return { minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    minMs: sorted[0],
    medianMs,
    p95Ms: rank(0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

function parsePositiveIntFlag(value: string, flag: string): number {
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(`${flag} expects a positive integer, received: ${value}`);
  }
  const parsed = parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, received: ${value}`);
  }
  return parsed;
}

function parseNonNegativeIntFlag(value: string, flag: string): number {
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(`${flag} expects a non-negative integer, received: ${value}`);
  }
  const parsed = parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} expects a non-negative integer, received: ${value}`);
  }
  return parsed;
}

export function parseLiveScaleQueryArgs(
  argv: string[],
  env: { BENCH_DB_PATH?: string } = {}
): LiveScaleQueryParseResult {
  const values = new Map<string, string>();
  const profilesRaw: string[] = [];
  const profileThresholds: Partial<Record<LiveScaleQueryProfileName, number>> = {};
  const flags = new Set<string>(['json', 'no-fail', 'help']);
  const valueFlags = new Set<string>([
    'db',
    'profile',
    'session-id',
    'space-id',
    'message-id',
    'message-uuid',
    'queue',
    'limit',
    'warmup',
    'iterations',
    'threshold-ms',
    'profile-threshold-ms',
    'busy-timeout-ms',
  ]);

  try {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (!arg.startsWith('--')) {
        throw new Error(`unexpected positional argument: ${arg}`);
      }
      const flag = arg.slice(2);
      if (!flags.has(flag) && !valueFlags.has(flag)) {
        throw new Error(`unknown flag: ${arg}`);
      }
      if (flags.has(flag)) {
        values.set(flag, 'true');
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} expects a value`);
      }
      i += 1;
      if (flag === 'profile') {
        profilesRaw.push(value);
        continue;
      }
      if (flag === 'profile-threshold-ms') {
        const separator = value.indexOf('=');
        if (separator <= 0) {
          throw new Error(`--profile-threshold-ms expects <profile>=<ms>, received: ${value}`);
        }
        const name = value.slice(0, separator);
        if (!(LIVE_SCALE_QUERY_PROFILES as readonly string[]).includes(name)) {
          throw new Error(`unknown profile in --profile-threshold-ms: ${name}`);
        }
        profileThresholds[name as LiveScaleQueryProfileName] = parseNonNegativeIntFlag(
          value.slice(separator + 1),
          '--profile-threshold-ms'
        );
        continue;
      }
      values.set(flag, value);
    }

    const help = values.get('help') === 'true';
    const dbPath = values.get('db') ?? env.BENCH_DB_PATH;
    if (!help && !dbPath) {
      throw new Error('--db <path> is required (or set BENCH_DB_PATH)');
    }

    const profiles: LiveScaleQueryProfileName[] = [];
    for (const chunk of profilesRaw.join(',').split(',')) {
      const name = chunk.trim();
      if (!name) continue;
      if (name === 'all') {
        profiles.push(...LIVE_SCALE_QUERY_PROFILES);
        continue;
      }
      if (!(LIVE_SCALE_QUERY_PROFILES as readonly string[]).includes(name)) {
        throw new Error(`unknown profile: ${name}`);
      }
      profiles.push(name as LiveScaleQueryProfileName);
    }
    const implicitAll = profiles.length === 0;
    if (implicitAll) {
      profiles.push(...LIVE_SCALE_QUERY_PROFILES);
    }

    return {
      ok: true,
      options: {
        dbPath: dbPath ?? '',
        profiles,
        implicitAll,
        sessionId: values.get('session-id'),
        spaceId: values.get('space-id'),
        messageId: values.get('message-id'),
        messageUuid: values.get('message-uuid'),
        queue: values.get('queue'),
        limit: values.has('limit')
          ? parsePositiveIntFlag(values.get('limit') as string, '--limit')
          : 200,
        warmup: values.has('warmup')
          ? parseNonNegativeIntFlag(values.get('warmup') as string, '--warmup')
          : 1,
        iterations: values.has('iterations')
          ? parsePositiveIntFlag(values.get('iterations') as string, '--iterations')
          : 5,
        thresholdMs: values.has('threshold-ms')
          ? parseNonNegativeIntFlag(values.get('threshold-ms') as string, '--threshold-ms')
          : 250,
        profileThresholdsMs: profileThresholds,
        busyTimeoutMs: values.has('busy-timeout-ms')
          ? parsePositiveIntFlag(values.get('busy-timeout-ms') as string, '--busy-timeout-ms')
          : 10_000,
        json: values.get('json') === 'true',
        noFail: values.get('no-fail') === 'true',
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function openLiveScaleReadOnlyDatabase(
  dbPath: string,
  busyTimeoutMs: number
): CompatDatabase {
  let db: CompatDatabase;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    throw new LiveScaleQuerySetupError(
      'database-open-failed',
      error instanceof Error ? error.message : String(error)
    );
  }
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec(`PRAGMA busy_timeout = ${Math.min(60_000, Math.max(0, Math.trunc(busyTimeoutMs)))}`);
    const flag = db.prepare('PRAGMA query_only').get() as {
      query_only?: number | string | boolean;
    } | null;
    const queryOnly =
      flag?.query_only === 1 || flag?.query_only === '1' || flag?.query_only === true;
    if (!queryOnly) {
      throw new Error('PRAGMA query_only verification did not report query_only = 1');
    }
    return db;
  } catch (error) {
    db.close();
    throw new LiveScaleQuerySetupError(
      'readonly-verification-failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}

function prepareQuery(db: CompatDatabase, sql: string): AnyStatement {
  assertReadOnlyQuerySql(sql);
  return db.prepare(sql) as unknown as AnyStatement;
}

function runGet(stmt: AnyStatement, params: unknown[]): Record<string, unknown> | null {
  const row = stmt.get(...(params as never[])) as Record<string, unknown> | null | undefined;
  return row ?? null;
}

function runAll(stmt: AnyStatement, params: unknown[]): Record<string, unknown>[] {
  return (stmt.all(...(params as never[])) ?? []) as Record<string, unknown>[];
}

interface ResolvedInput<T> {
  value: T | null;
  source: InputSource;
}

function discoverSingle(
  db: CompatDatabase,
  sql: string,
  params: unknown[],
  key: string
): string | null {
  const row = runGet(prepareQuery(db, sql), params);
  const value = row?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function rowExists(db: CompatDatabase, sql: string, params: unknown[]): boolean {
  return runGet(prepareQuery(db, sql), params) !== null;
}

function resolveMessagesSession(
  db: CompatDatabase,
  options: LiveScaleQueryOptions
): ResolvedInput<string> {
  if (options.sessionId) {
    const exists = rowExists(db, DISCOVERY_SESSION_EXISTS_SQL, [options.sessionId]);
    return { value: exists ? options.sessionId : null, source: 'override' };
  }
  return {
    value: discoverSingle(db, DISCOVERY_SESSION_SQL, [], 'session_id'),
    source: 'discovered',
  };
}

function resolveSpaceId(db: CompatDatabase, options: LiveScaleQueryOptions): ResolvedInput<string> {
  if (options.spaceId) {
    const exists = rowExists(db, 'SELECT 1 FROM space_workflows WHERE space_id = ? LIMIT 1', [
      options.spaceId,
    ]);
    return { value: exists ? options.spaceId : null, source: 'override' };
  }
  return { value: discoverSingle(db, DISCOVERY_SPACE_SQL, [], 'space_id'), source: 'discovered' };
}

function resolveWatermark(
  db: CompatDatabase,
  options: LiveScaleQueryOptions
): ResolvedInput<{ sessionId: string; sdkUuid: string }> {
  if (options.sessionId && options.messageUuid) {
    const pair = rowExists(db, DISCOVERY_WATERMARK_PAIR_SQL, [
      options.sessionId,
      options.messageUuid,
    ]);
    return {
      value: pair ? { sessionId: options.sessionId, sdkUuid: options.messageUuid } : null,
      source: 'override',
    };
  }
  if (options.messageUuid) {
    const sessionId = discoverSingle(
      db,
      DISCOVERY_SESSION_FOR_UUID_SQL,
      [options.messageUuid],
      'session_id'
    );
    return {
      value: sessionId ? { sessionId, sdkUuid: options.messageUuid } : null,
      source: 'override',
    };
  }
  if (options.sessionId) {
    const sdkUuid = discoverSingle(
      db,
      DISCOVERY_UUID_FOR_SESSION_SQL,
      [options.sessionId],
      'sdk_uuid'
    );
    return {
      value: sdkUuid ? { sessionId: options.sessionId, sdkUuid } : null,
      source: 'override',
    };
  }
  const row = runGet(prepareQuery(db, DISCOVERY_WATERMARK_SQL), []);
  const sessionId = row?.session_id;
  const sdkUuid = row?.sdk_uuid;
  return {
    value:
      typeof sessionId === 'string' && typeof sdkUuid === 'string' ? { sessionId, sdkUuid } : null,
    source: 'discovered',
  };
}

function resolveAdmissionMessage(
  db: CompatDatabase,
  options: LiveScaleQueryOptions
): ResolvedInput<string> {
  if (options.messageId) {
    const exists = rowExists(db, 'SELECT 1 FROM sdk_messages WHERE id = ? LIMIT 1', [
      options.messageId,
    ]);
    return { value: exists ? options.messageId : null, source: 'override' };
  }
  return { value: discoverSingle(db, DISCOVERY_MESSAGE_SQL, [], 'id'), source: 'discovered' };
}

function resolveQueue(db: CompatDatabase, options: LiveScaleQueryOptions): ResolvedInput<string> {
  if (options.queue) {
    const exists = rowExists(db, 'SELECT 1 FROM job_queue WHERE queue = ? LIMIT 1', [
      options.queue,
    ]);
    return { value: exists ? options.queue : null, source: 'override' };
  }
  const pending = discoverSingle(db, DISCOVERY_PENDING_QUEUE_SQL, ['pending'], 'queue');
  if (pending) return { value: pending, source: 'discovered' };
  return { value: discoverSingle(db, DISCOVERY_ANY_QUEUE_SQL, [], 'queue'), source: 'discovered' };
}

function buildMessagesBySessionCases(
  db: CompatDatabase,
  sessionId: string,
  options: LiveScaleQueryOptions
): CaseSpec[] {
  const stmtMain = prepareQuery(db, MESSAGES_BY_SESSION_SQL);
  const stmtMeta = prepareQuery(db, BACKGROUND_TASK_METADATA_SQL);
  const mainParams: unknown[] = [sessionId, options.limit];
  const metaParams: unknown[] = Array.from({ length: 7 }, () => sessionId);
  const statements = [
    { sql: MESSAGES_BY_SESSION_SQL, params: mainParams },
    { sql: BACKGROUND_TASK_METADATA_SQL, params: metaParams },
  ];
  const execute = (): CaseExecution => {
    const rows = runAll(stmtMain, mainParams);
    runAll(stmtMeta, metaParams);
    return { rows: rows.length, statements: 2 };
  };
  return [
    { name: 'snapshot', statements, run: execute },
    { name: 'delta', statements, run: execute },
  ];
}

function buildSpaceWorkflowsCases(db: CompatDatabase, spaceId: string): CaseSpec[] {
  const stmtList = prepareQuery(db, LIST_SPACE_WORKFLOWS_SQL);
  const stmtNodes = prepareQuery(db, LIST_SPACE_WORKFLOW_NODES_SQL);
  return [
    {
      name: 'list-workflows-n-plus-1-nodes',
      statements: [
        { sql: LIST_SPACE_WORKFLOWS_SQL, params: [spaceId] },
        { sql: LIST_SPACE_WORKFLOW_NODES_SQL, params: ['workflow-id-bound-per-returned-row'] },
      ],
      run: () => {
        const workflows = runAll(stmtList, [spaceId]);
        let rows = workflows.length;
        for (const workflow of workflows) {
          const id = workflow.id;
          rows += runAll(stmtNodes, [typeof id === 'string' ? id : String(id ?? '')]).length;
        }
        return { rows, statements: 1 + workflows.length };
      },
    },
  ];
}

function buildWatermarkCases(db: CompatDatabase, sessionId: string, sdkUuid: string): CaseSpec[] {
  const params: unknown[] = [sessionId, sessionId, sdkUuid];
  const definitions = [
    { name: 'terminal-success-result-after', sql: HAS_TERMINAL_RESULT_AFTER_SQL },
    { name: 'recovery-intercepted-result-after', sql: HAS_RECOVERY_INTERCEPTED_RESULT_AFTER_SQL },
    { name: 'error-terminal-subtype-after', sql: GET_ERROR_TERMINAL_RESULT_SUBTYPE_AFTER_SQL },
  ];
  return definitions.map(({ name, sql }) => {
    const stmt = prepareQuery(db, sql);
    return {
      name,
      statements: [{ sql, params }],
      run: (): CaseExecution => ({ rows: runGet(stmt, params) === null ? 0 : 1, statements: 1 }),
    };
  });
}

function buildAdmissionCases(db: CompatDatabase, messageId: string): CaseSpec[] {
  const lookupSql = buildMessageSearchAdmissionLookupSql(detectMessageSearchAdmissionFeatures(db));
  const stmtLookup = prepareQuery(db, lookupSql);
  const stmtSuperseded = prepareQuery(db, MESSAGE_SUPERSEDED_PROBE_SQL);
  const stmtStatus = prepareQuery(db, SEARCHABLE_USER_STATUS_PROBE_SQL);
  let executedStatements = 0;
  return [
    {
      name: 'admission-lookup-and-policy',
      statements: [
        { sql: lookupSql, params: [messageId] },
        {
          sql: MESSAGE_SUPERSEDED_PROBE_SQL,
          params: ['session-id-bound', 'row-id-bound', 'uuid-bound'],
        },
        { sql: SEARCHABLE_USER_STATUS_PROBE_SQL, params: ['row-id-bound'] },
      ],
      run: (): CaseExecution => {
        executedStatements = 1;
        const row = runGet(stmtLookup, [messageId]);
        if (!row) return { rows: 0, statements: executedStatements };
        let message: unknown = null;
        try {
          message = JSON.parse(String(row.sdk_message));
        } catch {
          return { rows: 1, statements: executedStatements };
        }
        const uuid =
          message && typeof message === 'object' && 'uuid' in message
            ? String((message as { uuid?: unknown }).uuid ?? '')
            : '';
        decideMessageSearchAdmission({
          messageType: String(row.message_type ?? ''),
          body: extractVisibleSearchText(message as never),
          now: Date.now(),
          eligibility: row as never,
          isSuperseded: () => {
            executedStatements += 1;
            return runGet(stmtSuperseded, [row.session_id, row.id, uuid]) !== null;
          },
          isSearchableUserStatus: () => {
            executedStatements += 1;
            const statusRow = runGet(stmtStatus, [row.id]);
            return statusRow?.send_status === 'consumed' || statusRow?.send_status === 'failed';
          },
        });
        return { rows: 1, statements: executedStatements };
      },
    },
  ];
}

function buildJobQueueCandidateCases(
  db: CompatDatabase,
  queue: string,
  options: LiveScaleQueryOptions
): CaseSpec[] {
  const selection = buildJobQueueCandidateSelection({
    queue,
    now: Date.now(),
    limit: Math.min(options.limit, 100),
  });
  const stmt = prepareQuery(db, selection.sql);
  return [
    {
      name: 'dequeue-candidate-select',
      statements: [{ sql: selection.sql, params: selection.params }],
      run: (): CaseExecution => ({
        rows: runAll(stmt, selection.params).length,
        statements: 1,
      }),
    },
  ];
}

function captureCaseStatements(
  db: CompatDatabase,
  statements: Array<{ sql: string; params: unknown[] }>
): LiveScaleQueryStatementReport[] {
  const bySql = new Map<string, { sql: string; params: unknown[] }>();
  for (const statement of statements) {
    if (!bySql.has(statement.sql)) bySql.set(statement.sql, statement);
  }
  return [...bySql.values()].map(({ sql, params }) => {
    const explainSql = `EXPLAIN QUERY PLAN ${sql}`;
    const rows = runAll(prepareQuery(db, explainSql), params) as Array<{
      id: number;
      parent: number;
      detail: string;
    }>;
    const descriptor = createSQLiteQueryDescriptor(sql);
    return {
      fingerprint: descriptor.fingerprint,
      normalizedSql: descriptor.normalizedSql,
      normalizedSqlTruncated: descriptor.normalizedSqlTruncated,
      plan: rows.map((row) => ({
        id: Number(row.id),
        parent: Number(row.parent),
        detail: String(row.detail),
      })),
    };
  });
}

function measureCase(
  db: CompatDatabase,
  spec: CaseSpec,
  options: LiveScaleQueryOptions,
  thresholdMs: number
): LiveScaleQueryCaseReport {
  for (let i = 0; i < options.warmup; i += 1) {
    spec.run();
  }
  const samplesMs: number[] = [];
  let rowsMin = Number.POSITIVE_INFINITY;
  let rowsMax = Number.NEGATIVE_INFINITY;
  let statementsMin = Number.POSITIVE_INFINITY;
  let statementsMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < options.iterations; i += 1) {
    const startedAt = performance.now();
    const execution = spec.run();
    samplesMs.push(performance.now() - startedAt);
    rowsMin = Math.min(rowsMin, execution.rows);
    rowsMax = Math.max(rowsMax, execution.rows);
    statementsMin = Math.min(statementsMin, execution.statements);
    statementsMax = Math.max(statementsMax, execution.statements);
  }
  const stats = summarizeSamples(samplesMs);
  return {
    name: spec.name,
    status: stats.p95Ms > thresholdMs ? 'failed' : 'passed',
    thresholdMs,
    samplesMs: samplesMs.map((sample) => Math.round(sample * 1000) / 1000),
    minMs: stats.minMs,
    medianMs: stats.medianMs,
    p95Ms: stats.p95Ms,
    maxMs: stats.maxMs,
    rowsReturned: { min: rowsMin, max: rowsMax },
    statementsPerIteration: { min: statementsMin, max: statementsMax },
    statements: captureCaseStatements(db, spec.statements),
  };
}

export function runLiveScaleQueryRegression(options: LiveScaleQueryOptions): {
  report: LiveScaleQueryReport;
  exitCode: number;
} {
  const db = openLiveScaleReadOnlyDatabase(options.dbPath, options.busyTimeoutMs);
  try {
    const inputs: Record<string, { source: InputSource; resolved: boolean }> = {};
    const profiles: LiveScaleQueryProfileReport[] = [];
    let thresholdFailures = 0;

    const runProfile = <T>(
      name: LiveScaleQueryProfileName,
      resolve: () => ResolvedInput<T>,
      buildCases: (value: T) => CaseSpec[]
    ): void => {
      try {
        const resolved = resolve();
        inputs[name] = { source: resolved.source, resolved: resolved.value !== null };
        if (resolved.value === null) {
          profiles.push({
            name,
            status: options.implicitAll ? 'skipped' : 'failed',
            reasonCode: 'input-missing',
            cases: [],
          });
          return;
        }
        const thresholdMs = options.profileThresholdsMs[name] ?? options.thresholdMs;
        const cases = buildCases(resolved.value).map((spec) =>
          measureCase(db, spec, options, thresholdMs)
        );
        thresholdFailures += cases.filter((caseReport) => caseReport.status === 'failed').length;
        profiles.push({
          name,
          status: cases.some((caseReport) => caseReport.status === 'failed') ? 'failed' : 'passed',
          cases,
        });
      } catch (error) {
        profiles.push({
          name,
          status: 'error',
          reasonCode: 'execution-failed',
          cases: [],
        });
        if (!inputs[name]) inputs[name] = { source: 'missing', resolved: false };
        console.error(`live-scale-query-regression: profile ${name} failed:`, error);
      }
    };

    const selectedProfileNames = new Set<LiveScaleQueryProfileName>(options.profiles);
    if (selectedProfileNames.has('messages-by-session')) {
      runProfile(
        'messages-by-session',
        () => resolveMessagesSession(db, options),
        (sessionId) => buildMessagesBySessionCases(db, sessionId, options)
      );
    }
    if (selectedProfileNames.has('space-workflows')) {
      runProfile(
        'space-workflows',
        () => resolveSpaceId(db, options),
        (spaceId) => buildSpaceWorkflowsCases(db, spaceId)
      );
    }
    if (selectedProfileNames.has('consumed-seq-watermarks')) {
      runProfile(
        'consumed-seq-watermarks',
        () => resolveWatermark(db, options),
        (value) => buildWatermarkCases(db, value.sessionId, value.sdkUuid)
      );
    }
    if (selectedProfileNames.has('message-search-admission')) {
      runProfile(
        'message-search-admission',
        () => resolveAdmissionMessage(db, options),
        (messageId) => buildAdmissionCases(db, messageId)
      );
    }
    if (selectedProfileNames.has('job-queue-candidate')) {
      runProfile(
        'job-queue-candidate',
        () => resolveQueue(db, options),
        (queue) => buildJobQueueCandidateCases(db, queue, options)
      );
    }

    const selectedProfiles = options.profiles;
    const executedProfiles = profiles.filter(
      (profile) => profile.cases.length > 0 || profile.status === 'failed'
    );
    const errorProfiles = profiles.filter((profile) => profile.status === 'error').length;
    const failedProfiles = profiles.filter((profile) => profile.status === 'failed').length;
    const skippedProfiles = profiles.filter((profile) => profile.status === 'skipped').length;
    const passedProfiles = profiles.filter((profile) => profile.status === 'passed').length;

    let exitCode = 0;
    if (errorProfiles > 0) {
      exitCode = 2;
    } else if (failedProfiles > 0 || thresholdFailures > 0 || executedProfiles.length === 0) {
      exitCode = options.noFail ? 0 : 1;
    }

    const pragmaValue = (sql: string, key: string): number => {
      const row = runGet(db.prepare(sql) as unknown as AnyStatement, []);
      const value = row?.[key];
      return typeof value === 'number' ? value : Number(value ?? 0) || 0;
    };
    const pageSize = pragmaValue('PRAGMA page_size', 'page_size');
    const pageCount = pragmaValue('PRAGMA page_count', 'page_count');
    const userVersion = pragmaValue('PRAGMA user_version', 'user_version');
    let bytes = 0;
    try {
      bytes = statSync(options.dbPath).size;
    } catch {
      bytes = 0;
    }

    const report: LiveScaleQueryReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      database: {
        readOnly: true,
        queryOnly: true,
        bytes,
        pageSize,
        pageCount,
        userVersion,
      },
      run: {
        selectedProfiles,
        warmupIterations: options.warmup,
        measuredIterations: options.iterations,
        defaultThresholdMs: options.thresholdMs,
        profileThresholdsMs: options.profileThresholdsMs,
        limit: options.limit,
      },
      inputs,
      profiles,
      summary: {
        passedProfiles,
        failedProfiles,
        skippedProfiles,
        errorProfiles,
        thresholdFailures,
        exitCode,
      },
    };
    return { report, exitCode };
  } finally {
    db.close();
  }
}

function formatMs(value: number): string {
  return `${Math.round(value * 1000) / 1000}`;
}

export function renderLiveScaleQueryReportText(report: LiveScaleQueryReport): string {
  const lines: string[] = [];
  lines.push('live-scale query regression');
  lines.push(
    `database: readOnly=${report.database.readOnly} queryOnly=${report.database.queryOnly} bytes=${report.database.bytes} pages=${report.database.pageCount}x${report.database.pageSize} userVersion=${report.database.userVersion}`
  );
  lines.push(
    `run: warmup=${report.run.warmupIterations} iterations=${report.run.measuredIterations} defaultThresholdMs=${report.run.defaultThresholdMs} limit=${report.run.limit}`
  );
  for (const [name, input] of Object.entries(report.inputs)) {
    lines.push(`input ${name}: source=${input.source} resolved=${input.resolved}`);
  }
  for (const profile of report.profiles) {
    lines.push('');
    lines.push(
      `profile ${profile.name}: ${profile.status}${profile.reasonCode ? ` (${profile.reasonCode})` : ''}`
    );
    for (const caseReport of profile.cases) {
      lines.push(
        `  case ${caseReport.name}: ${caseReport.status} threshold=${caseReport.thresholdMs}ms median=${formatMs(caseReport.medianMs)}ms p95=${formatMs(caseReport.p95Ms)}ms max=${formatMs(caseReport.maxMs)}ms rows=${caseReport.rowsReturned.min}-${caseReport.rowsReturned.max} statements=${caseReport.statementsPerIteration.min}-${caseReport.statementsPerIteration.max}`
      );
      for (const statement of caseReport.statements) {
        const preview = statement.normalizedSql.slice(0, 120);
        lines.push(
          `    fingerprint=${statement.fingerprint}${statement.normalizedSqlTruncated ? ' (truncated)' : ''}`
        );
        lines.push(`    sql=${preview}${statement.normalizedSql.length > 120 ? '…' : ''}`);
        for (const step of statement.plan) {
          lines.push(`    plan ${step.id}/${step.parent}: ${step.detail}`);
        }
      }
    }
  }
  lines.push('');
  const summary = report.summary;
  lines.push(
    `summary: passed=${summary.passedProfiles} failed=${summary.failedProfiles} skipped=${summary.skippedProfiles} error=${summary.errorProfiles} thresholdFailures=${summary.thresholdFailures} exitCode=${summary.exitCode}`
  );
  return lines.join('\n');
}

export function runLiveScaleQueryCli(
  argv: string[],
  env: { BENCH_DB_PATH?: string } = {},
  sinks: { out?: { write: (chunk: string) => void }; err?: { write: (chunk: string) => void } } = {}
): number {
  const out = sinks.out ?? process.stdout;
  const err = sinks.err ?? process.stderr;
  if (argv.includes('--help')) {
    out.write(`${LIVE_SCALE_QUERY_USAGE}\n`);
    return 0;
  }
  const parsed = parseLiveScaleQueryArgs(argv, env);
  if (!parsed.ok) {
    err.write(`live-scale-query-regression: ${parsed.error}\n\n${LIVE_SCALE_QUERY_USAGE}\n`);
    return 2;
  }
  try {
    const { report, exitCode } = runLiveScaleQueryRegression(parsed.options);
    out.write(
      parsed.options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${renderLiveScaleQueryReportText(report)}\n`
    );
    return exitCode;
  } catch (error) {
    if (error instanceof LiveScaleQuerySetupError) {
      err.write(`live-scale-query-regression: ${error.reasonCode}: ${error.message}\n`);
      return 2;
    }
    err.write(
      `live-scale-query-regression: unexpected-failure: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 2;
  }
}
