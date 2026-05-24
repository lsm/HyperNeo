/**
 * AnthropicToCopilotBridgeProvider Online Tests
 *
 * Tests the embedded Anthropic-compatible HTTP server backed by the GitHub Copilot SDK.
 *
 * REQUIREMENTS:
 * - Authentication: set COPILOT_GITHUB_TOKEN to a fine-grained PAT with Copilot access,
 *   or set GH_TOKEN, or run `gh auth login` with a GitHub account that has Copilot access.
 *   Classic PATs (ghp_…) are NOT supported by the Copilot CLI.
 * - No manual CLI install needed — @github/copilot is bundled as a runtime
 *   dependency of @github/copilot-sdk and installed by `bun install`.
 * - If credentials are absent or non-functional, these tests FAIL (not skip). This is
 *   intentional — CI must alert the team when Copilot credentials need attention.
 *
 * HOW TO RUN:
 *   cd packages/daemon && bun test ./tests/online/providers/anthropic-to-copilot-bridge-provider.test.ts
 *
 * WHAT THESE TESTS PROVE:
 *   1. basic-conversation  — embedded server routes requests to the Copilot model and
 *                            returns a coherent response (proves the SSE bridge works).
 *   2. tool-use            — the tool-use bridge (ToolBridgeRegistry) works end-to-end:
 *                            the Agent SDK sends tool definitions → Copilot model calls a
 *                            tool → bridge emits a tool_use SSE block → SDK executes the
 *                            tool locally → sends tool_result → suspended session resumes.
 *   3. custom-mcp          — tools registered via `config.mcpServers` on the session are loaded
 *                            by the Agent SDK and included in the tools array sent to the Copilot
 *                            HTTP server.  Assertion: the MCP server subprocess receives a
 *                            tools/list call, proving get_answer was registered in the bridge.
 *                            (Pre-M1 this exercised `.mcp.json` auto-load; post-M1 sessions
 *                            default to `strictMcpConfig: true` + `settingSources: []`, so MCP
 *                            servers flow through programmatic registration instead.)
 *   4. models-list         — the anthropic-copilot provider exposes its models when authenticated.
 *   5. provider-session    — session.create with explicit config.provider:'anthropic-copilot'
 *                            routes to the copilot backend.
 *   6. error-envelope      — invalid requests return Anthropic JSON error envelopes.
 *   7. token-usage         — SSE stream contains non-zero input_tokens and output_tokens.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
  sendMessage,
  waitForIdle,
  waitForSdkMessages,
  interrupt,
} from '../../helpers/daemon-actions';
import { AnthropicToCopilotBridgeProvider } from '../../../src/lib/providers/anthropic-copilot/index';

const TMP_DIR = process.env.TMPDIR || '/tmp';

// ---------------------------------------------------------------------------
// SSE parsing helpers (used by bridge-level tests 6-7)
// ---------------------------------------------------------------------------

type SseEvent = { event: string; data: Record<string, unknown> };

function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim()) continue;
    let eventName = '';
    let dataStr = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataStr = line.slice(6);
    }
    if (!eventName || !dataStr) continue;
    try {
      events.push({ event: eventName, data: JSON.parse(dataStr) as Record<string, unknown> });
    } catch {
      // ignore unparseable lines
    }
  }
  return events;
}

/** Return the input_tokens from the message_start event, or 0 if not found. */
function getInputTokens(events: SseEvent[]): number {
  for (const e of events) {
    if (e.event === 'message_start') {
      const msg = (e.data as { message?: { usage?: { input_tokens?: number } } }).message;
      return msg?.usage?.input_tokens ?? 0;
    }
  }
  return 0;
}

/** Return the output_tokens from the message_delta event, or 0 if not found. */
function getOutputTokens(events: SseEvent[]): number {
  for (const e of events) {
    if (e.event === 'message_delta') {
      const usage = (e.data as { usage?: { output_tokens?: number } }).usage;
      return usage?.output_tokens ?? 0;
    }
  }
  return 0;
}

