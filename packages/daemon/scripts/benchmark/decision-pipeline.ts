import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Database } from '../../src/storage/sqlite-compat.ts';
import { createTables } from '../../src/storage/schema/index.ts';
import { decisionRun } from '../../src/lib/space/runtime/decision-pipeline.ts';
import {
  decideMessageAdmission,
  normalizeMessageAdmissionInput,
} from '../../src/storage/repositories/sdk-message-admission.ts';
import { planAdmissionBadgeUpdate } from '../../src/storage/repositories/sdk-message-badge.ts';

const ITERATIONS = 100_000;
const WARMUP_ITERATIONS = 1_000_000;
const INSERT_ITERATIONS = 10_000;
const INSERT_WARMUP_ITERATIONS = 10_000;
const SAMPLES = 5;
const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

type RouterDecision = 'defer' | 'reject' | 'deny-self' | 'queue' | 'prioritize' | 'route';

type RouterContext = {
  senderId: string;
  targetId: string;
  channel: string;
  message: string;
  runState: string;
  isDirect: boolean;
  isPaused: boolean;
  allowSelf: boolean;
  capacityAvailable: boolean;
  tags: readonly string[];
  decision: RouterDecision | null;
};

type RouterInput = Omit<RouterContext, 'decision'>;
type Variant = 'decisionRun' | 'if-cascade' | 'save-pipeline' | 'save-direct' | 'sqlite-insert';

type Measurement = { nsPerOp: number; checksum: number };

type Sample = { cold: Measurement; warm: Measurement };

type SaveState = {
  sessionId: string;
  message: SDKMessage;
  dbId?: string;
  admission?: ReturnType<typeof decideMessageAdmission>;
  badgeUpdate?: ReturnType<typeof planAdmissionBadgeUpdate>;
  deps: { save: (s: SaveState) => { dbId: string } };
};

type InsertRow = {
  id: string;
  sessionId: string;
  messageType: string;
  messageSubtype: string | null;
  sdkMessage: string;
  isRenderable: 0 | 1;
  isTerminal: 0 | 1;
  parentToolUseId: string | null;
  sdkUuid: string | null;
};

const inputs: readonly RouterInput[] = [
  {
    senderId: 'agent-a',
    targetId: 'agent-b',
    channel: 'review',
    message: 'paused delivery',
    runState: 'running',
    isDirect: true,
    isPaused: true,
    allowSelf: false,
    capacityAvailable: true,
    tags: ['normal'],
  },
  {
    senderId: 'agent-a',
    targetId: 'agent-b',
    channel: 'review',
    message: 'terminal delivery',
    runState: 'done',
    isDirect: true,
    isPaused: false,
    allowSelf: false,
    capacityAvailable: true,
    tags: ['normal'],
  },
  {
    senderId: 'agent-a',
    targetId: 'agent-a',
    channel: 'coding',
    message: 'self delivery',
    runState: 'running',
    isDirect: true,
    isPaused: false,
    allowSelf: false,
    capacityAvailable: true,
    tags: ['normal'],
  },
  {
    senderId: 'agent-a',
    targetId: 'agent-b',
    channel: 'review',
    message: 'capacity delivery',
    runState: 'running',
    isDirect: false,
    isPaused: false,
    allowSelf: false,
    capacityAvailable: false,
    tags: ['normal', 'batch'],
  },
  {
    senderId: 'agent-a',
    targetId: 'agent-b',
    channel: 'review',
    message: 'urgent delivery',
    runState: 'running',
    isDirect: true,
    isPaused: false,
    allowSelf: false,
    capacityAvailable: true,
    tags: ['urgent', 'operator'],
  },
  {
    senderId: 'agent-a',
    targetId: 'agent-b',
    channel: 'review',
    message: 'ordinary delivery',
    runState: 'running',
    isDirect: false,
    isPaused: false,
    allowSelf: false,
    capacityAvailable: true,
    tags: ['normal'],
  },
];

