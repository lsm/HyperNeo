import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';

import { Database } from 'bun:sqlite';

const ITERATIONS = 50_000;
const WARMUP_ITERATIONS = 100_000;
const SAMPLES = 5;

const log = (message: string): void => process.stdout.write(`${message}\n`);

const INSERT_SQL = `INSERT INTO sdk_messages (
  id, session_id, message_type, message_subtype, sdk_message, timestamp, origin,
  is_renderable, is_terminal, parent_tool_use_id, task_id, conversation_turn_index,
  sdk_uuid, replacement_metadata_normalized
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;

const SELECT_SQL = `SELECT id, sdk_message, timestamp FROM sdk_messages
  WHERE session_id = ? AND send_status = ?
  ORDER BY timestamp ASC`;

const GET_SQL = `SELECT id, sdk_message, timestamp FROM sdk_messages
  WHERE session_id = ? AND send_status = ? AND sdk_uuid = ?
  LIMIT 1`;

type Variant =
  | 'fresh-insert'
  | 'cached-insert'
  | 'fresh-select'
  | 'cached-select'
  | 'fresh-get'
  | 'cached-get';

type Measurement = {
  nsPerOp: number;
  checksum: number;
};

type Sample = {
  cold: Measurement;
  warm: Measurement;
};

function createDatabase(): Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    message_subtype TEXT,
    sdk_message TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    origin TEXT,
    is_renderable INTEGER NOT NULL DEFAULT 0,
    is_terminal INTEGER NOT NULL DEFAULT 0,
    parent_tool_use_id TEXT,
    task_id TEXT,
    conversation_turn_index INTEGER,
    sdk_uuid TEXT,
    send_status TEXT,
    replacement_metadata_normalized INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec(`CREATE INDEX idx_sdk_messages_session_status ON sdk_messages(session_id, send_status)`);
  return db;
}

function insertParams(index: number): unknown[] {
  return [
    `msg-${index}`,
    `session-${index % 32}`,
    index % 3 === 0 ? 'user' : 'assistant',
    null,
    JSON.stringify({ type: index % 3 === 0 ? 'user' : 'assistant', text: 'hello '.repeat(8) }),
    new Date(index * 1000).toISOString(),
    index % 5 === 0 ? 'api' : null,
    index % 3 === 0 ? 1 : 0,
    index % 7 === 0 ? 1 : 0,
    index % 4 === 0 ? `tool-${index}` : null,
    index % 11 === 0 ? `task-${index}` : null,
    index,
    `uuid-${index}`,
  ];
}

function runIterations(run: (index: number) => number, iterations: number): Measurement {
  let checksum = 0;
  const start = Bun.nanoseconds();
  for (let index = 0; index < iterations; index++) {
    checksum += run(index);
  }
  return { nsPerOp: (Bun.nanoseconds() - start) / iterations, checksum };
}

function collectSample(variant: Variant): Sample {
  const cold = runIterations(createRunner(variant), ITERATIONS);
  runIterations(createRunner(variant), WARMUP_ITERATIONS);
  const warm = runIterations(createRunner(variant), ITERATIONS);
  return { cold, warm };
}

function createRunner(variant: Variant): (index: number) => number {
  const db = createDatabase();
  if (variant === 'fresh-insert') {
    return (index) => {
      const result = db.prepare(INSERT_SQL).run(...(insertParams(index) as [never]));
      return Number(result.lastInsertRowid) + result.changes;
    };
  }
  if (variant === 'cached-insert') {
    const stmt = db.prepare(INSERT_SQL);
    return (index) => {
      const result = stmt.run(...(insertParams(index) as [never]));
      return Number(result.lastInsertRowid) + result.changes;
    };
  }
  const seedInsert = db.prepare(INSERT_SQL);
  const seedTxn = db.transaction(() => {
    for (let index = 0; index < 2_000; index++) {
      seedInsert.run(...(insertParams(index) as [never]));
    }
  });
  seedTxn();
  db.exec(`UPDATE sdk_messages SET send_status = 'pending' WHERE id IN (
    SELECT id FROM sdk_messages WHERE session_id = 'session-1' LIMIT 40
  )`);
  if (variant === 'fresh-select') {
    return () => {
      const rows = db.prepare(SELECT_SQL).all(`session-${1}`, 'pending') as Array<{
        id: string;
      }>;
      return rows.length;
    };
  }
  if (variant === 'cached-select') {
    const stmt = db.prepare(SELECT_SQL);
    return () => {
      const rows = stmt.all(`session-${1}`, 'pending') as Array<{ id: string }>;
      return rows.length;
    };
  }
  if (variant === 'fresh-get') {
    return (index) => {
      const row = db.prepare(GET_SQL).get(`session-${index % 32}`, 'pending', `uuid-${index}`) as {
        id?: string;
      } | null;
      return row?.id?.length ?? 0;
    };
  }
  const stmt = db.prepare(GET_SQL);
  return (index) => {
    const row = stmt.get(`session-${index % 32}`, 'pending', `uuid-${index}`) as {
      id?: string;
    } | null;
    return row?.id?.length ?? 0;
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function runChild(variant: Variant): Sample {
  const output = execFileSync(process.execPath, [import.meta.path, '--variant', variant], {
    encoding: 'utf8',
  });
  return JSON.parse(output) as Sample;
}

function formatValues(values: readonly number[]): string {
  return `${median(values).toFixed(1)} [${values.map((value) => value.toFixed(1)).join(', ')}]`;
}

function summarize(variant: Variant, samples: readonly Sample[]): void {
  const cold = samples.map((sample) => sample.cold.nsPerOp);
  const warm = samples.map((sample) => sample.warm.nsPerOp);
  log(
    `${variant.padEnd(14)} ${formatValues(cold).padStart(52)} ${formatValues(warm).padStart(52)}`
  );
}

const variantIndex = process.argv.indexOf('--variant');
const variant = process.argv[variantIndex + 1] as Variant | undefined;

const allVariants: readonly Variant[] = [
  'fresh-insert',
  'cached-insert',
  'fresh-select',
  'cached-select',
  'fresh-get',
  'cached-get',
];

if (variant && allVariants.includes(variant)) {
  process.stdout.write(JSON.stringify(collectSample(variant)));
} else {
  const byVariant = new Map<Variant, Sample[]>();
  for (const name of allVariants) {
    byVariant.set(
      name,
      Array.from({ length: SAMPLES }, () => runChild(name))
    );
  }
  for (const [freshName, cachedName] of [
    ['fresh-insert', 'cached-insert'],
    ['fresh-select', 'cached-select'],
    ['fresh-get', 'cached-get'],
  ] as const) {
    const equivalentChecksums = [
      ...byVariant.get(freshName)!,
      ...byVariant.get(cachedName)!,
    ].flatMap((sample) => [sample.cold.checksum, sample.warm.checksum]);
    if (!equivalentChecksums.every((checksum) => checksum === equivalentChecksums[0])) {
      throw new Error(
        `Benchmark samples produced inconsistent checksums for ${freshName}/${cachedName}`
      );
    }
  }

  log(
    `Bun ${Bun.version}; ${process.platform} ${process.arch}; ${cpus()[0]?.model ?? 'unknown CPU'}`
  );
  log(`${ITERATIONS.toLocaleString()} measured iterations; ${SAMPLES} fresh processes per variant`);
  log(`${WARMUP_ITERATIONS.toLocaleString()} iterations before each warm measurement\n`);
  log(
    'variant                          cold ns/op: median [samples]   warm ns/op: median [samples]'
  );
  for (const name of allVariants) {
    summarize(name, byVariant.get(name)!);
  }
}