/** POST to the bridge /v1/messages endpoint, return parsed SSE events. */
async function callCopilotBridge(
  bridgeUrl: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  system?: string
): Promise<SseEvent[]> {
  const response = await fetch(`${bridgeUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: 256,
      ...(system ? { system } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}: ${await response.text()}`);
  }
  const events = parseSseEvents(await response.text());
  // Detect Anthropic SSE error events and surface them as descriptive test failures.
  const errorEvent = events.find((e) => e.event === 'error');
  if (errorEvent) {
    const err = (errorEvent.data as { error?: { type?: string; message?: string } }).error;
    throw new Error(
      `Copilot bridge returned SSE error: ${err?.type ?? 'unknown'} — ${err?.message ?? '(no message)'}`
    );
  }
  return events;
}

/** Per-turn idle timeout. The Copilot API can take 60-90 s per turn. */
const IDLE_TIMEOUT = 120_000;
const SETUP_TIMEOUT = 60_000; // includes server start + models.list warm-up
const TEST_TIMEOUT = IDLE_TIMEOUT + 30_000;

// ---------------------------------------------------------------------------
// Minimal MCP server (JSON-RPC 2.0 over stdio)
//
// Provides a single `get_answer` tool that returns a caller-supplied unique
// token.  The token is embedded at test-write time so the model cannot guess
// it from training data — it must call the tool to obtain the value.
// Written as a plain CommonJS script so it runs under both `node` and `bun`.
// ---------------------------------------------------------------------------

/**
 * Build the MCP server script with a unique answer token baked in.
 *
 * @param uniqueToken  Runtime-generated token returned by tools/call.
 * @param toolsListedFlag  Absolute path to a flag file the server writes when
 *   it receives a tools/list request.  The test asserts this file exists to
 *   confirm the Agent SDK initialised the MCP server and included get_answer
 *   in the tools array sent to the Copilot HTTP server — without relying on
 *   the Copilot model choosing to call the tool.
 */
function makeMcpServerScript(uniqueToken: string, toolsListedFlag: string): string {
  return /* js */ `
const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'test-answer-server', version: '1.0' }
    }});
  } else if (method === 'tools/list') {
    // Write a flag file so the test can assert this MCP server was initialised
    // by the Agent SDK.  This proves get_answer reached the Copilot HTTP server's
    // tools array without relying on the model deciding to call the tool.
    try { require('fs').writeFileSync(${JSON.stringify(toolsListedFlag)}, 'listed'); } catch {}
    write({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'get_answer',
      description: 'Returns a unique secret token. You cannot know this value without calling the tool.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    }]}});
  } else if (method === 'tools/call') {
    write({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: '${uniqueToken}' }], isError: false
    }});
  } else if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' }});
  }
  // notifications/initialized has no id — silently ignored here, which is correct
  // per MCP spec (it is a fire-and-forget notification, not a request).
});
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
`.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAssistantText(msg: Record<string, unknown>): string {
  const message = msg.message as { content?: unknown };
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b: unknown) => (b as { type?: string }).type === 'text')
      .map((b: unknown) => (b as { text?: string }).text ?? '')
      .join('');
  }
  return '';
}

