/**
 * Benchmark helpers for graph tool comparison.
 *
 * Shared constants, types, and runner function used by benchmark-graph-tools.test.ts.
 * Must be importable from `bun test` without special loaders.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DaemonServerContext } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle, waitForSdkMessages } from '../../helpers/daemon-actions';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const BENCHMARK_PROMPT_UNSEDED =
	`We need to improve NeoKai's Space task/workflow runtime so stuck or idle task agents do not loop forever or spam operators.

Current behavior: when task agents appear idle, blocked, waiting, or completed, the system can emit many task/workflow events to the Space Agent. These events are noisy and do not reliably recover stuck work. Successful workflow completions can also create notification noise. Real stuck tasks can retry or wait repeatedly until a human manually intervenes.

Desired behavior:

1. Detect when a task agent is genuinely stuck rather than temporarily waiting.
   - Idle for more than a configured threshold with no useful progress.
   - Repeated idle/non-terminal states for the same task.
   - Waiting too long for tool, session, or workflow progress.
   - Workflow run exceeds a configured wall-clock timeout.

2. Track enough state to make recovery decisions.
   - Last useful message/progress timestamp.
   - Current agent/workflow/task state.
   - Pending tool or external-event activity if available.
   - Consecutive stuck/idle count.
   - Recovery attempts, retry count, and escalation history.

3. Apply recovery based on autonomy level.
   - Low autonomy: notify or ask a human before destructive action.
   - Medium autonomy: retry/nudge with backoff and caps.
   - High autonomy: automatically retry, reassign, or escalate after limits.

4. Prevent retry loops.
   - Max consecutive retries.
   - Max total retries.
   - Exponential backoff.
   - Clear terminal failure/escalation state when recovery fails.

5. Reduce event noise.
   - Do not notify operators for successful workflow completions unless required for audit/debug mode.
   - Rate-limit idle/stuck notifications.
   - Notify only for actionable or critical events.
   - Keep full internal logs/events for debugging even when notifications are suppressed.

Produce an implementation plan with:
- key files to inspect or modify,
- data flow,
- likely existing abstractions to reuse,
- new modules or types if needed,
- migration/storage implications if any,
- tests to add or update,
- risks and edge cases,
- estimated change scope.` as const;

/**
 * Text-only variant for the baseline test.  Instructs the model to respond
 * without using any tools — required because GLM's tool_use responses are
 * incompatible with the Claude Agent SDK's context-fetcher when no tools
 * are available for the SDK to execute.
 */
export const BENCHMARK_PROMPT_TEXT_ONLY = (BENCHMARK_PROMPT_UNSEDED +
	`

IMPORTANT: Respond with text only. Do NOT use any tools (no Bash, Read, Write, Glob, Grep, or any other tool). Produce your plan based on your understanding of typical agent runtime architectures.`) as const;

/**
 * Build the mixed-discovery prompt. Instructs the agent to first use built-in
 * search (Read/Grep/Glob) to identify likely files, then use the named tool
 * for deeper context.
 */
export function makeMixedPrompt(toolName: string): string {
	return (
		BENCHMARK_PROMPT_UNSEDED +
		`

## Additional instructions for this run

You are in a **mixed discovery** configuration. You have access to:

1. **Built-in tools** (Read, Grep, Glob) — use these FIRST to do minimal search
   and identify the core runtime files related to: stuck, idle, blocked, waiting,
   retry, notification, recovery, tick loop, completion, autonomy.

2. **${toolName}** — after your initial built-in search, use ${toolName} to get
   deeper structural context on the files and symbols you discovered.

Produce an implementation plan grounded in actual NeoKai file paths, function names,
and type names. Mark inferences clearly.`
	);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
	caseName: string;
	wallTimeMs: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	toolCallCount: number;
	toolCalls: Array<{ name: string; count: number }>;
	responseText: string;
	responseLength: number;
	sessionId: string;
}

export interface BenchmarkOutput {
	timestamp: string;
	neokaiCommit: string;
	model: string;
	worktreePath: string;
	results: BenchmarkResult[];
}

export interface BenchmarkCaseOptions {
	name: string;
	workspacePath: string;
	prompt: string;
	mcpServers?: Record<string, { command: string; args: string[] }>;
}

// ---------------------------------------------------------------------------
// SDK message parsing
// ---------------------------------------------------------------------------

/** Count tool_use blocks across all SDK messages. */
export function extractToolCalls(sdkMessages: Array<Record<string, unknown>>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const msg of sdkMessages) {
		if ((msg as { type?: string }).type !== 'assistant') continue;
		const content = (msg as { message?: { content?: unknown[] } }).message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as { type?: string; name?: string };
			if (b.type === 'tool_use' && b.name) {
				counts.set(b.name, (counts.get(b.name) || 0) + 1);
			}
		}
	}
	return counts;
}

/** Extract concatenated assistant text from SDK messages. */
export function extractResponseText(sdkMessages: Array<Record<string, unknown>>): string {
	const parts: string[] = [];
	for (const msg of sdkMessages) {
		if ((msg as { type?: string }).type !== 'assistant') continue;
		const content = (msg as { message?: { content?: unknown[] } }).message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as { type?: string; text?: string };
			if (b.type === 'text' && b.text) {
				parts.push(b.text);
			}
		}
	}
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single benchmark case: create session, send prompt, wait for idle,
 * collect metrics.
 */
