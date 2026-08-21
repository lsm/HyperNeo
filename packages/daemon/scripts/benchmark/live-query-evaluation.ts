import { Database } from 'bun:sqlite';
import { LiveQueryEngine } from '../../src/storage/live-query';
import { setupLiveQueryHandlers } from '../../src/lib/rpc-handlers/live-query-handlers';
import { BACKGROUND_TASK_METADATA_SQL } from '../../src/lib/rpc-handlers/live-query-handlers';
import { createSessionCounters } from '../../src/storage/schema/session-counters';
import type { TableChangeScope } from '../../src/storage/reactive-database';

const DEBOUNCE_WAIT_MS = 400;
const WARM_EVAL_RUNS = 10;

interface Stats {
  count: number;
  totalMs: number;
  samples: number[];
}

function newStats(): Stats {
  return { count: 0, totalMs: 0, samples: [] };
}

function record(stats: Stats, ms: number): void {
  stats.count += 1;
  stats.totalMs += ms;
  if (stats.samples.length < 5000) stats.samples.push(ms);
}

function pct(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function fmt(label: string, stats: Stats): string {
  if (stats.count === 0) return `${label}: 0 runs`;
  return `${label}: n=${stats.count} total=${stats.totalMs.toFixed(1)}ms avg=${(stats.totalMs / stats.count).toFixed(2)}ms p50=${pct(stats.samples, 50).toFixed(2)}ms p95=${pct(stats.samples, 95).toFixed(2)}ms max=${Math.max(...stats.samples).toFixed(2)}ms`;
}

function createStubReactive() {
  let listener: ((data: { tables: string[]; scope?: TableChangeScope }) => void) | null = null;
  const versions: Record<string, number> = {};
  return {
    on(_event: 'change', cb: (data: { tables: string[]; scope?: TableChangeScope }) => void) {
      listener = cb;
    },
    off() {
      listener = null;
    },
    getTableVersion(table: string) {
      return versions[table] ?? 0;
    },
    fire(tables: string[], scope?: TableChangeScope) {
      for (const table of tables) versions[table] = (versions[table] ?? 0) + 1;
      listener?.({ tables, scope });
    },
  };
}

interface DeliveredEvent {
  method: string;
  subscriptionId: string;
  added: number;
  removed: number;
  updated: number;
  snapshotRows: number;
}

interface StubRouter {
  sendToClientDetailed: (clientId: string, message: unknown) => { ok: true };
  sendToClient: () => void;
  releaseClientSubscription: () => void;
  addClientSubscription: () => void;
  checkSubscriptionCapacity: () => { ok: true; current: number; limit: number };
}

interface StubMessageHub {
  onRequest(method: string, handler: (data: unknown, context: unknown) => unknown): void;
  getRouter(): StubRouter | null;
  onClientDisconnect(handler: (clientId: string) => void): void;
  handlers: Map<string, (data: unknown, context: unknown) => unknown>;
  delivered: DeliveredEvent[];
}

function createStubMessageHub(): StubMessageHub {
  const handlers = new Map<string, (data: unknown, context: unknown) => unknown>();
  const delivered: DeliveredEvent[] = [];
  const router: StubRouter = {
    sendToClientDetailed: (_clientId, message) => {
      const event = message as {
        method: string;
        data: {
          subscriptionId: string;
          added?: unknown[];
          removed?: unknown[];
          updated?: unknown[];
          rows?: unknown[];
        };
      };
      delivered.push({
        method: event.method,
        subscriptionId: event.data.subscriptionId,
        added: event.data.added?.length ?? 0,
        removed: event.data.removed?.length ?? 0,
        updated: event.data.updated?.length ?? 0,
        snapshotRows: event.data.rows?.length ?? 0,
      });
      return { ok: true, current: 0, limit: 0 };
    },
    sendToClient: () => {},
    releaseClientSubscription: () => {},
    addClientSubscription: () => {},
    checkSubscriptionCapacity: () => ({ ok: true, current: 0, limit: 1000 }),
  };
  return {
    handlers,
    delivered,
    onRequest(method, handler) {
      handlers.set(method, handler);
    },
    getRouter() {
      return router;
    },
    onClientDisconnect() {},
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dbPath = process.env.BENCH_DB_PATH ?? process.argv[2];
  if (!dbPath) {
    console.error(
      'usage: bun packages/daemon/scripts/benchmark/live-query-evaluation.ts <db-path>'
    );
    console.error('the script INSERTs/UPDATEs/DELETEs benchmark rows; run it on a disposable copy');
    process.exit(1);
  }

  const db = new Database(dbPath);
  createSessionCounters(db as never);
  const stubReactive = createStubReactive();
  const engine = new LiveQueryEngine(db as never, stubReactive as never);
  const hub = createStubMessageHub();
  setupLiveQueryHandlers(hub as never, engine, db as never);

  const engineInternals = engine as unknown as {
    runQuery: (...args: unknown[]) => unknown;
    evaluateQuery: (key: string) => void;
  };
  const mainSqlStats = newStats();
  const evalStats = newStats();
  const origRun = engineInternals.runQuery.bind(engine);
  engineInternals.runQuery = (...args: unknown[]) => {
    const start = performance.now();
    const result = origRun(...args);
    record(mainSqlStats, performance.now() - start);
    return result;
  };
  const origEval = engineInternals.evaluateQuery.bind(engine);
  engineInternals.evaluateQuery = (key: string) => {
    const start = performance.now();
    origEval(key);
    record(evalStats, performance.now() - start);
  };

  const subscribeHandler = hub.handlers.get('liveQuery.subscribe')!;
  const subscribe = (queryName: string, params: unknown[]): void => {
    subscribeHandler(
      { queryName, params, subscriptionId: `bench-${queryName}` },
      {
        clientId: 'bench-client',
        sessionId: undefined,
      }
    );
  };

  const envBiggest = process.env.BENCH_SESSION_ID;
  const envSmall = process.env.BENCH_SMALL_SESSION_ID;
  const discoveredBiggest = db
    .query(
      'SELECT session_id, COUNT(*) AS c FROM sdk_messages GROUP BY session_id ORDER BY c DESC LIMIT 1'
    )
    .get() as { session_id: string; c: number };
  const biggest = envBiggest
    ? { session_id: envBiggest, c: 0 }
    : {
        session_id: discoveredBiggest.session_id,
        c: discoveredBiggest.c,
      };
  const discoveredSmall = db
    .query(
      'SELECT session_id, COUNT(*) AS c FROM sdk_messages GROUP BY session_id HAVING c BETWEEN 1000 AND 3000 ORDER BY c DESC LIMIT 1'
    )
    .get() as { session_id: string; c: number };
  const small = envSmall
    ? { session_id: envSmall, c: 0 }
    : { session_id: discoveredSmall.session_id, c: discoveredSmall.c };
  console.log(`db: ${dbPath}`);
  console.log(
    `largest session: ${biggest.session_id}${envBiggest ? ' (via BENCH_SESSION_ID)' : ` (${biggest.c} messages, discovery queries warmed the page cache)`}`
  );
  console.log(`small reference session: ${small.session_id}`);

  const reset = () => {
    mainSqlStats.count = 0;
    mainSqlStats.totalMs = 0;
    mainSqlStats.samples = [];
    evalStats.count = 0;
    evalStats.totalMs = 0;
    evalStats.samples = [];
    hub.delivered.length = 0;
  };
  const deliveredSummary = (): string => {
    if (hub.delivered.length === 0) return 'delivered: none';
    return hub.delivered
      .map(
        (event) =>
          `${event.method.replace('liveQuery.', '')}(+${event.added}/-${event.removed}/~${event.updated}${event.snapshotRows > 0 ? ` rows=${event.snapshotRows}` : ''})`
      )
      .join(' ');
  };
  const settle = async (label: string, tables: string[], scope?: TableChangeScope) => {
    reset();
    stubReactive.fire(tables, scope);
    await wait(DEBOUNCE_WAIT_MS);
    console.log(`\n== ${label}`);
    console.log(fmt('  main sql', mainSqlStats));
    console.log(fmt('  evaluate', evalStats));
    console.log(`  ${deliveredSummary()}`);
  };

  console.log('\n== messages.bySession via production liveQuery.subscribe (first run) ==');
  const t0 = performance.now();
  subscribe('messages.bySession', [biggest.session_id, 200]);
  console.log(`first subscribe wall: ${(performance.now() - t0).toFixed(1)}ms`);
  console.log(fmt('  main sql', mainSqlStats));
  console.log(fmt('  evaluate', evalStats));
  console.log(`  ${deliveredSummary()}`);

  console.log(`\n== warm no-op evaluations x${WARM_EVAL_RUNS} (scoped change, no mutation) ==`);
  reset();
  for (let i = 0; i < WARM_EVAL_RUNS; i++) {
    stubReactive.fire(['sdk_messages'], { sessionId: biggest.session_id });
    await wait(DEBOUNCE_WAIT_MS);
  }
  console.log(fmt('  main sql', mainSqlStats));
  console.log(fmt('  evaluate', evalStats));
  console.log(`  ${deliveredSummary()}`);

  const insertRow = db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, parent_tool_use_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const nowIso = () => new Date().toISOString();
  insertRow.run(
    `bench-irrelevant-1`,
    biggest.session_id,
    'system',
    'task_progress',
    JSON.stringify({ type: 'system', subtype: 'task_progress', content: 'bench' }),
    nowIso(),
    'consumed',
    null,
    'toolu_bench_not_in_window'
  );
  await settle('irrelevant same-session subagent insert outside window', ['sdk_messages'], {
    sessionId: biggest.session_id,
  });

  db.run(`UPDATE job_queue SET run_at = run_at WHERE rowid = (SELECT MIN(rowid) FROM job_queue)`);
  await settle('scoped job_queue change', ['job_queue'], { sessionId: biggest.session_id });

  insertRow.run(
    `bench-irrelevant-2`,
    small.session_id,
    'system',
    'task_progress',
    JSON.stringify({ type: 'system', subtype: 'task_progress', content: 'bench' }),
    nowIso(),
    'consumed',
    null,
    'toolu_bench_not_in_window'
  );
  await settle('different-session write (scope filter skip)', ['sdk_messages'], {
    sessionId: small.session_id,
  });

  insertRow.run(
    `bench-relevant-1`,
    biggest.session_id,
    'assistant',
    null,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'bench' }] } }),
    nowIso(),
    'consumed',
    null,
    null
  );
  await settle('relevant in-window insert', ['sdk_messages'], { sessionId: biggest.session_id });

  const oldest = db
    .query(
      `SELECT id, send_status FROM sdk_messages WHERE session_id = ? AND parent_tool_use_id IS NULL ORDER BY timestamp ASC LIMIT 1`
    )
    .get(biggest.session_id) as { id: string; send_status: string | null } | undefined;
  let restoreOldest: (() => void) | null = null;
  if (oldest && oldest.send_status !== 'failed') {
    db.run(`UPDATE sdk_messages SET send_status = 'failed' WHERE id = ?`, [oldest.id]);
    restoreOldest = () => {
      db.run(`UPDATE sdk_messages SET send_status = ? WHERE id = ?`, [
        oldest.send_status,
        oldest.id,
      ]);
    };
  }
  await settle('send_status update on old row outside window', ['sdk_messages'], {
    sessionId: biggest.session_id,
  });

  reset();
  for (let i = 0; i < 20; i++) {
    insertRow.run(
      `bench-burst-${i}`,
      biggest.session_id,
      'system',
      'task_progress',
      JSON.stringify({ type: 'system', subtype: 'task_progress', content: 'bench' }),
      nowIso(),
      'consumed',
      null,
      'toolu_bench_not_in_window'
    );
    stubReactive.fire(['sdk_messages'], { sessionId: biggest.session_id });
  }
  await wait(DEBOUNCE_WAIT_MS);
  console.log('\n== burst of 20 same-session writes in one debounce window ==');
  console.log(fmt('  main sql', mainSqlStats));
  console.log(fmt('  evaluate', evalStats));
  console.log(`  ${deliveredSummary()}`);

  console.log('\n== metadata query attribution (BACKGROUND_TASK_METADATA_SQL, warm) ==');
  const metaStmt = db.prepare(BACKGROUND_TASK_METADATA_SQL);
  const sessionId = biggest.session_id;
  const metaParams = [sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId];
  metaStmt.all(...metaParams);
  const metaStats = newStats();
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    metaStmt.all(...metaParams);
    record(metaStats, performance.now() - start);
  }
  console.log(fmt('  metadata sql', metaStats));
  const taskSubtypes = db
    .query(
      `SELECT message_subtype_norm AS st, COUNT(*) AS c FROM sdk_messages WHERE session_id = ? GROUP BY 1 ORDER BY 2 DESC LIMIT 8`
    )
    .all(sessionId) as Array<{ st: string; c: number }>;
  console.log(`  session subtype profile: ${JSON.stringify(taskSubtypes)}`);

  console.log('\n== sentinel candidates (same session, warm) ==');
  const sentinelQueries: Array<[string, string, unknown[]]> = [
    ['count-only', `SELECT COUNT(*) FROM sdk_messages WHERE session_id = ?`, [sessionId]],
    [
      'count+max(rowid)',
      `SELECT COUNT(*), MAX(rowid) FROM sdk_messages WHERE session_id = ?`,
      [sessionId],
    ],
    [
      'task-metadata-scoped count',
      `SELECT COUNT(*), MAX(rowid) FROM sdk_messages WHERE session_id = ? AND parent_tool_use_id IS NULL AND message_subtype_norm IN ('task_started', 'task_updated', 'task_notification', 'task_progress')`,
      [sessionId],
    ],
    [
      'job_queue active delivery',
      `SELECT COUNT(*), MAX(rowid) FROM job_queue WHERE queue = 'message_delivery' AND status IN ('pending','processing') AND json_extract(payload, '$.sessionId') = ?`,
      [sessionId],
    ],
  ];
  for (const [label, sql, params] of sentinelQueries) {
    const stmt = db.prepare(sql);
    stmt.get(...params);
    const stats = newStats();
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      stmt.get(...params);
      record(stats, performance.now() - start);
    }
    console.log(`  ${label}: avg=${(stats.totalMs / stats.count).toFixed(2)}ms`);
  }

  console.log('\n== digest sentinel candidates (same session, warm) ==');
  const digestSql = `SELECT COUNT(*),
      COALESCE(SUM(length(id) + length(timestamp) + length(COALESCE(send_status, ''))), 0),
      COALESCE(SUM(CASE message_type WHEN 'user' THEN 1 ELSE 2 END), 0)
    FROM sdk_messages WHERE session_id = ?`;
  const digestStmt = db.prepare(digestSql);
  digestStmt.get(sessionId);
  const digestStats = newStats();
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    digestStmt.get(sessionId);
    record(digestStats, performance.now() - start);
  }
  console.log(fmt('  session mutation-column digest', digestStats));

  const queueDigestSql = `SELECT jq.rowid, jq.status, jq.retry_count, jq.run_at, jq.max_retries, jq.payload
    FROM job_queue jq
    WHERE jq.queue = 'message_delivery'
      AND jq.status IN ('pending', 'processing')
      AND json_extract(jq.payload, '$.sessionId') = ?`;
  const queueDigestStmt = db.prepare(queueDigestSql);
  const queueDigest = (): string => {
    const rows = queueDigestStmt.all(sessionId) as Record<string, unknown>[];
    return JSON.stringify(rows);
  };
  queueDigest();
  const queueDigestStats = newStats();
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    queueDigest();
    record(queueDigestStats, performance.now() - start);
  }
  console.log(fmt('  job_queue active-row digest (sound shape)', queueDigestStats));

  console.log('\n== high-fanout subagent children under one in-window tool use ==');
  const windowToolUse = db
    .query(
      `SELECT je.value ->> '$.id' AS tool_use_id
       FROM (
         SELECT sdk_message FROM sdk_messages
         WHERE session_id = ?1 AND parent_tool_use_id IS NULL AND message_type = 'assistant'
         ORDER BY timestamp DESC, rowid DESC LIMIT 50
       ), json_each(CASE WHEN json_valid(sdk_message) THEN json_extract(sdk_message, '$.message.content') ELSE '[]' END) AS je
       WHERE json_extract(je.value, '$.type') = 'tool_use'
         AND json_extract(je.value, '$.id') IS NOT NULL
       LIMIT 1`
    )
    .get(sessionId) as { tool_use_id: string } | undefined;
  if (windowToolUse) {
    console.log(`  in-window tool_use: ${windowToolUse.tool_use_id}`);
    const insertChild = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, parent_tool_use_id)
       VALUES (?, ?, 'progress', 'task_progress', ?, ?, 'consumed', NULL, ?)`
    );
    const fanoutCases: Array<{ count: number; payloadKb: number }> = [
      { count: 500, payloadKb: 0 },
      { count: 5000, payloadKb: 0 },
      { count: 200, payloadKb: 50 },
      { count: 1000, payloadKb: 50 },
    ];
    for (const { count, payloadKb } of fanoutCases) {
      const deleted = db
        .prepare(`SELECT COUNT(*) AS n FROM sdk_messages WHERE id LIKE 'bench-fanout-%'`)
        .get() as { n: number };
      if (deleted.n > 0) {
        db.run(`DELETE FROM sdk_messages WHERE id LIKE 'bench-fanout-%'`);
        await settle(
          `settling removal of previous fan-out case (${deleted.n} rows)`,
          ['sdk_messages'],
          { sessionId: biggest.session_id }
        );
      }
      const payload = JSON.stringify({
        type: 'progress',
        subtype: 'task_progress',
        content: payloadKb > 0 ? 'x'.repeat(payloadKb * 1024) : 'bench fanout',
      });
      for (let i = 0; i < count; i++) {
        insertChild.run(
          `bench-fanout-${count}-${payloadKb}-${i}`,
          sessionId,
          payload,
          nowIso(),
          windowToolUse.tool_use_id
        );
      }
      await settle(
        `evaluation with ${count} subagent children x ${payloadKb}KB payloads in window`,
        ['sdk_messages'],
        { sessionId: biggest.session_id }
      );
    }
    db.run(`DELETE FROM sdk_messages WHERE id LIKE 'bench-fanout-%'`);
  } else {
    console.log('  (no tool_use found in recent window — skipped)');
  }

  try {
    db.run(`DELETE FROM sdk_messages WHERE id LIKE 'bench-%'`);
    db.run(`UPDATE job_queue SET run_at = run_at`);
    restoreOldest?.();
  } finally {
    engine.dispose();
    db.close();
  }
  console.log('\nbenchmark complete');
}

await main();