const saveSessionId = 'session-bench';
const saveMessages: readonly SDKMessage[] = [
  {
    type: 'user',
    message: { content: [{ type: 'text', text: 'hello' }] },
    parent_tool_use_id: null,
    uuid: 'u-1',
  } as unknown as SDKMessage,
  {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }] },
    parent_tool_use_id: null,
    uuid: 'u-2',
  } as unknown as SDKMessage,
  {
    type: 'result',
    subtype: 'success',
    parent_tool_use_id: null,
    uuid: 'u-3',
  } as unknown as SDKMessage,
];

const saveDeps: SaveState['deps'] = { save: () => ({ dbId: generateUUID() }) };

const saveInputs: readonly SaveState[] = saveMessages.map((message) => ({
  sessionId: saveSessionId,
  message,
  deps: saveDeps,
}));

const insertTimestamp = new Date().toISOString();
const INSERT_ROW_COUNT = Math.max(INSERT_ITERATIONS, INSERT_WARMUP_ITERATIONS);
const insertRows: readonly InsertRow[] = Array.from({ length: INSERT_ROW_COUNT }, (_, index) => {
  const message = saveMessages[index % saveMessages.length];
  const sdkUuid = `u-${index}`;
  const sdkMessage = { ...message, uuid: sdkUuid } as unknown as SDKMessage;
  const admission = decideMessageAdmission(normalizeMessageAdmissionInput(sdkMessage), {
    variant: 'sdk',
    sendStatus: null,
  });
  return {
    id: `${index}-${saveSessionId}`,
    sessionId: saveSessionId,
    messageType: sdkMessage.type,
    messageSubtype: (sdkMessage as { subtype?: string }).subtype ?? null,
    sdkMessage: JSON.stringify(sdkMessage),
    isRenderable: admission.isRenderable,
    isTerminal: admission.isTerminal,
    parentToolUseId: admission.parentToolUseId,
    sdkUuid: admission.sdkUuid,
  };
});

const decide = (ctx: RouterContext, decision: RouterDecision): RouterContext => ({
  ...ctx,
  decision,
});

const gates: ReadonlyArray<(ctx: RouterContext) => RouterContext> = [
  (ctx) => (ctx.isPaused ? decide(ctx, 'defer') : ctx),
  (ctx) => (ctx.runState === 'done' ? decide(ctx, 'reject') : ctx),
  (ctx) => (ctx.senderId === ctx.targetId && !ctx.allowSelf ? decide(ctx, 'deny-self') : ctx),
  (ctx) => (!ctx.capacityAvailable ? decide(ctx, 'queue') : ctx),
  (ctx) => (ctx.isDirect && ctx.tags.includes('urgent') ? decide(ctx, 'prioritize') : ctx),
  (ctx) => (ctx.channel.length > 0 && ctx.message.length > 0 ? decide(ctx, 'route') : ctx),
];

const runDecisionPipeline = decisionRun<RouterContext>('router-benchmark', gates);

function runIfCascade(input: RouterInput): RouterContext {
  const ctx: RouterContext = { ...input, decision: null };
  if (ctx.isPaused) return decide(ctx, 'defer');
  if (ctx.runState === 'done') return decide(ctx, 'reject');
  if (ctx.senderId === ctx.targetId && !ctx.allowSelf) return decide(ctx, 'deny-self');
  if (!ctx.capacityAvailable) return decide(ctx, 'queue');
  if (ctx.isDirect && ctx.tags.includes('urgent')) return decide(ctx, 'prioritize');
  if (ctx.channel.length > 0 && ctx.message.length > 0) return decide(ctx, 'route');
  return ctx;
}

function snapshot(ctx: SaveState): SaveState {
  return { ...ctx, dbId: generateUUID() };
}

function admit(ctx: SaveState): SaveState {
  const admission = decideMessageAdmission(normalizeMessageAdmissionInput(ctx.message), {
    variant: 'sdk',
    sendStatus: null,
  });
  return { ...ctx, admission, badgeUpdate: planAdmissionBadgeUpdate(admission) };
}

function save(ctx: SaveState): SaveState {
  return { ...ctx, dbId: ctx.deps.save(ctx).dbId };
}

function publish(ctx: SaveState): SaveState {
  return ctx;
}

