import {
  BENCHMARK_PROMPT_UNSEDED,
  runWithGlm,
  writeBenchmarkResults,
  resolveCommitSha,
  WORKTREE,
  BENCHMARK_MODEL,
} from './benchmark-helpers';

async function main() {
  console.log('Running baseline: built-in Read/Grep/Glob only');
  const start = Date.now();
  const result = await runWithGlm({
    name: 'baseline: built-in Read/Grep/Glob only',
    prompt: BENCHMARK_PROMPT_UNSEDED,
    tools: ['Read', 'Grep', 'Glob'],
  });
  console.log(`  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  Tokens: ${result.totalTokens} | Tool calls: ${result.toolCallCount}`);
  console.log(`  Response: ${result.responseLength} chars`);

  const path = `/tmp/graph-tool-benchmark-baseline.json`;
  writeBenchmarkResults([result], WORKTREE, path, resolveCommitSha(), BENCHMARK_MODEL);
  console.log(`  Results written to ${path}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
