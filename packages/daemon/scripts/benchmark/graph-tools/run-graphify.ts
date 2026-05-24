/**
 * Graphify benchmark arm.
 *
 * Usage:
 *   bun scripts/benchmark/graph-tools/run-graphify.ts
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  BENCHMARK_PROMPT_UNSEDED,
  runWithGlm,
  writeBenchmarkResults,
  resolveCommitSha,
  WORKTREE,
  BENCHMARK_MODEL,
} from './benchmark-helpers';

const GRAPHIFY_OUT =
  process.env.NEOKAI_BENCHMARK_GRAPHIFY_OUT ||
  `/tmp/neokai-benchmark-graphify/${createHash('sha256').update(WORKTREE).digest('hex')}`;
const GRAPHIFY_BIN = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BIN || 'graphify';
const GRAPHIFY_BACKEND = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BACKEND || 'ollama';
const GRAPHIFY_PYTHON =
  process.env.NEOKAI_BENCHMARK_GRAPHIFY_PYTHON ||
  '/Users/lsm/.local/share/uv/tools/graphifyy/bin/python';

function setupGraphify(): boolean {
  const graphJson = join(GRAPHIFY_OUT, 'graphify-out', 'graph.json');

  if (existsSync(graphJson)) {
    console.log('  Graphify graph found, skipping extraction');
    return true;
  }

  console.log('Extracting Graphify graph...');
  const start = Date.now();
  mkdirSync(GRAPHIFY_OUT, { recursive: true });
  let p: Bun.SpawnSyncResult<Buffer>;
  try {
    p = Bun.spawnSync(
      [
        GRAPHIFY_BIN,
        'extract',
        WORKTREE,
        '--out',
        GRAPHIFY_OUT,
        '--no-cluster',
        '--backend',
        GRAPHIFY_BACKEND,
      ],
      { timeout: 300_000, stdout: 'pipe', stderr: 'pipe' }
    );
  } catch (err) {
    console.error('  Graphify extraction skipped (executable not found):', (err as Error).message);
    return false;
  }
  const elapsed = Date.now() - start;
  if (p.exitCode === 0 && existsSync(graphJson)) {
    console.log(`  Graphify graph extracted in ${(elapsed / 1000).toFixed(1)}s`);
    return true;
  }
  console.error(
    '  Graphify extraction failed (exit=' + p.exitCode + '):',
    p.stderr?.toString()?.slice(0, 500)
  );
  return false;
}

async function main() {
  if (!setupGraphify()) {
    console.error('Graphify graph not available, aborting.');
    process.exit(1);
  }

  const graphJson = join(GRAPHIFY_OUT, 'graphify-out', 'graph.json');

  console.log('Running Graphify arm');
  const start = Date.now();
  const result = await runWithGlm({
    name: 'Graphify',
    prompt: BENCHMARK_PROMPT_UNSEDED,
    tools: [],
    allowedTools: ['mcp__graphify__*'],
    mcpServers: {
      graphify: {
        command: GRAPHIFY_PYTHON,
        args: ['-m', 'graphify.serve', graphJson],
      },
    },
  });
  console.log(`  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  Tokens: ${result.totalTokens} | Tool calls: ${result.toolCallCount}`);
  console.log(`  Response: ${result.responseLength} chars`);

  const path = '/tmp/graph-tool-benchmark-graphify.json';
  writeBenchmarkResults([result], WORKTREE, path, resolveCommitSha(), BENCHMARK_MODEL);
  console.log(`  Results written to ${path}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
