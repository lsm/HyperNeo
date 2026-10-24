import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';

const [, , mode, run, count = '11000'] = process.argv;
if (!run || process.env.NODE_ENV !== 'test')
  throw new Error(
    'NODE_ENV=test bun sdk-message-columns.ts seed|upgrade|inspect <fresh-run-dir> [rows]'
  );
mkdirSync(join(run, 'evidence'), { recursive: true });
const path = join(run, 'daemon.db');
if (mode === 'seed') {
  const db = new Database(path);
  try {
    runMigrations(db, () => {});
    createTables(db);
    db.exec('PRAGMA foreign_keys = OFF');
    const insert = db.prepare(
      "INSERT INTO sdk_messages (id,session_id,message_type,sdk_message,timestamp,task_id,replacement_metadata_normalized) VALUES (?,'synthetic-columns','user',?,'2026-10-20T00:00:00Z','fallback-task',1)"
    );
    const hash = createHash('sha256');
    const tool = 'tool-result-preserved-'.repeat(35_000);
    db.transaction(() => {
      for (let i = 0; i < Number(count); i++) {
        const body = JSON.stringify({
          type: 'user',
          uuid: `synthetic-${i}`,
          inputKind: 'task',
          isReplay: false,
          message: {
            role: 'user',
            content:
              i % 16 === 0
                ? [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: tool }]
                : [{ type: 'text', text: 'synthetic input' }],
          },
        });
        insert.run(`synthetic-${i}`, body);
        hash.update(body);
      }
      insert.run('malformed-synthetic', '{broken-json');
    })();
    const baseline = { rows: Number(count), hash: hash.digest('hex') };
    writeFileSync(join(run, 'evidence/baseline.json'), JSON.stringify(baseline));
    console.log(JSON.stringify(baseline));
  } finally {
    db.close();
  }
} else if (mode === 'upgrade') {
  const core = new DatabaseCore(path, {
    queryObservability: {
      slowThresholdMs: 100,
      summaryIntervalMs: 300_000,
      maxQueryGroups: 500,
      summaryQueryLimit: 5,
    },
  });
  let last = performance.now();
  let maxLagMs = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 10);
    last = now;
  }, 10);
  const start = performance.now();
  try {
    await core.initialize();
    const schemaReadyMs = performance.now() - start;
    await core.startSdkMessageColumnsBackfill();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = { elapsedMs: performance.now() - start, schemaReadyMs, maxLagMs };
    writeFileSync(join(run, 'evidence/upgrade.json'), JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally {
    clearInterval(heartbeat);
    await core.close();
  }
} else if (mode === 'inspect') {
  const db = new Database(path, { readonly: true });
  try {
    const names = (
      db.prepare("PRAGMA table_xinfo('sdk_messages')").all() as { name: string }[]
    ).map((row) => row.name);
    if (!names.includes('has_tool_result'))
      throw new Error('REPRO: SDK derived columns are absent');
    const baseline = JSON.parse(readFileSync(join(run, 'evidence/baseline.json'), 'utf8'));
    const hash = createHash('sha256');
    const rows = db
      .prepare(
        "SELECT sdk_message FROM sdk_messages WHERE session_id='synthetic-columns' AND id <> 'malformed-synthetic' ORDER BY seq"
      )
      .all() as { sdk_message: string }[];
    for (const row of rows) hash.update(row.sdk_message);
    const result = {
      rows: rows.length,
      hash: hash.digest('hex'),
      projection: db
        .prepare(
          "SELECT input_kind,is_replay,has_tool_result,tool_result_only,bg_task_id FROM sdk_messages WHERE id='synthetic-0'"
        )
        .get(),
      malformed: db
        .prepare(
          "SELECT has_tool_result,input_kind,sdk_message FROM sdk_messages WHERE id='malformed-synthetic'"
        )
        .get(),
    };
    writeFileSync(join(run, 'evidence/inspection.json'), JSON.stringify(result));
    console.log(JSON.stringify(result));
    if (result.rows !== baseline.rows || result.hash !== baseline.hash)
      throw new Error('Stored bodies changed');
    if (
      JSON.stringify(result.projection) !==
      JSON.stringify({
        input_kind: 'task',
        is_replay: 0,
        has_tool_result: 1,
        tool_result_only: 1,
        bg_task_id: 'fallback-task',
      })
    )
      throw new Error('Derived metadata differs');
  } finally {
    db.close();
  }
} else throw new Error(`Unknown mode: ${mode}`);