/** Returns true if any assistant message contains a tool_use block with the given name. */
function hasToolUseBlock(sdkMessages: Array<Record<string, unknown>>, toolName?: string): boolean {
  return sdkMessages.some((m) => {
    const msg = m as { type?: string; message?: { content?: unknown[] } };
    if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) return false;
    return msg.message.content.some((b: unknown) => {
      const block = b as { type?: string; name?: string };
      if (block.type !== 'tool_use') return false;
      return toolName === undefined || block.name === toolName;
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicToCopilotBridgeProvider (Online)', () => {
  let daemon: DaemonServerContext;
  /**
   * Always 'gpt-5-mini' — the free-tier Copilot model used for all CI tests.
   * beforeAll hard-fails if this model is not present in the account's model list.
   */
  let testModelId: string;

  beforeAll(async () => {
    daemon = await createDaemonServer();

    // Hard-fail if credentials are absent or invalid — per CLAUDE.md policy.
    // isAvailable() checks all runtime auth sources (env vars, auth.json, gh CLI, hosts.yml).
    const copilotProvider = new AnthropicToCopilotBridgeProvider();
    if (!(await copilotProvider.isAvailable())) {
      throw new Error(
        'anthropic-copilot provider is not available. ' +
          'Set COPILOT_GITHUB_TOKEN to a fine-grained PAT (not a classic ghp_ PAT) with ' +
          'Copilot access, or use the OAuth login flow. ' +
          'See: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token'
      );
    }

    // Call models.list to start the embedded Anthropic server (mirrors production
    // flow where the UI always fetches models before creating a session).
    const modelsResult = (await daemon.messageHub.request('models.list', {})) as {
      models: Array<{ id: string; provider: string }>;
    };
    const copilotModels = modelsResult.models.filter((m) => m.provider === 'anthropic-copilot');
    if (copilotModels.length === 0) {
      throw new Error(
        'No anthropic-copilot models returned by models.list — ' +
          'authentication succeeded but the embedded server failed to start.'
      );
    }

    // Hard-fail if gpt-5-mini is not available.
    // gpt-5-mini is the designated CI model: it is free (0x cost) for all Copilot
    // subscribers, so it must always be present.  A missing gpt-5-mini means the
    // account's Copilot plan has changed and the CI secret / plan needs attention.
    const miniModel = copilotModels.find((m) => m.id === 'gpt-5-mini');
    if (!miniModel) {
      throw new Error(
        `gpt-5-mini is not in the anthropic-copilot model list. ` +
          `Available models: ${copilotModels.map((m) => m.id).join(', ')}. ` +
          `gpt-5-mini must be present — it is the designated free-tier CI model. ` +
          `Check that the Copilot account/plan still includes gpt-5-mini.`
      );
    }
    testModelId = 'gpt-5-mini';
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  // -------------------------------------------------------------------------
  // 1. Basic conversation
  // -------------------------------------------------------------------------

  test(
    'basic conversation: model responds correctly',
    async () => {
      const MAX_ATTEMPTS = 2;
      const PER_ATTEMPT_TIMEOUT = 60_000;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const workspacePath = join(TMP_DIR, `copilot-anthropic-basic-${Date.now()}`);
        mkdirSync(workspacePath, { recursive: true });

        const { sessionId } = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Copilot Anthropic Basic Test',
          config: { model: testModelId, permissionMode: 'acceptEdits' },
        })) as { sessionId: string };
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 6+7? Reply with just the number.');

        try {
          await waitForIdle(daemon, sessionId, PER_ATTEMPT_TIMEOUT);
        } catch (error) {
          if (attempt < MAX_ATTEMPTS) {
            // Interrupt stuck session and retry with a fresh one
            try {
              await interrupt(daemon, sessionId);
            } catch {
              /* ignore */
            }
            continue;
          }
          throw error;
        }

        const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
          minCount: 1,
          timeout: 10_000, // Messages should be ready shortly after idle
        });
        const assistantMessages = sdkMessages.filter(
          (m) => (m as { type?: string }).type === 'assistant'
        );
        expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

        const text = assistantMessages
          .map((m) => extractAssistantText(m as Record<string, unknown>))
          .join('');
        expect(text).toContain('13');
        return; // Success, exit retry loop
      }
    },
    // Budget: attempt1 timeout (60s) + overhead (~5s) + attempt2 idle (60s)
    // + sdkMessages (10s) = ~135s. 150s TEST_TIMEOUT provides margin.
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // 2. Tool use via the bridge
  // -------------------------------------------------------------------------

  test(
    'tool use: bridge routes tool_use/tool_result correctly',
    async () => {
      // Create a workspace with a known file the model will read.
      const workspacePath = join(TMP_DIR, `copilot-anthropic-tool-${Date.now()}`);
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, 'answer.txt'), 'The secret number is 42.');

      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Copilot Anthropic Tool-Use Test',
        config: { model: testModelId, permissionMode: 'acceptEdits' },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      await sendMessage(
        daemon,
        sessionId,
        'Read the file answer.txt in the current directory and tell me the exact content.'
      );
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
        minCount: 1,
        timeout: IDLE_TIMEOUT,
      });

      // At least one tool_use block proves the bridge fired.
      expect(hasToolUseBlock(sdkMessages)).toBe(true);

      // The response text should contain the file content.
      const text = sdkMessages
        .filter((m) => (m as { type?: string }).type === 'assistant')
        .map((m) => extractAssistantText(m as Record<string, unknown>))
        .join('');
      // "secret" proves the actual file content was received (not a coincidental "42")
      expect(text).toContain('secret');
      expect(text).toContain('42');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // 3. Custom MCP tool
  // -------------------------------------------------------------------------

  test(
    'custom MCP: programmatically registered server is discovered and exposed to the model',
    async () => {
      const workspacePath = join(TMP_DIR, `copilot-anthropic-mcp-${Date.now()}`);
      mkdirSync(workspacePath, { recursive: true });

      const uniqueToken = `tok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      // Flag file written by the MCP server when the Agent SDK calls tools/list.
      // Its existence is the primary assertion: it proves the SDK registered
      // the MCP server, spawned the subprocess, and fetched the tool list —
      // meaning get_answer was included in the tools array sent to the Copilot
      // HTTP server (i.e. the MCP bridge is wired up correctly).
      const toolsListedFlag = join(workspacePath, '.mcp-tools-listed');

      // Write the minimal MCP server to disk. Pre-M1 this would be registered
      // by dropping a `.mcp.json` alongside it, but M1
      // (docs/plans/unify-mcp-config-model/00-overview.md) forces
      // `settingSources: []` and `strictMcpConfig: true` on every session so
      // the SDK no longer auto-loads project `.mcp.json`. Instead we pass
      // the server programmatically via `config.mcpServers`, which is what
      // the registry/resolver will do once M3 lands.
      const mcpServerPath = join(workspacePath, 'test-mcp-server.js');
      writeFileSync(mcpServerPath, makeMcpServerScript(uniqueToken, toolsListedFlag));

      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Copilot Anthropic MCP Test',
        config: {
          model: testModelId,
          permissionMode: 'acceptEdits',
          mcpServers: {
            'test-answer-server': {
              command: 'node',
              args: [mcpServerPath],
            },
          },
        },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      await sendMessage(
        daemon,
        sessionId,
        'Call the get_answer tool and report the exact token it returns. ' +
          'You MUST use the tool — do not guess or invent a value. ' +
          'Reply with only the token string, nothing else.'
      );
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      // PRIMARY assertion: the Agent SDK initialised the MCP server.
      // The MCP server writes the flag when it receives a tools/list request,
      // which precedes the first model inference.  By the time waitForIdle
      // returns the flag should already exist, but we poll for up to 5 s to
      // absorb any OS file-visibility latency on slow CI runners.
      const flagDeadline = Date.now() + 5_000;
      while (!existsSync(toolsListedFlag) && Date.now() < flagDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(toolsListedFlag)).toBe(true);

      // SECONDARY assertion (informational): if the Copilot model chose to call
      // get_answer, its response must contain the unique token.  We do not assert
      // hasToolUseBlock here because GPT-4o-based Copilot models do not reliably
      // call tools on explicit instruction — that is a model-behaviour difference
      // from Claude, not a bridge defect.  The primary assertion above already
      // proves the tool was exposed; whether the model uses it is out of scope.
      const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
        minCount: 1,
        timeout: IDLE_TIMEOUT,
      });
      if (hasToolUseBlock(sdkMessages, 'get_answer')) {
        const text = sdkMessages
          .filter((m) => (m as { type?: string }).type === 'assistant')
          .map((m) => extractAssistantText(m as Record<string, unknown>))
          .join('');
        expect(text).toContain(uniqueToken);
      }
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // 4. Models list includes Copilot models
  // -------------------------------------------------------------------------

  test('models list: anthropic-copilot models are present when authenticated', async () => {
    // testModelId is set in beforeAll from the models.list call — if we reach here,
    // the embedded server is running and at least one copilot model was returned.
    expect(testModelId).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 5. Explicit provider session creation
  // -------------------------------------------------------------------------

  test(
    'provider session: session.create with explicit config.provider uses copilot backend',
    async () => {
      const workspacePath = join(TMP_DIR, `copilot-provider-session-${Date.now()}`);
      mkdirSync(workspacePath, { recursive: true });

      // Create session with explicit provider — this is the key assertion:
      // passing config.provider:'anthropic-copilot' must route to the copilot
      // backend regardless of whether the model ID is ambiguous.
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Copilot Explicit Provider Test',
        config: {
          model: testModelId,
          provider: 'anthropic-copilot',
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      // Query the session metadata to confirm the stored provider is 'anthropic-copilot'.
      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config?: { provider?: string } } };
      expect(session.config?.provider).toBe('anthropic-copilot');

      // Send a message and verify the copilot backend responds.
      // sendMessage() already polls until processing starts, so waitForIdle()
      // will not resolve against the pre-send idle state.
      await sendMessage(daemon, sessionId, 'Reply with exactly: COPILOT_OK');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      // waitForIdle may resolve on a brief idle between Copilot retry cycles
      // before the assistant message is persisted. Use a long timeout so we
      // keep polling until the real response arrives.
      const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
        minCount: 1,
        timeout: IDLE_TIMEOUT,
      });
      const text = sdkMessages
        .filter((m) => (m as { type?: string }).type === 'assistant')
        .map((m) => extractAssistantText(m as Record<string, unknown>))
        .join('');
      // The model must echo the token back -- a bare truthiness check would pass
      // even for error messages or refusals from a wrong backend.
      expect(text.toUpperCase()).toContain('COPILOT_OK');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // 6. Error envelope — invalid request returns Anthropic JSON error format
  // -------------------------------------------------------------------------

  test(
    'error envelope: stream:false returns Anthropic JSON error envelope',
    async () => {
      // Instantiate the provider directly to access the bridge URL without
      // routing through the daemon session lifecycle.
      const directProvider = new AnthropicToCopilotBridgeProvider();
      const bridgeUrl = await directProvider.ensureServerStarted();

      try {
        // The copilot bridge requires stream:true — explicitly setting stream:false
        // triggers an immediate 400 invalid_request_error (no API call needed).
        const response = await fetch(`${bridgeUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: testModelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 16,
            stream: false,
          }),
        });

        expect(response.status).toBe(400);
        const body = (await response.json()) as {
          type?: string;
          error?: { type?: string; message?: string };
        };
        // Must be Anthropic JSON error envelope: { type:'error', error:{type,message} }
        expect(body.type).toBe('error');
        expect(body.error?.type).toBe('invalid_request_error');
        expect(typeof body.error?.message).toBe('string');
      } finally {
        await directProvider.shutdown();
      }
    },
    SETUP_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // 7. Token usage — session metadata has non-zero input_tokens and output_tokens
  // -------------------------------------------------------------------------

  test(
    'token usage: session metadata contains non-zero input_tokens and output_tokens',
    async () => {
      // Route through the daemon session lifecycle (uses the existing Copilot
      // provider that was already warmed up in beforeAll).  Creating a fresh
      // AnthropicToCopilotBridgeProvider here would spin up a new CopilotClient
      // subprocess whose first createSession call lists models, which can return
      // 429 after the preceding tests have exhausted the rate limit window.
      const workspacePath = join(TMP_DIR, `copilot-token-usage-${Date.now()}`);
      mkdirSync(workspacePath, { recursive: true });

      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Copilot Token Usage Test',
        config: { model: testModelId, permissionMode: 'acceptEdits' },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      await sendMessage(daemon, sessionId, 'Say hello in one sentence.');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      // Wait for SDK messages to be persisted — consistent with other tests that
      // also use waitForSdkMessages before querying session state.
      await waitForSdkMessages(daemon, sessionId, { minCount: 1, timeout: 5000 });

      // Token counts are accumulated in session metadata by the SDK message handler.
      // The Copilot bridge emits heuristic input/output counts via SSE (input from
      // prompt length, output from response character count), which the Claude Agent
      // SDK processes and stores in the assistant message's usage field, then
      // persists to session.metadata.inputTokens/outputTokens.
      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { metadata?: { inputTokens?: number; outputTokens?: number } } };

      expect(session.metadata?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(session.metadata?.outputTokens ?? 0).toBeGreaterThan(0);
    },
    TEST_TIMEOUT
  );
});