export async function runBenchmarkCase(
	daemon: DaemonServerContext,
	options: BenchmarkCaseOptions
): Promise<BenchmarkResult> {
	const { name, workspacePath, prompt, mcpServers } = options;

	// 1. Create session
	//
	// NOTE: GLM-5.x models generate tool_use responses that are incompatible with
	// the Claude Agent SDK's internal context-fetcher, causing sessions to hang.
	// GLM-4.7 works reliably when tools are available for the SDK to execute.
	// The baseline test uses a text-only prompt variant that avoids triggering tool_use.
	const createResult = (await daemon.messageHub.request('session.create', {
		workspacePath,
		title: `Benchmark: ${name}`,
		config: {
			model: 'glm-4.7',
			provider: 'glm',
			permissionMode: 'bypassPermissions',
			...(mcpServers ? { mcpServers } : {}),
		},
	})) as { sessionId: string };

	const { sessionId } = createResult;
	daemon.trackSession(sessionId);

	// 2. Send prompt and time it
	const startMs = Date.now();
	await sendMessage(daemon, sessionId, prompt);
	await waitForIdle(daemon, sessionId, 360_000);
	const wallTimeMs = Date.now() - startMs;

	// 3. Collect SDK messages
	const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
		minCount: 1,
		timeout: 30_000,
	});

	// 4. Get session metadata for token counts
	const sessionResult = (await daemon.messageHub.request('session.get', {
		sessionId,
	})) as {
		session: {
			metadata?: {
				totalTokens?: number;
				inputTokens?: number;
				outputTokens?: number;
				toolCallCount?: number;
			};
		};
	};
	const meta = sessionResult.session?.metadata ?? {};

	// 5. Parse tool calls and response text
	const toolCallMap = extractToolCalls(sdkMessages ?? []);
	const responseText = extractResponseText(sdkMessages ?? []);

	const toolCalls = Array.from(toolCallMap.entries()).map(([name, count]) => ({
		name,
		count,
	}));

	return {
		caseName: name,
		wallTimeMs,
		totalTokens: meta.totalTokens ?? 0,
		inputTokens: meta.inputTokens ?? 0,
		outputTokens: meta.outputTokens ?? 0,
		toolCallCount: meta.toolCallCount ?? 0,
		toolCalls,
		responseText,
		responseLength: responseText.length,
		sessionId,
	};
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function writeBenchmarkResults(
	results: BenchmarkResult[],
	worktreePath: string,
	outputPath?: string,
	commitSha?: string
): string {
	const output: BenchmarkOutput = {
		timestamp: new Date().toISOString(),
		neokaiCommit: commitSha ?? 'unknown',
		model: 'glm-4.7',
		worktreePath,
		results,
	};
	const path = outputPath ?? '/tmp/graph-tool-benchmark-results.json';
	writeFileSync(path, JSON.stringify(output, null, 2));
	return path;
}

// ---------------------------------------------------------------------------
// ast-grep MCP server wrapper (stdio JSON-RPC)
// ---------------------------------------------------------------------------

/**
 * Generate a minimal stdio MCP server script that wraps `ast-grep run`.
 * Follows the pattern from anthropic-to-copilot-bridge-provider.test.ts.
 */
export function makeAstGrepMcpServerScript(workspacePath: string): string {
	return `
const { spawnSync } = require('child_process');
const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
const WORKSPACE = ${JSON.stringify(workspacePath)};
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ast-grep-wrapper', version: '1.0.0' }
    }});
  } else if (method === 'notifications/initialized') {
    // fire-and-forget, no response
  } else if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: [
      {
        name: 'ast_grep_search',
        description: 'Run ast-grep structural search over the workspace. Returns JSON matches. Use --pattern for AST patterns or literal string search.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern (AST pattern or string literal)' },
            lang: { type: 'string', description: 'Language (ts, tsx, js, py, etc.). Default: ts' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'ast_grep_search_multiple',
        description: 'Run multiple ast-grep searches and combine results. Pass comma-separated patterns.',
        inputSchema: {
          type: 'object',
          properties: {
            patterns: { type: 'string', description: 'Comma-separated search patterns' },
            lang: { type: 'string', description: 'Language. Default: ts' },
          },
          required: ['patterns'],
        },
      },
    ]}});
  } else if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};
    try {
      let result;
      if (toolName === 'ast_grep_search') {
        result = runAstGrep(args.pattern, args.lang || 'ts');
      } else if (toolName === 'ast_grep_search_multiple') {
        const patterns = (args.patterns || '').split(',').map(s => s.trim()).filter(Boolean);
        const parts = patterns.map(p => ({ pattern: p, output: runAstGrep(p, args.lang || 'ts') }));
        result = JSON.stringify(parts);
      } else {
        result = 'Unknown tool: ' + toolName;
      }
      write({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: result }], isError: false
      }});
    } catch (err) {
      write({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: 'Error: ' + (err.message || String(err)) }], isError: true
      }});
    }
  } else if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' }});
  }
});
function runAstGrep(pattern, lang) {
  const r = spawnSync('npx', ['-y', '-p', '@ast-grep/cli', 'ast-grep', 'run',
    '--pattern', pattern, '--lang', lang, '--json', WORKSPACE],
    { timeout: 60000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' });
  return r.stdout || r.stderr || '(no output)';
}
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
`.trim();
}