const runSavePipeline = (superpipe({})('save-benchmark') as PipelineAPI)
  .input(['ctx'])
  .pipe(snapshot, 'ctx', 'ctx')
  .pipe(admit, 'ctx', 'ctx')
  .pipe(save, 'ctx', 'ctx')
  .pipe(publish, 'ctx', 'ctx')
  .end('ctx') as (ctx: SaveState) => SaveState;

function runSaveDirect(ctx: SaveState): SaveState {
  return publish(save(admit(snapshot(ctx))));
}

function saveChecksum(ctx: SaveState): number {
  return (
    ctx.admission!.isRenderable +
    (ctx.admission!.isTerminal << 1) +
    (ctx.badgeUpdate!.kind === 'delta' ? 1 << 2 : 0)
  );
}

function setupInsert(): {
  db: typeof Database.prototype;
  dbPath: string;
  reset: () => void;
  run: (row: InsertRow) => number;
} {
  const dbPath = `${tmpdir()}/hyperneo-bench-${process.pid}-${Date.now()}.db`;
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  db.prepare(
    'INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, visible_message_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(saveSessionId, 'benchmark', insertTimestamp, insertTimestamp, 'active', '{}', '{}', 0);
  const insertStmt = db.prepare(
    'INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, origin, is_renderable, is_terminal, parent_tool_use_id, task_id, conversation_turn_index, sdk_uuid, replacement_metadata_normalized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const deleteStmt = db.prepare('DELETE FROM sdk_messages');
  const resetSessionStmt = db.prepare('UPDATE sessions SET visible_message_count = 0 WHERE id = ?');
  const insert = db.transaction((row: InsertRow) => {
    insertStmt.run(
      row.id,
      row.sessionId,
      row.messageType,
      row.messageSubtype,
      row.sdkMessage,
      insertTimestamp,
      null,
      row.isRenderable,
      row.isTerminal,
      row.parentToolUseId,
      null,
      null,
      row.sdkUuid,
      1
    );
    return 1;
  });
  return {
    db,
    dbPath,
    reset: () => {
      deleteStmt.run();
      resetSessionStmt.run(saveSessionId);
    },
    run: (row: InsertRow) => insert(row),
  };
}

function verifyEquivalentDecisions(): void {
  for (const input of inputs) {
    const pipelineDecision = runDecisionPipeline(input).decision;
    const cascadeDecision = runIfCascade(input).decision;
    if (pipelineDecision !== cascadeDecision) {
      throw new Error(
        `Benchmark variants disagreed for ${input.message}: ${pipelineDecision} !== ${cascadeDecision}`
      );
    }
  }
}

function runIterations<T>(
  inputs: readonly T[],
  run: (input: T) => number,
  iterations: number
): Measurement {
  let checksum = 0;
  const start = Bun.nanoseconds();
  for (let index = 0; index < iterations; index++) {
    checksum += run(inputs[index % inputs.length]);
  }
  return { nsPerOp: (Bun.nanoseconds() - start) / iterations, checksum };
}

function collectSample(variant: Variant): Sample {
  if (variant === 'decisionRun' || variant === 'if-cascade') {
    const run =
      variant === 'decisionRun'
        ? (input: RouterInput) => runDecisionPipeline(input).decision?.charCodeAt(0) ?? 0
        : (input: RouterInput) => runIfCascade(input).decision?.charCodeAt(0) ?? 0;
    const cold = runIterations(inputs, run, ITERATIONS);
    runIterations(inputs, run, WARMUP_ITERATIONS);
    const warm = runIterations(inputs, run, ITERATIONS);
    return { cold, warm };
  }
  if (variant === 'save-pipeline' || variant === 'save-direct') {
    const runSave = variant === 'save-pipeline' ? runSavePipeline : runSaveDirect;
    const run = (input: SaveState) => saveChecksum(runSave(input));
    const cold = runIterations(saveInputs, run, ITERATIONS);
    runIterations(saveInputs, run, WARMUP_ITERATIONS);
    const warm = runIterations(saveInputs, run, ITERATIONS);
    return { cold, warm };
  }
  if (variant === 'sqlite-insert') {
    const { db, dbPath, reset, run } = setupInsert();
    reset();
    const cold = runIterations(insertRows.slice(0, INSERT_ITERATIONS), run, INSERT_ITERATIONS);
    reset();
    runIterations(insertRows.slice(0, INSERT_WARMUP_ITERATIONS), run, INSERT_WARMUP_ITERATIONS);
    reset();
    const warm = runIterations(insertRows.slice(0, INSERT_ITERATIONS), run, INSERT_ITERATIONS);
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
    return { cold, warm };
  }
  throw new Error(`Unknown variant: ${variant}`);
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
    `${variant.padEnd(14)} ${formatValues(cold).padStart(50)} ${formatValues(warm).padStart(50)}`
  );
}

const variantIndex = process.argv.indexOf('--variant');
const variant = variantIndex === -1 ? undefined : (process.argv[variantIndex + 1] as Variant);

if (
  variant === 'decisionRun' ||
  variant === 'if-cascade' ||
  variant === 'save-pipeline' ||
  variant === 'save-direct' ||
  variant === 'sqlite-insert'
) {
  process.stdout.write(JSON.stringify(collectSample(variant)));
} else if (variant !== undefined) {
  throw new Error(`Unknown variant: ${variant}`);
} else {
  const decisionSamples = Array.from({ length: SAMPLES }, () => runChild('decisionRun'));
  const cascadeSamples = Array.from({ length: SAMPLES }, () => runChild('if-cascade'));
  const savePipelineSamples = Array.from({ length: SAMPLES }, () => runChild('save-pipeline'));
  const saveDirectSamples = Array.from({ length: SAMPLES }, () => runChild('save-direct'));
  const insertSamples = Array.from({ length: SAMPLES }, () => runChild('sqlite-insert'));
  verifyEquivalentDecisions();

  const decisionChecksums = [...decisionSamples, ...cascadeSamples].flatMap((sample) => [
    sample.cold.checksum,
    sample.warm.checksum,
  ]);
  if (!decisionChecksums.every((checksum) => checksum === decisionChecksums[0])) {
    throw new Error('Benchmark samples produced inconsistent checksums');
  }

  const saveChecksums = [...savePipelineSamples, ...saveDirectSamples].flatMap((sample) => [
    sample.cold.checksum,
    sample.warm.checksum,
  ]);
  if (!saveChecksums.every((checksum) => checksum === saveChecksums[0])) {
    throw new Error('Save benchmark samples produced inconsistent checksums');
  }

  log(
    `Bun ${Bun.version}; ${process.platform} ${process.arch}; ${cpus()[0]?.model ?? 'unknown CPU'}`
  );
  log(`${ITERATIONS.toLocaleString()} measured iterations; ${SAMPLES} fresh processes per variant`);
  log(
    `${INSERT_ITERATIONS.toLocaleString()} insert iterations; ${INSERT_WARMUP_ITERATIONS.toLocaleString()} insert warmup\n`
  );
  log('variant           cold ns/op: median [samples]   warm ns/op: median [samples]');
  summarize('decisionRun', decisionSamples);
  summarize('if-cascade', cascadeSamples);
  summarize('save-pipeline', savePipelineSamples);
  summarize('save-direct', saveDirectSamples);
  summarize('sqlite-insert', insertSamples);

  const saveOverheadCold =
    median(savePipelineSamples.map((sample) => sample.cold.nsPerOp)) -
    median(saveDirectSamples.map((sample) => sample.cold.nsPerOp));
  const saveOverheadWarm =
    median(savePipelineSamples.map((sample) => sample.warm.nsPerOp)) -
    median(saveDirectSamples.map((sample) => sample.warm.nsPerOp));
  const insertCold = median(insertSamples.map((sample) => sample.cold.nsPerOp));
  const insertWarm = median(insertSamples.map((sample) => sample.warm.nsPerOp));
  log('');
  log(
    `save-pipeline overhead (cold): ${saveOverheadCold.toFixed(1)} ns/op; insert (cold): ${insertCold.toFixed(1)} ns/op; ratio: ${((saveOverheadCold / insertCold) * 100).toFixed(1)}%`
  );
  log(
    `save-pipeline overhead (warm): ${saveOverheadWarm.toFixed(1)} ns/op; insert (warm): ${insertWarm.toFixed(1)} ns/op; ratio: ${((saveOverheadWarm / insertWarm) * 100).toFixed(1)}%`
  );
}
