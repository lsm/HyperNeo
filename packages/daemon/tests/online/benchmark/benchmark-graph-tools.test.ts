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
 *   cd packages/daemon
 *   NEOKAI_BENCHMARK_RUN=1 DB_PATH=/tmp/neokai-bench.db bun test tests/online/benchmark/benchmark-graph-tools.test.ts
 *
 * Run single case:
 *   bun test -t 'CodeGraph' tests/online/benchmark/benchmark-graph-tools.test.ts
 *
 * This entire suite is `describe.skip` by default — it makes real API calls,
 * takes 10-20 minutes, and requires manual opt-in via NEOKAI_BENCHMARK_RUN=1.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

// SHA-256 hex digest of worktree path — fixed 64-char length, collision-resistant
const GRAPHIFY_OUT =
	process.env.NEOKAI_BENCHMARK_GRAPHIFY_OUT ||
	`/tmp/neokai-benchmark-graphify/${createHash('sha256').update(WORKTREE).digest('hex')}`;

const CRG_TOOLS =
	'get_minimal_context_tool,get_review_context_tool,get_impact_radius_tool,query_graph_tool,semantic_search_nodes_tool,list_graph_stats_tool,detect_changes_tool';

// Built-in tools to disable in MCP-only benchmark arms to ensure isolation
const DISABLED_BUILTINS = [
	'Read',
	'Write',
	'Edit',
	'Bash',
	'Grep',
	'Glob',
	'WebFetch',
	'WebSearch',
	'Task',
	'TaskOutput',
	'TaskStop',
	'NotebookEdit',
	'TodoWrite',
	'AskUserQuestion',
	'EnterPlanMode',
	'ExitPlanMode',
	'Skill',
	'ToolSearch',
];

const RESULTS_PATH = '/tmp/graph-tool-benchmark-results.json';

// Defer heavy resolution until benchmark is enabled to avoid failing unrelated test runs
let COMMIT_SHA = '';
const GRAPHIFY_BIN = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BIN || 'graphify';
const GRAPHIFY_BACKEND = process.env.NEOKAI_BENCHMARK_GRAPHIFY_BACKEND || 'ollama';
let graphifyPython = 'python3';
let graphifyPythonArgs: string[] = [];

