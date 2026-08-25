import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  LIVE_SCALE_QUERY_PROFILES,
  assertReadOnlyQuerySql,
  LiveScaleQuerySetupError,
  parseLiveScaleQueryArgs,
  runLiveScaleQueryCli,
  runLiveScaleQueryRegression,
  summarizeSamples,
} from '../../../../scripts/benchmark/live-scale-query-regression-lib';
import type { LiveScaleQueryReport } from '../../../../scripts/benchmark/live-scale-query-regression-lib';

const FIXTURE_SESSION_ID = 'fixture-session-main';
const FIXTURE_SPACE_ID = 'fixture-space-1';
const FIXTURE_SECRET = 'fixture-payload-secret';

let fixtureDir: string;
let populatedDbPath: string;
let emptyDbPath: string;

function createFixture(path: string, withRows: boolean): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE sdk_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        task_id TEXT,
        message_type TEXT,
        message_subtype TEXT,
        message_subtype_norm TEXT,
        is_terminal INTEGER,
        sdk_uuid TEXT,
        sdk_message TEXT,
        timestamp TEXT,
        send_status TEXT,
        origin TEXT,
        parent_tool_use_id TEXT,
        consumed_seq INTEGER
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        type TEXT,
        last_active_at TEXT,
        room_id TEXT
      );
      CREATE TABLE space_tasks (
        id TEXT PRIMARY KEY,
        space_id TEXT,
        task_number INTEGER,
        status TEXT,
        completed_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE job_queue (
        id TEXT PRIMARY KEY,
        queue TEXT,
        status TEXT,
        payload TEXT,
        result TEXT,
        error TEXT,
        priority INTEGER,
        max_retries INTEGER,
        retry_count INTEGER,
        run_at INTEGER,
        created_at INTEGER,
        started_at INTEGER,
        heartbeat_at INTEGER,
        completed_at INTEGER
      );
      CREATE TABLE space_workflows (
        id TEXT PRIMARY KEY,
        space_id TEXT,
        name TEXT,
        description TEXT,
        start_node_id TEXT,
        end_node_id TEXT,
        tags TEXT,
        channels TEXT,
        hooks TEXT,
        layout TEXT,
        template_name TEXT,
        template_hash TEXT,
        instructions TEXT,
        completion_autonomy_level INTEGER,
        post_approval TEXT,
        disabled INTEGER,
        handle TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE space_workflow_nodes (
        id TEXT PRIMARY KEY,
        workflow_id TEXT,
        name TEXT,
        description TEXT,
        config TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE sdk_message_replacements (
        source_message_id TEXT,
        session_id TEXT,
        task_id TEXT,
        target_uuid TEXT,
        kind TEXT
      );
      CREATE TABLE delivery_consumed_seq (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_seq INTEGER NOT NULL
      );
      INSERT INTO delivery_consumed_seq (singleton, next_seq) VALUES (1, 10);
    `);
    if (!withRows) return;

    db.prepare(
      'INSERT INTO sessions (id, title, status, type, last_active_at, room_id) VALUES (?, ?, NULL, NULL, ?, NULL)'
    ).run(FIXTURE_SESSION_ID, 'fixture session', '2026-08-20T10:00:00.000Z');
    db.prepare(
      'INSERT INTO space_tasks (id, space_id, task_number, status) VALUES (?, ?, ?, ?)'
    ).run('fixture-task-1', FIXTURE_SPACE_ID, 1, 'in_progress');

    const insertMessage = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, task_id, message_type, message_subtype, message_subtype_norm,
         is_terminal, sdk_uuid, sdk_message, timestamp, send_status, origin, parent_tool_use_id, consumed_seq)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
    );
    insertMessage.run(
      'm-user-1',
      FIXTURE_SESSION_ID,
      'user',
      null,
      '',
      0,
      'u-1',
      JSON.stringify({ type: 'user', message: { content: 'hello fixture body' } }),
      '2026-08-20T10:00:01.000Z',
      'consumed',
      null
    );
    insertMessage.run(
      'm-asst-1',
      FIXTURE_SESSION_ID,
      'assistant',
      null,
      '',
      0,
      'a-1',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'assistant fixture reply' }] },
      }),
      '2026-08-20T10:00:02.000Z',
      'consumed',
      null
    );
    insertMessage.run(
      'm-result-1',
      FIXTURE_SESSION_ID,
      'result',
      'success',
      'success',
      1,
      'r-1',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
      '2026-08-20T10:00:03.000Z',
      'consumed',
      5
    );
    insertMessage.run(
      'm-user-2',
      FIXTURE_SESSION_ID,
      'user',
      null,
      '',
      0,
      'u-2',
      JSON.stringify({ type: 'user', message: { content: 'second fixture turn' } }),
      '2026-08-20T10:00:04.000Z',
      'consumed',
      null
    );
    insertMessage.run(
      'm-result-2',
      FIXTURE_SESSION_ID,
      'result',
      'success',
      'success',
      1,
      'r-2',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done again' }),
      '2026-08-20T10:00:05.000Z',
      'consumed',
      9
    );

    const insertJob = db.prepare(
      `INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at)
       VALUES (?, 'message_delivery', 'pending', ?, 0, 3, 0, 0, 0)`
    );
    insertJob.run('job-1', JSON.stringify({ sessionId: FIXTURE_SESSION_ID, messageUuid: 'u-2' }));
    insertJob.run(
      'job-2',
      JSON.stringify({ sessionId: FIXTURE_SESSION_ID, secretToken: FIXTURE_SECRET })
    );
    db.prepare(
      `INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at)
       VALUES (?, 'message_delivery', 'completed', '{}', 0, 3, 0, 0, 0)`
    ).run('job-done');

    const insertWorkflow = db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, description, tags, disabled, created_at, updated_at)
       VALUES (?, ?, ?, '', '[]', 0, 1, 1)`
    );
    insertWorkflow.run('wf-1', FIXTURE_SPACE_ID, 'fixture workflow one');
    insertWorkflow.run('wf-2', FIXTURE_SPACE_ID, 'fixture workflow two');
    const insertNode = db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 1, 1)`
    );
    insertNode.run('node-1', 'wf-1', 'node one');
    insertNode.run('node-2', 'wf-1', 'node two');
    insertNode.run('node-3', 'wf-2', 'node three');
  } finally {
    db.close();
  }
}

function tableRowCounts(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true });
  try {
    const counts: Record<string, number> = {};
    for (const table of [
      'sdk_messages',
      'sessions',
      'space_tasks',
      'job_queue',
      'space_workflows',
      'space_workflow_nodes',
      'sdk_message_replacements',
      'delivery_consumed_seq',
    ]) {
      counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return counts;
  } finally {
    db.close();
  }
}

function flags(...entries: Array<string | [string, string]>): string[] {
  const argv: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      argv.push(`--${entry}`);
      continue;
    }
    argv.push(`--${entry[0]}`, entry[1]);
  }
  return argv;
}

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'hyperneo-live-scale-'));
  populatedDbPath = join(fixtureDir, 'populated.db');
  emptyDbPath = join(fixtureDir, 'empty.db');
  createFixture(populatedDbPath, true);
  createFixture(emptyDbPath, false);
});

afterAll(() => {
  if (fixtureDir && existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('parseLiveScaleQueryArgs', () => {
  test('applies documented defaults and selects every profile implicitly', () => {
    const parsed = parseLiveScaleQueryArgs(['--db', '/tmp/fixture.db'], {});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.dbPath).toBe('/tmp/fixture.db');
    expect(parsed.options.profiles).toEqual([...LIVE_SCALE_QUERY_PROFILES]);
    expect(parsed.options.implicitAll).toBe(true);
    expect(parsed.options.limit).toBe(200);
    expect(parsed.options.warmup).toBe(1);
    expect(parsed.options.iterations).toBe(5);
    expect(parsed.options.thresholdMs).toBe(250);
    expect(parsed.options.busyTimeoutMs).toBe(10_000);
    expect(parsed.options.json).toBe(false);
    expect(parsed.options.noFail).toBe(false);
  });

  test('falls back to BENCH_DB_PATH and parses explicit profiles and thresholds', () => {
    const parsed = parseLiveScaleQueryArgs(
      [
        '--profile',
        'space-workflows,job-queue-candidate',
        '--profile',
        'consumed-seq-watermarks',
        '--threshold-ms',
        '50',
        '--profile-threshold-ms',
        'messages-by-session=40',
        '--limit',
        '25',
        '--warmup',
        '0',
        '--iterations',
        '3',
        '--json',
        '--no-fail',
        '--session-id',
        's',
        '--space-id',
        'sp',
        '--message-id',
        'm',
        '--message-uuid',
        'u',
        '--queue',
        'q',
        '--busy-timeout-ms',
        '2500',
      ],
      { BENCH_DB_PATH: '/env/fixture.db' }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.dbPath).toBe('/env/fixture.db');
    expect(parsed.options.profiles).toEqual([
      'space-workflows',
      'job-queue-candidate',
      'consumed-seq-watermarks',
    ]);
    expect(parsed.options.implicitAll).toBe(false);
    expect(parsed.options.thresholdMs).toBe(50);
    expect(parsed.options.profileThresholdsMs['messages-by-session']).toBe(40);
    expect(parsed.options.limit).toBe(25);
    expect(parsed.options.warmup).toBe(0);
    expect(parsed.options.iterations).toBe(3);
    expect(parsed.options.json).toBe(true);
    expect(parsed.options.noFail).toBe(true);
  });

  test('rejects missing db, unknown flags, missing values, bad integers, and unknown profiles', () => {
    expect(parseLiveScaleQueryArgs([], {}).ok).toBe(false);
    expect(parseLiveScaleQueryArgs(['--db', '/x', '--nonsense'], {}).ok).toBe(false);
    expect(parseLiveScaleQueryArgs(['--db'], {}).ok).toBe(false);
    expect(parseLiveScaleQueryArgs(['--db', '/x', '--limit', 'abc'], {}).ok).toBe(false);
    expect(parseLiveScaleQueryArgs(['--db', '/x', '--limit', '0'], {}).ok).toBe(false);
    expect(parseLiveScaleQueryArgs(['--db', '/x', '--profile', 'nope'], {}).ok).toBe(false);
    expect(parseLiveScaleQueryArgs(['--db', '/x', '--profile-threshold-ms', 'nope=5'], {}).ok).toBe(
      false
    );
    expect(
      parseLiveScaleQueryArgs(['--db', '/x', '--profile-threshold-ms', 'space-workflows=x'], {}).ok
    ).toBe(false);
    expect(parseLiveScaleQueryArgs(['unexpected'], {}).ok).toBe(false);
  });
});

describe('assertReadOnlyQuerySql', () => {
  test('accepts select, with, and explain shapes', () => {
    expect(() => assertReadOnlyQuerySql('SELECT 1')).not.toThrow();
    expect(() => assertReadOnlyQuerySql('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow();
    expect(() => assertReadOnlyQuerySql('EXPLAIN QUERY PLAN SELECT 1')).not.toThrow();
    expect(() => assertReadOnlyQuerySql('/* lead comment */ SELECT 1')).not.toThrow();
  });

  test('rejects every mutating or control statement shape', () => {
    for (const sql of [
      "INSERT INTO t VALUES ('x')",
      'UPDATE t SET x = 1',
      'DELETE FROM t',
      'BEGIN IMMEDIATE',
      'COMMIT',
      'VACUUM',
      'PRAGMA query_only = OFF',
      "ATTACH DATABASE 'x' AS y",
    ]) {
      try {
        assertReadOnlyQuerySql(sql);
        throw new Error(`expected rejection for: ${sql}`);
      } catch (error) {
        expect(error).toBeInstanceOf(LiveScaleQuerySetupError);
        expect((error as LiveScaleQuerySetupError).reasonCode).toBe('statement-rejected');
      }
    }
  });
});

describe('summarizeSamples', () => {
  test('computes min, median, nearest-rank p95, and max', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(summarizeSamples(samples)).toEqual({
      minMs: 1,
      medianMs: 50.5,
      p95Ms: 95,
      maxMs: 100,
    });
    expect(summarizeSamples([5])).toEqual({ minMs: 5, medianMs: 5, p95Ms: 5, maxMs: 5 });
    expect(summarizeSamples([1, 9])).toEqual({ minMs: 1, medianMs: 5, p95Ms: 9, maxMs: 9 });
    expect(summarizeSamples([])).toEqual({ minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 });
  });
});

describe('live-scale query regression harness', () => {
  test('runs every hot profile read-only against the populated fixture', () => {
    const before = tableRowCounts(populatedDbPath);
    const parsed = parseLiveScaleQueryArgs(flags(['db', populatedDbPath]), {});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { report, exitCode } = runLiveScaleQueryRegression(parsed.options);
    expect(exitCode).toBe(0);
    expect(report.schemaVersion).toBe(1);
    expect(report.database.readOnly).toBe(true);
    expect(report.database.queryOnly).toBe(true);
    expect(report.database.pageCount).toBeGreaterThan(0);

    expect(report.inputs['messages-by-session']).toEqual({ source: 'discovered', resolved: true });
    expect(report.inputs['space-workflows']).toEqual({ source: 'discovered', resolved: true });
    expect(report.inputs['consumed-seq-watermarks']).toEqual({
      source: 'discovered',
      resolved: true,
    });
    expect(report.inputs['message-search-admission']).toEqual({
      source: 'discovered',
      resolved: true,
    });
    expect(report.inputs['job-queue-candidate']).toEqual({ source: 'discovered', resolved: true });

    const profileByName = new Map(report.profiles.map((profile) => [profile.name, profile]));
    for (const profile of report.profiles) {
      expect(profile.status).toBe('passed');
      expect(profile.cases.length).toBeGreaterThan(0);
      for (const caseReport of profile.cases) {
        expect(caseReport.samplesMs).toHaveLength(report.run.measuredIterations);
        for (const statement of caseReport.statements) {
          expect(statement.fingerprint).toHaveLength(16);
          expect(statement.plan.length).toBeGreaterThan(0);
        }
      }
    }

    const messages = profileByName.get('messages-by-session');
    expect(messages?.cases.map((caseReport) => caseReport.name)).toEqual(['snapshot', 'delta']);
    for (const caseReport of messages?.cases ?? []) {
      expect(caseReport.rowsReturned.max).toBe(5);
      expect(caseReport.statementsPerIteration.max).toBe(2);
      expect(caseReport.statements).toHaveLength(2);
    }

    const workflows = profileByName.get('space-workflows');
    const workflowCase = workflows?.cases[0];
    expect(workflowCase?.statementsPerIteration).toEqual({ min: 3, max: 3 });
    expect(workflowCase?.rowsReturned).toEqual({ min: 5, max: 5 });

    const watermarks = profileByName.get('consumed-seq-watermarks');
    const watermarkRows = new Map(
      watermarks?.cases.map((caseReport) => [caseReport.name, caseReport.rowsReturned.max])
    );
    expect(watermarkRows.get('terminal-success-result-after')).toBe(1);
    expect(watermarkRows.get('recovery-intercepted-result-after')).toBe(0);
    expect(watermarkRows.get('error-terminal-subtype-after')).toBe(0);

    const admission = profileByName.get('message-search-admission');
    expect(admission?.cases[0].rowsReturned).toEqual({ min: 1, max: 1 });
    expect(admission?.cases[0].statementsPerIteration).toEqual({ min: 3, max: 3 });
    expect(admission?.cases[0].statements).toHaveLength(3);

    const queue = profileByName.get('job-queue-candidate');
    expect(queue?.cases[0].rowsReturned).toEqual({ min: 2, max: 2 });

    expect(tableRowCounts(populatedDbPath)).toEqual(before);
  });

  test('honors explicit input overrides and per-profile thresholds', () => {
    const parsed = parseLiveScaleQueryArgs(
      flags(
        ['db', populatedDbPath],
        ['profile', 'messages-by-session'],
        ['session-id', FIXTURE_SESSION_ID],
        ['profile-threshold-ms', 'messages-by-session=0']
      ),
      {}
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { report, exitCode } = runLiveScaleQueryRegression(parsed.options);
    expect(exitCode).toBe(1);
    expect(report.inputs['messages-by-session']).toEqual({ source: 'override', resolved: true });
    const messages = report.profiles.find((profile) => profile.name === 'messages-by-session');
    expect(messages?.status).toBe('failed');
    expect(messages?.cases[0].thresholdMs).toBe(0);
    expect(report.summary.thresholdFailures).toBeGreaterThan(0);
    expect(report.profiles).toHaveLength(1);
  });

  test('no-fail keeps threshold regressions at exit code 0 without touching exit code 2 causes', () => {
    const regressing = parseLiveScaleQueryArgs(
      flags(['db', populatedDbPath], ['threshold-ms', '0'], 'no-fail'),
      {}
    );
    expect(regressing.ok).toBe(true);
    if (regressing.ok) {
      expect(runLiveScaleQueryRegression(regressing.options).exitCode).toBe(0);
    }
    const missing = parseLiveScaleQueryArgs(
      ['--db', join(fixtureDir, 'does-not-exist.db'), '--no-fail'],
      {}
    );
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    try {
      runLiveScaleQueryRegression(missing.options);
      throw new Error('expected a setup failure for a missing database');
    } catch (error) {
      expect(error).toBeInstanceOf(LiveScaleQuerySetupError);
      expect((error as LiveScaleQuerySetupError).reasonCode).toBe('database-open-failed');
    }
  });

  test('implicit-all skips absent data while explicit profiles fail on missing input', () => {
    const implicit = parseLiveScaleQueryArgs(['--db', emptyDbPath], {});
    expect(implicit.ok).toBe(true);
    if (implicit.ok) {
      const { report, exitCode } = runLiveScaleQueryRegression(implicit.options);
      expect(report.profiles.every((profile) => profile.status === 'skipped')).toBe(true);
      expect(exitCode).toBe(1);
    }

    const explicit = parseLiveScaleQueryArgs(
      ['--db', emptyDbPath, '--profile', 'job-queue-candidate'],
      {}
    );
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      const { report, exitCode } = runLiveScaleQueryRegression(explicit.options);
      expect(report.profiles[0].status).toBe('failed');
      expect(report.profiles[0].reasonCode).toBe('input-missing');
      expect(exitCode).toBe(1);
    }
  });

  test('an explicit input that does not exist fails resolution', () => {
    const parsed = parseLiveScaleQueryArgs(
      flags(
        ['db', populatedDbPath],
        ['profile', 'consumed-seq-watermarks'],
        ['message-uuid', 'no-such-uuid']
      ),
      {}
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { report, exitCode } = runLiveScaleQueryRegression(parsed.options);
    expect(report.inputs['consumed-seq-watermarks']).toEqual({
      source: 'override',
      resolved: false,
    });
    expect(report.profiles[0].status).toBe('failed');
    expect(exitCode).toBe(1);
  });

  test('the report never contains resolved identifiers, message bodies, or payload values', () => {
    const parsed = parseLiveScaleQueryArgs(
      flags(
        ['db', populatedDbPath],
        ['message-id', 'm-user-2'],
        ['session-id', FIXTURE_SESSION_ID]
      ),
      {}
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { report } = runLiveScaleQueryRegression(parsed.options);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(FIXTURE_SESSION_ID);
    expect(serialized).not.toContain('fixture-payload-secret');
    expect(serialized).not.toContain('second fixture turn');
    expect(serialized).not.toContain('m-user-2');
    const rendered = JSON.stringify(report.profiles);
    expect(rendered).not.toContain(FIXTURE_SPACE_ID);
  });

  test('the CLI emits valid json, human text, usage, and deterministic exit codes', () => {
    const jsonOut: string[] = [];
    const jsonResult = runLiveScaleQueryCli(
      flags(['db', populatedDbPath], 'json'),
      {},
      { out: { write: (chunk) => jsonOut.push(chunk) }, err: { write: () => {} } }
    );
    expect(jsonResult).toBe(0);
    const report = JSON.parse(jsonOut.join('')) as LiveScaleQueryReport;
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.exitCode).toBe(0);

    const textOut: string[] = [];
    const textResult = runLiveScaleQueryCli(
      flags(['db', populatedDbPath]),
      {},
      { out: { write: (chunk) => textOut.push(chunk) }, err: { write: () => {} } }
    );
    expect(textResult).toBe(0);
    const text = textOut.join('');
    expect(text).toContain('live-scale query regression');
    expect(text).toContain('profile messages-by-session: passed');
    expect(text).not.toContain(populatedDbPath);

    const helpOut: string[] = [];
    const helpResult = runLiveScaleQueryCli(
      ['--help'],
      {},
      { out: { write: (chunk) => helpOut.push(chunk) }, err: { write: () => {} } }
    );
    expect(helpResult).toBe(0);
    expect(helpOut.join('')).toContain('usage:');

    const errChunks: string[] = [];
    const badFlag = runLiveScaleQueryCli(
      ['--db', populatedDbPath, '--nonsense'],
      {},
      { out: { write: () => {} }, err: { write: (chunk) => errChunks.push(chunk) } }
    );
    expect(badFlag).toBe(2);
    expect(errChunks.join('')).toContain('unknown flag');

    const openErr: string[] = [];
    const openFailure = runLiveScaleQueryCli(
      ['--db', join(fixtureDir, 'absent.db')],
      {},
      { out: { write: () => {} }, err: { write: (chunk) => openErr.push(chunk) } }
    );
    expect(openFailure).toBe(2);
    expect(openErr.join('')).toContain('database-open-failed');
  });

  test('the harness connection is physically read-only', () => {
    const db = new Database(populatedDbPath, { readonly: true });
    try {
      db.exec('PRAGMA query_only = ON');
      expect(() => db.exec(`INSERT INTO job_queue (id) VALUES ('mutation-probe')`)).toThrow();
    } finally {
      db.close();
    }
    expect(tableRowCounts(populatedDbPath).job_queue).toBe(3);
  });
});
