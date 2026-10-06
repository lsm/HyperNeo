import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { type RouteBackend, sdkLlmBackend, systemOneBackend } from './backends.ts';
import type { EvalCase, EvalResult } from './types.ts';

const HERE = dirname(new URL(import.meta.url).pathname);

const { values } = parseArgs({
  options: {
    backend: { type: 'string' },
    url: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string', default: 'anthropic' },
    prompt: { type: 'string', default: 'context' },
    shape: { type: 'string', default: 'deployed' },
    cases: { type: 'string', default: 'synthetic,real' },
    out: { type: 'string' },
    warmup: { type: 'string', default: '2' },
    limit: { type: 'string' },
    'reverse-options': { type: 'boolean', default: false },
  },
});

function loadCases(names: string): EvalCase[] {
  return names.split(',').flatMap((name) => {
    try {
      return JSON.parse(readFileSync(join(HERE, 'cases', `${name}.json`), 'utf8')) as EvalCase[];
    } catch (error) {
      console.error(`skipping cases/${name}.json: ${error}`);
      return [];
    }
  });
}

function pickBackend(): RouteBackend {
  if (values.backend === 'systemone') {
    if (!values.url) throw new Error('--url is required for the systemone backend');
    return systemOneBackend(values.url, values.model, values['reverse-options']);
  }
  if (values.backend === 'sdk') {
    const providers = ['anthropic', 'glm', 'glm-flash', 'deepseek', 'codex'] as const;
    const provider = providers.find((name) => name === values.provider) ?? 'anthropic';
    return sdkLlmBackend(
      provider,
      values.prompt === 'message-only' ? 'message-only' : 'context',
      values.shape === 'lean' ? 'lean' : 'deployed'
    );
  }
  throw new Error('--backend must be systemone or sdk');
}

async function main(): Promise<void> {
  if (!values.out) throw new Error('--out is required');
  const backend = pickBackend();
  const all = loadCases(values.cases ?? 'synthetic');
  const cases = values.limit ? all.slice(0, Number(values.limit)) : all;
  for (const evalCase of cases.slice(0, Number(values.warmup))) {
    await backend(evalCase).catch(() => undefined);
  }
  const results: EvalResult[] = [];
  for (const evalCase of cases) {
    const started = performance.now();
    let result: EvalResult;
    try {
      const outcome = await backend(evalCase);
      result = {
        caseId: evalCase.id,
        kind: evalCase.kind,
        source: evalCase.source,
        followUp: evalCase.followUp,
        expected: evalCase.expected,
        latencyMs: Math.round(performance.now() - started),
        ...outcome,
      };
    } catch (error) {
      result = {
        caseId: evalCase.id,
        kind: evalCase.kind,
        source: evalCase.source,
        followUp: evalCase.followUp,
        expected: evalCase.expected,
        predicted: 'main',
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(result);
    const mark = result.expected.includes(result.predicted) ? 'ok ' : 'MISS';
    console.log(`${mark} ${result.caseId} → ${result.predicted} (${result.latencyMs} ms)`);
  }
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, results.map((result) => JSON.stringify(result)).join('\n') + '\n');
  process.exit(0);
}

await main();
