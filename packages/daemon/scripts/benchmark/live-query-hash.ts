import { cpus } from 'node:os';

import { hashRows } from '../../src/storage/live-query';

const WINDOW = 200;
const ITERATIONS = 100;
const WARMUP_ITERATIONS = 300;
const SAMPLES = 5;
const log = (message: string): void => process.stdout.write(`${message}\n`);

type Variant = 'full' | 'fingerprint';

type Measurement = {
  nsPerOp: number;
  checksum: number;
};

type Sample = {
  cold: Measurement;
  warm: Measurement;
};

function buildContent(seed: number, kb: number): string {
  const chunk = `"tool_result chunk ${seed} with enough payload to mimic a rendered message: ${'x'.repeat(256)}"`;
  return `{"type":"assistant","uuid":"u-${seed}","message":{"content":[{"type":"text","text":${chunk.repeat(
    Math.max(1, Math.ceil((kb * 1024) / chunk.length))
  )}}]}}`;
}

function buildRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < WINDOW; index++) {
    const kb = index % 10 === 0 ? 64 : 8 + (index % 5) * 4;
    rows.push({
      id: `msg-${index}`,
      content: buildContent(index, kb),
      timestamp: 1_700_000_000_000 + index,
      sendStatus: index % 3 === 0 ? 'consumed' : index % 3 === 1 ? 'processing' : 'deferred',
      origin: index % 2 === 0 ? 'human' : 'system',
      rowid: index + 1,
      deliveryRetryInfo: index % 7 === 0 ? `{"count":${index % 3},"runAt":1,"max":8}` : null,
    });
  }
  return rows;
}

const fingerprint = (row: Record<string, unknown>): Record<string, unknown> => ({
  content: typeof row.content === 'string' ? row.content.length : row.content,
  timestamp: row.timestamp,
  sendStatus: row.sendStatus,
  origin: row.origin,
  rowid: row.rowid,
  deliveryRetryInfo: row.deliveryRetryInfo,
});

const rows = buildRows();

function verifyDetection(): void {
  const full = hashRows(rows);
  const light = hashRows(rows, fingerprint);
  if (hashRows(rows).hash !== full.hash) {
    throw new Error('Full hash is not deterministic on the unchanged window');
  }
  if (hashRows(rows, fingerprint).hash !== light.hash) {
    throw new Error('Fingerprint hash is not deterministic on the unchanged window');
  }
  const contentEdited = rows.map((row, index) =>
    index === 0 ? { ...row, content: `${row.content} "edited"` } : row
  );
  if (hashRows(contentEdited).hash === full.hash) {
    throw new Error('Full hash failed to detect a content rewrite');
  }
  if (hashRows(contentEdited, fingerprint).hash === light.hash) {
    throw new Error('Fingerprint hash failed to detect a content rewrite');
  }
  const statusFlipped = rows.map((row, index) =>
    index === 0 ? { ...row, sendStatus: 'failed' } : row
  );
  if (hashRows(statusFlipped).hash === full.hash) {
    throw new Error('Full hash failed to detect a sendStatus flip');
  }
  if (hashRows(statusFlipped, fingerprint).hash === light.hash) {
    throw new Error('Fingerprint hash failed to detect a sendStatus flip');
  }
}

function runIterations(variant: Variant, iterations: number): Measurement {
  let checksum = 0;
  const run = variant === 'full' ? () => hashRows(rows) : () => hashRows(rows, fingerprint);
  const start = Bun.nanoseconds();
  for (let index = 0; index < iterations; index++) {
    const snapshot = run();
    checksum += snapshot.hash;
    checksum += snapshot.rowHashes?.size ?? 0;
  }
  return { nsPerOp: (Bun.nanoseconds() - start) / iterations, checksum };
}

function collectSample(variant: Variant): Sample {
  const cold = runIterations(variant, ITERATIONS);
  runIterations(variant, WARMUP_ITERATIONS);
  const warm = runIterations(variant, ITERATIONS);
  return { cold, warm };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function formatValues(values: readonly number[]): string {
  return `${median(values).toFixed(1)} [${values.map((value) => value.toFixed(1)).join(', ')}]`;
}

function summarize(variant: Variant, samples: readonly Sample[]): void {
  const cold = samples.map((sample) => sample.cold.nsPerOp);
  const warm = samples.map((sample) => sample.warm.nsPerOp);
  log(
    `${variant.padEnd(12)} ${formatValues(cold).padStart(52)} ${formatValues(warm).padStart(52)}`
  );
}

verifyDetection();
const fullSamples = Array.from({ length: SAMPLES }, () => collectSample('full'));
const fingerprintSamples = Array.from({ length: SAMPLES }, () => collectSample('fingerprint'));

const totalContentBytes = rows.reduce((sum, row) => sum + String(row.content).length, 0);
log(
  `Bun ${Bun.version}; ${process.platform} ${process.arch}; ${cpus()[0]?.model ?? 'unknown CPU'}`
);
log(
  `${WINDOW}-row window; ~${Math.round(totalContentBytes / 1024)} KiB total payload; ${ITERATIONS.toLocaleString()} measured iterations; ${SAMPLES} samples per variant`
);
log(`${WARMUP_ITERATIONS.toLocaleString()} iterations before each warm measurement\n`);
log('variant                         cold ns/op: median [samples]   warm ns/op: median [samples]');
summarize('full', fullSamples);
summarize('fingerprint', fingerprintSamples);