function resolveConfig() {
	COMMIT_SHA = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: WORKTREE }).trim();

	// Resolve Graphify python env (same executable used for extraction and MCP serve)
	// First resolve the binary path via PATH lookup, then read its shebang for the Python interpreter
	try {
		// Always try PATH resolution first — treat GRAPHIFY_BIN as a command name,
		// not a file path. Falls back to the literal value for absolute paths.
		let resolvedBin = GRAPHIFY_BIN;
		try {
			resolvedBin = execFileSync('which', [GRAPHIFY_BIN], { encoding: 'utf-8' }).trim();
		} catch {
			// Not on PATH — assume it's an absolute path
		}
		const shebang = readFileSync(resolvedBin, 'utf-8')
			.split('\n')[0]
			.replace(/^#!\s*/, '')
			.trim();
		if (shebang) {
			// Handle env-style shebangs: "#!/usr/bin/env python3" → command=env, args=[python3]
			// Direct shebangs: "#!/path/to/python3" → command=/path/to/python3, args=[]
			const parts = shebang.split(/\s+/);
			if (parts[0].endsWith('/env') && parts.length > 1) {
				graphifyPython = parts[0];
				graphifyPythonArgs = parts.slice(1);
			} else {
				graphifyPython = parts[0];
			}
		}
	} catch {
		// Fall back to python3
	}
}

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

	// Verify cache belongs to current worktree AND commit - rebuild if stale
	if (existsSync(graphJson) && existsSync(join(GRAPHIFY_OUT, '.benchmark_worktree'))) {
		const cachedWorktree = readFileSync(join(GRAPHIFY_OUT, '.benchmark_worktree'), 'utf-8').trim();
		const cachedCommit = existsSync(join(GRAPHIFY_OUT, '.benchmark_commit'))
			? readFileSync(join(GRAPHIFY_OUT, '.benchmark_commit'), 'utf-8').trim()
			: '';
		const cachedBackend = existsSync(join(GRAPHIFY_OUT, '.benchmark_backend'))
			? readFileSync(join(GRAPHIFY_OUT, '.benchmark_backend'), 'utf-8').trim()
			: '';
		if (cachedWorktree !== WORKTREE) {
			console.log('  Graphify graph is from a different worktree, forcing rebuild...');
		} else if (cachedCommit && cachedCommit === COMMIT_SHA && cachedBackend === GRAPHIFY_BACKEND) {
			// Same worktree and commit - keep cached graph
			graphifyReady = true;
			console.log('  Graphify graph already exists for this worktree@commit, skipping extraction');
			return;
		} else {
			console.log('  Graphify graph commit mismatch, forcing rebuild...');
		}
	}

	console.log('Extracting Graphify graph...');
	const start = Date.now();
	mkdirSync(GRAPHIFY_OUT, { recursive: true });
	const p = Bun.spawnSync(
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
	const elapsed = Date.now() - start;
	if (p.exitCode === 0 && existsSync(graphJson)) {
		// Tag the cache with worktree + commit for staleness detection
		writeFileSync(join(GRAPHIFY_OUT, '.benchmark_worktree'), WORKTREE);
		writeFileSync(join(GRAPHIFY_OUT, '.benchmark_commit'), COMMIT_SHA);
		writeFileSync(join(GRAPHIFY_OUT, '.benchmark_backend'), GRAPHIFY_BACKEND);
		graphifyReady = true;
		console.log(`  Graphify graph extracted in ${(elapsed / 1000).toFixed(1)}s`);
	} else {
		console.error(
			'  Graphify extraction failed (exit=' + p.exitCode + '):',
			p.stderr?.toString()?.slice(0, 500)
		);
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

		resolveConfig();
		console.log(`Worktree: ${WORKTREE}`);
		console.log(`Commit: ${COMMIT_SHA}`);

		// Build tool indexes BEFORE daemon start (avoids transport PONG timeout
		// during long index builds — default pongTimeout is 45s, builds take ~100s)
		console.log('Building tool indexes...');
		// Note: build helpers use Bun.spawnSync internally so they run sequentially
		// despite the Promise.allSettled wrapper. This is intentional — index builds
		// are CPU/IO heavy and parallelizing would not improve wall time meaningfully
		// on a single machine. Keep the allSettled pattern for future async migration.
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
			const path = writeBenchmarkResults(results, WORKTREE, RESULTS_PATH, COMMIT_SHA);
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

	test('baseline: plain GLM (text-only)', async () => {
		const result = await runBenchmarkCase(daemon, {
			name: 'baseline: plain GLM (text-only)',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_TEXT_ONLY,
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('CodeGraph', async () => {
		if (!codegraphReady) return expect.unreachable('CodeGraph index not built');
		const result = await runBenchmarkCase(daemon, {
			name: 'CodeGraph',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_UNSEDED,
			mcpServers: {
				codegraph: {
					command: 'npx',
					args: ['-y', '@colbymchenry/codegraph', 'mcp'],
				},
			},
			disallowedTools: DISABLED_BUILTINS,
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('code-review-graph', async () => {
		if (!crgReady) return expect.unreachable('CRG graph not built');
		const result = await runBenchmarkCase(daemon, {
			name: 'code-review-graph',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_UNSEDED,
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
			disallowedTools: DISABLED_BUILTINS,
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('Graphify', async () => {
		if (!graphifyReady) return expect.unreachable('Graphify graph not extracted');
		const result = await runBenchmarkCase(daemon, {
			name: 'Graphify',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_UNSEDED,
			mcpServers: {
				graphify: {
					command: graphifyPython,
					args: [...graphifyPythonArgs, '-m', 'graphify.serve', join(GRAPHIFY_OUT, 'graph.json')],
				},
			},
			disallowedTools: DISABLED_BUILTINS,
		});
		results.push(result);
		expect(result.responseText.length).toBeGreaterThan(100);
	}, 420_000);

	test('ast-grep', async () => {
		if (!astGrepServerPath) return expect.unreachable('ast-grep wrapper not created');
		const result = await runBenchmarkCase(daemon, {
			name: 'ast-grep',
			workspacePath: WORKTREE,
			prompt: BENCHMARK_PROMPT_UNSEDED,
			mcpServers: {
				'ast-grep': {
					command: 'node',
					args: [astGrepServerPath],
				},
			},
			disallowedTools: DISABLED_BUILTINS,
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
