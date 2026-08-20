import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';

import { decisionRun } from '../../src/lib/space/runtime/decision-pipeline.ts';

const ITERATIONS = 100_000;
const WARMUP_ITERATIONS = 1_000_000;
const SAMPLES = 5;
const log = (message: string): void => process.stdout.write(`${message}\n`);

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
type Variant = 'decisionRun' | 'if-cascade';

type Measurement = {
  nsPerOp: number;
  checksum: number;
};

type Sample = {
  cold: Measurement;
  warm: Measurement;
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

function runIterations(
  run: (input: RouterInput) => RouterContext,
  iterations: number
): Measurement {
  let checksum = 0;
  const start = Bun.nanoseconds();
  for (let index = 0; index < iterations; index++) {
    const decision = run(inputs[index % inputs.length]).decision;
    checksum += decision?.charCodeAt(0) ?? 0;
  }
  return { nsPerOp: (Bun.nanoseconds() - start) / iterations, checksum };
}

function collectSample(variant: Variant): Sample {
  const run = variant === 'decisionRun' ? runDecisionPipeline : runIfCascade;
  const cold = runIterations(run, ITERATIONS);
  runIterations(run, WARMUP_ITERATIONS);
  const warm = runIterations(run, ITERATIONS);
  return { cold, warm };
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
    `${variant.padEnd(12)} ${formatValues(cold).padStart(52)} ${formatValues(warm).padStart(52)}`
  );
}

const variantIndex = process.argv.indexOf('--variant');
const variant = process.argv[variantIndex + 1] as Variant | undefined;

if (variant === 'decisionRun' || variant === 'if-cascade') {
  process.stdout.write(JSON.stringify(collectSample(variant)));
} else {
  const decisionSamples = Array.from({ length: SAMPLES }, () => runChild('decisionRun'));
  const cascadeSamples = Array.from({ length: SAMPLES }, () => runChild('if-cascade'));
  const coldChecksums = [...decisionSamples, ...cascadeSamples].map(
    (sample) => sample.cold.checksum
  );
  const warmChecksums = [...decisionSamples, ...cascadeSamples].map(
    (sample) => sample.warm.checksum
  );
  if (
    !coldChecksums.every((checksum) => checksum === coldChecksums[0]) ||
    !warmChecksums.every((checksum) => checksum === warmChecksums[0])
  ) {
    throw new Error('Benchmark variants produced different decisions');
  }

  log(
    `Bun ${Bun.version}; ${process.platform} ${process.arch}; ${cpus()[0]?.model ?? 'unknown CPU'}`
  );
  log(`${ITERATIONS.toLocaleString()} measured iterations; ${SAMPLES} fresh processes per variant`);
  log(`${WARMUP_ITERATIONS.toLocaleString()} iterations before each warm measurement\n`);
  log(
    'variant                         cold ns/op: median [samples]   warm ns/op: median [samples]'
  );
  summarize('decisionRun', decisionSamples);
  summarize('if-cascade', cascadeSamples);
}
