/**
 * CodeGraph benchmark arm.
 *
 * Usage:
 *   bun scripts/benchmark/graph-tools/run-codegraph.ts
 */

import {
  BENCHMARK_PROMPT_UNSEDED,
  runWithGlm,
  writeBenchmarkResults,
  resolveCommitSha,
  WORKTREE,
  BENCHMARK_MODEL,
} from './benchmark-helpers';

function buildCodeGraphIndex(): boolean {
  console.log('Building CodeGraph index...');
  const start = Date.now();
  let p: Bun.SpawnSyncResult<Buffer>;
  try {
    p = Bun.spawnSync(['npx', '-y', '@colbymchenry/codegraph', 'init', WORKTREE, '-i'], {
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    console.error('  CodeGraph build skipped (executable not found):', (err as Error).message);
    return false;
  }
  const elapsed = Date.now() - start;
  if (p.exitCode === 0) {
    console.log(`  CodeGraph index built in ${(elapsed / 1000).toFixed(1)}s`);
    return true;
  }
  console.error('  CodeGraph build failed:', p.stderr?.toString()?.slice(0, 500));
  return false;
}

async function main() {
  if (!buildCodeGraphIndex()) {
    console.error('CodeGraph index not available, aborting.');
    process.exit(1);
  }

  console.log('Running CodeGraph arm');
  const start = Date.now();
  const result = await runWithGlm({
    name: 'CodeGraph',
    prompt: BENCHMARK_PROMPT_UNSEDED,
    tools: [],
    allowedTools: ['mcp__codegraph__*'],
    mcpServers: {
      codegraph: {
        command: 'npx',
        args: ['-y', '@colbymchenry/codegraph', 'mcp'],
      },
    },
  });
  console.log(`  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  Tokens: ${result.totalTokens} | Tool calls: ${result.toolCallCount}`);
  console.log(`  Response: ${result.responseLength} chars`);

  const path = '/tmp/graph-tool-benchmark-codegraph.json';
  writeBenchmarkResults([result], WORKTREE, path, resolveCommitSha(), BENCHMARK_MODEL);
  console.log(`  Results written to ${path}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
