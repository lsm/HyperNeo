/**
 * Graph Tool Benchmark — Agent Session Integration Test
 *
 * Compares CodeGraph, code-review-graph, Graphify, and ast-grep against a plain
 * GLM baseline for task #394 ("Refactor task event source as Layer-2 anti-stuck
 * mechanism"). Uses real NeoKai daemon sessions with MCP tool servers attached.
 *
 * REQUIREMENTS:
 *   - GLM_API_KEY or ZHIPU_API_KEY must be set
 *   - npx, uvx, and python available in PATH
 *
 * Run:
 *   cd docs/reports/graph-tool-benchmark
 *   GLM_API_KEY=xxx bun test benchmark-graph-tools.test.ts
 *
 * Run single case:
 *   bun test -t 'CodeGraph' benchmark-graph-tools.test.ts
 *
 * This entire suite is `describe.skip` by default — it makes real API calls,
 * takes 10-20 minutes, and requires manual opt-in.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	BENCHMARK_PROMPT_UNSEDED,
	BENCHMARK_PROMPT_TEXT_ONLY,
	runBenchmarkCase,
	writeBenchmarkResults,
	makeAstGrepMcpServerScript,
	type BenchmarkResult,
} from './benchmark-helpers';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKTREE =
	process.env.NEOKAI_BENCHMARK_WORKTREE ||
	// Default: the repo root (5 levels up from this file's directory)
	join(import.meta.dir, '..', '..', '..', '..', '..');

const CRG_DATA_DIR = process.env.NEOKAI_BENCHMARK_CRG_DATA || '/tmp/neokai-benchmark-crg';
const GRAPHIFY_OUT =
	process.env.NEOKAI_BENCHMARK_GRAPHIFY_OUT || '/tmp/neokai-benchmark-graphify/graphify-out';

const CRG_TOOLS =
	'get_minimal_context_tool,get_review_context_tool,get_impact_radius_tool,query_graph_tool,semantic_search_nodes_tool,list_graph_stats_tool,detect_changes_tool';

const RESULTS_PATH = '/tmp/graph-tool-benchmark-results.json';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let daemon: DaemonServerContext;
const results: BenchmarkResult[] = [];

// Tool readiness flags
let codegraphReady = false;
let crgReady = false;
let graphifyReady = false;
let astGrepServerPath: string | null = null;

// ---------------------------------------------------------------------------
// Tool setup helpers
// ---------------------------------------------------------------------------

async function buildCodeGraph() {
	console.log('Building CodeGraph index...');
	const start = Date.now();
	const p = Bun.spawnSync(['npx', '-y', '@colbymchenry/codegraph', 'init', WORKTREE, '-i'], {
		timeout: 120_000,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const elapsed = Date.now() - start;
	if (p.exitCode === 0) {
		codegraphReady = true;
		console.log(`  CodeGraph index built in ${(elapsed / 1000).toFixed(1)}s`);
	} else {
		console.error('  CodeGraph build failed:', p.stderr?.toString()?.slice(0, 500));
	}
}

async function buildCRG() {
	console.log('Building code-review-graph...');
	const start = Date.now();
	const p = Bun.spawnSync(
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
	const elapsed = Date.now() - start;
	if (p.exitCode === 0) {
		crgReady = true;
		console.log(`  CRG graph built in ${(elapsed / 1000).toFixed(1)}s`);
	} else {
		console.error('  CRG build failed:', p.stderr?.toString()?.slice(0, 500));
	}
}

async function setupGraphify() {
	const graphJson = join(GRAPHIFY_OUT, 'graph.json');
	if (existsSync(graphJson)) {
		graphifyReady = true;
		console.log('  Graphify graph already exists, skipping extraction');
		return;
	}
	console.log('Extracting Graphify graph...');
	const start = Date.now();
	mkdirSync(GRAPHIFY_OUT, { recursive: true });
	const p = Bun.spawnSync(
		['graphify', 'extract', WORKTREE, '--out', GRAPHIFY_OUT, '--no-cluster', '--backend', 'ollama'],
		{ timeout: 300_000, stdout: 'pipe', stderr: 'pipe' }
	);
	const elapsed = Date.now() - start;
	if (existsSync(graphJson)) {
		graphifyReady = true;
		console.log(`  Graphify graph extracted in ${(elapsed / 1000).toFixed(1)}s`);
	} else {
		console.error('  Graphify extraction failed:', p.stderr?.toString()?.slice(0, 500));
	}
}

function setupAstGrep() {
	const script = makeAstGrepMcpServerScript(WORKTREE);
	const tmpPath = join(tmpdir(), 'ast-grep-mcp-server.js');
	writeFileSync(tmpPath, script);
	astGrepServerPath = tmpPath;
	console.log(`  ast-grep MCP server wrapper written to ${tmpPath}`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

// Toggle: set to true to enable benchmark (makes real API calls, 10-20 min)
const ENABLE_BENCHMARK = process.env.NEOKAI_BENCHMARK_RUN === '1';
const describeSkip = ENABLE_BENCHMARK ? describe : describe.skip;

describeSkip('Graph Tool Benchmark', () => {
	beforeAll(async () => {
		// Validate credentials
		if (!process.env.GLM_API_KEY && !process.env.ZHIPU_API_KEY) {
			throw new Error('GLM_API_KEY or ZHIPU_API_KEY must be set');
		}

		console.log(`Worktree: ${WORKTREE}`);

		// Build tool indexes BEFORE daemon start (avoids transport PONG timeout
		// during long index builds — default pongTimeout is 45s, builds take ~100s)
		console.log('Building tool indexes...');
		await Promise.allSettled([buildCodeGraph(), buildCRG(), setupGraphify()]);
		setupAstGrep();

		// Start daemon AFTER indexes are ready
		console.log('Starting daemon...');
		daemon = await createDaemonServer();
		console.log('Daemon started.');
	}, 420_000);

	afterAll(async () => {
		// Write results
		if (results.length > 0) {
			const path = writeBenchmarkResults(results, WORKTREE, RESULTS_PATH);
			console.log(`\nResults written to ${path}`);
			// Print summary table
			console.log('\n=== Benchmark Summary ===');
			console.log(
				'Case'.padEnd(40) + 'Wall(s)'.padStart(8) + 'Tokens'.padStart(10) + 'Tools'.padStart(8)
			);
			for (const r of results) {
				console.log(
					r.caseName.padEnd(40) +
						(r.wallTimeMs / 1000).toFixed(1).padStart(8) +
						String(r.totalTokens).padStart(10) +
						String(r.toolCallCount).padStart(8)
				);
			}
		}

		// Tear down daemon
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 30_000);

	// -----------------------------------------------------------------------
	// Unseeded round
	// -----------------------------------------------------------------------

	test('baseline: plain GLM', async () => {
		const result = await runBenchmarkCase(daemon, {
			name: 'baseline: plain GLM (text-only)',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_TEXT_ONLY,
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('CodeGraph', async () => {
		if (!codegraphReady) return;
		const result = await runBenchmarkCase(daemon, {
			name: 'CodeGraph',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_TEXT_ONLY,
			mcpServers: {
				codegraph: {
					command: 'npx',
					args: ['-y', '@colbymchenry/codegraph', 'mcp'],
				},
			},
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('code-review-graph', async () => {
		if (!crgReady) return;
		const result = await runBenchmarkCase(daemon, {
			name: 'code-review-graph',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_TEXT_ONLY,
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
						'--data-dir',
						CRG_DATA_DIR,
						'--tools',
						CRG_TOOLS,
					],
				},
			},
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('Graphify', async () => {
		if (!graphifyReady) return;
		const result = await runBenchmarkCase(daemon, {
			name: 'Graphify',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_TEXT_ONLY,
			mcpServers: {
				graphify: {
					command: 'python',
					args: ['-m', 'graphify.serve', join(GRAPHIFY_OUT, 'graph.json')],
				},
			},
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('ast-grep', async () => {
		if (!astGrepServerPath) return;
		const result = await runBenchmarkCase(daemon, {
			name: 'ast-grep',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_TEXT_ONLY,
			mcpServers: {
				'ast-grep': {
					command: 'node',
					args: [astGrepServerPath],
				},
			},
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	// -----------------------------------------------------------------------
	// Mixed round SKIPPED — GLM's tool_use responses are incompatible with
	// the Claude Agent SDK's internal context-fetcher.  Multi-step tool use
	// (built-in + MCP) causes the session to hang.  Single-tool MCP sessions
	// (the unseeded round above) work reliably.  The mixed round requires an
	// Anthropic model or a fix to the SDK's context-fetcher for non-Anthropic
	// providers.
	// -----------------------------------------------------------------------
});
