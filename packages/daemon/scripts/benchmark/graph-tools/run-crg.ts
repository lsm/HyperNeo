import {
  BENCHMARK_PROMPT_UNSEDED,
  runWithGlm,
  writeBenchmarkResults,
  resolveCommitSha,
  WORKTREE,
  BENCHMARK_MODEL,
} from './benchmark-helpers';

const CRG_DATA_DIR = process.env.HYPERNEO_BENCHMARK_CRG_DATA || '/tmp/hyperneo-benchmark-crg';
const CRG_TOOLS =
  'get_minimal_context_tool,get_review_context_tool,get_impact_radius_tool,query_graph_tool,semantic_search_nodes_tool,list_graph_stats_tool,detect_changes_tool';

function buildCrgGraph(): boolean {
  console.log('Building code-review-graph...');
  const start = Date.now();
  let p: Bun.SpawnSyncResult<Buffer>;
  try {
    p = Bun.spawnSync(
      [
        'uvx',
        '--from',
        'code-review-graph',
        'code-review-graph',
        'build',
        '--repo',
        WORKTREE,
        '--data-dir',
        CRG_DATA_DIR,
      ],
      { timeout: 300_000, stdout: 'pipe', stderr: 'pipe' }
    );
  } catch (err) {
    console.error('  CRG build skipped (executable not found):', (err as Error).message);
    return false;
  }
  const elapsed = Date.now() - start;
  if (p.exitCode === 0) {
    console.log(`  CRG graph built in ${(elapsed / 1000).toFixed(1)}s`);
    return true;
  }
  console.error('  CRG build failed:', p.stderr?.toString()?.slice(0, 500));
  return false;
}

async function main() {
  if (!buildCrgGraph()) {
    console.error('CRG graph not available, aborting.');
    process.exit(1);
  }

  console.log('Running code-review-graph arm');
  const start = Date.now();
  const result = await runWithGlm({
    name: 'code-review-graph',
    prompt: BENCHMARK_PROMPT_UNSEDED,
    tools: [],
    allowedTools: ['mcp__code-review-graph__*'],
    mcpServers: {
      'code-review-graph': {
        command: 'uvx',
        args: [
          '--from',
          'code-review-graph',
          'code-review-graph',
          'serve',
          '--repo',
          WORKTREE,
          '--tools',
          CRG_TOOLS,
        ],
        env: {
          CRG_DATA_DIR,
        },
      },
    },
  });
  console.log(`  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  Tokens: ${result.totalTokens} | Tool calls: ${result.toolCallCount}`);
  console.log(`  Response: ${result.responseLength} chars`);

  const path = '/tmp/graph-tool-benchmark-crg.json';
  writeBenchmarkResults([result], WORKTREE, path, resolveCommitSha(), BENCHMARK_MODEL);
  console.log(`  Results written to ${path}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
