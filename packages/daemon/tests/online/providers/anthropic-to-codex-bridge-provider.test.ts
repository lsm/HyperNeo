/**
 * OpenAI Responses Bridge Online Integration Tests
 *
 * Exercises the full OpenAI Responses bridge pipeline end-to-end:
 *   AnthropicToCodexBridgeProvider.buildSdkConfig → HTTP bridge server → OpenAI Responses API
 *
 * REQUIREMENTS:
 * - OPENAI_API_KEY must be set, or OpenAI OAuth credentials must be available in ~/.neokai/auth.json
 *
 * NOTE: Dev Proxy (NEOKAI_USE_DEV_PROXY=1) does NOT apply to these tests.
 * The bridge uses its own random-port HTTP server; Anthropic API traffic
 * interception at port 8000 has no effect here.  Tests always hit the real
 * OpenAI Responses API.
 *
 * Run with:
 *   cd packages/daemon && OPENAI_API_KEY=sk-xxx bun test \
 *     ./tests/online/providers/anthropic-to-codex-bridge-provider.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AnthropicToCodexBridgeProvider } from '../../../src/lib/providers/anthropic-to-codex-bridge-provider';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
  sendMessage,
  waitForIdle,
  getProcessingState,
  waitForSdkMessages,
} from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';
const IDLE_TIMEOUT = 120_000;
const SETUP_TIMEOUT = 60_000;
const TEST_TIMEOUT = IDLE_TIMEOUT + 30_000;

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

type SseEvent = { event: string; data: Record<string, unknown> };

/** Parse a raw SSE text body into an array of typed events. */
function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim()) continue;
    let eventName = '';
    let dataStr = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataStr = line.slice(6);
      }
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

/** Concatenate all text_delta fragments from the SSE stream. */
function extractText(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => {
      const delta = (e.data as { delta?: { type?: string; text?: string } }).delta;
      return delta?.type === 'text_delta' ? (delta.text ?? '') : '';
    })
    .join('');
}

/** Return the stop_reason from the message_delta event, or null if not found. */
function getStopReason(events: SseEvent[]): string | null {
  for (const e of events) {
    if (e.event === 'message_delta') {
      const delta = (e.data as { delta?: { stop_reason?: string } }).delta;
      if (delta?.stop_reason) return delta.stop_reason;
    }
  }
  return null;
}

type ToolUseBlock = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/**
 * Extract the first tool_use block from a stream.
 * Accumulates input_json_delta fragments and parses the final JSON.
 * Only the first tool_use block is returned; subsequent blocks are ignored.
 */
function getToolUseBlock(events: SseEvent[]): ToolUseBlock | null {
  let id = '';
  let name = '';
  const inputParts: string[] = [];

  for (const e of events) {
    if (e.event === 'content_block_start') {
      const cb = (e.data as { content_block?: { type?: string; id?: string; name?: string } })
        .content_block;
      // Only capture the first tool_use block — stop updating id/name once set
      // so that a second tool_use block does not overwrite the first one's state.
      if (cb?.type === 'tool_use' && cb.id && !id) {
        id = cb.id;
        name = cb.name ?? '';
      }
    } else if (e.event === 'content_block_delta' && id) {
      const delta = (e.data as { delta?: { type?: string; partial_json?: string } }).delta;
      if (delta?.type === 'input_json_delta' && delta.partial_json) {
        inputParts.push(delta.partial_json);
      }
    }
  }

  if (!id) return null;

  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(inputParts.join('')) as Record<string, unknown>;
  } catch {
    // leave input as empty object if JSON is missing/malformed
  }
  return { id, name, input };
}

// ---------------------------------------------------------------------------
// Bridge HTTP helper
// ---------------------------------------------------------------------------

type BridgeMessage = {
  role: 'user' | 'assistant';
  content: string | unknown[];
};

type BridgeTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

/** POST to the bridge /v1/messages endpoint, return parsed SSE events. */
async function callBridge(
  bridgeUrl: string,
  messages: BridgeMessage[],
  tools: BridgeTool[] = [],
  model = 'gpt-5.1-codex-mini',
  system?: string
): Promise<SseEvent[]> {
  const reqBody: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    max_tokens: 512,
  };
  if (tools.length > 0) reqBody.tools = tools;
  if (system) reqBody.system = system;

  const response = await fetch(`${bridgeUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });

  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}: ${await response.text()}`);
  }

  const text = await response.text();
  const events = parseSseEvents(text);
  // Diagnostic: log raw SSE bytes only when the stream looks empty or malformed,
  // to avoid flooding CI logs on successful requests.
  if (events.length === 0) {
    console.log(
      `[codex-bridge-test] raw-sse (${text.length} bytes, no events):`,
      text.slice(0, 2000)
    );
  }
  return events;
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Codex Bridge (Online)', () => {
  let provider: AnthropicToCodexBridgeProvider;
  let bridgeUrl: string;
  let daemon: DaemonServerContext;

  beforeAll(async () => {
    provider = new AnthropicToCodexBridgeProvider();

    // Hard-fail if credentials are absent per CLAUDE.md policy: tests must FAIL,
    // not silently skip. isAvailable() checks all runtime auth sources (OPENAI_API_KEY
    // env var and auth.json OAuth) rather than isAuthenticated which is UI-only.
    if (!(await provider.isAvailable())) {
      throw new Error(
        'anthropic-codex provider is not available. ' +
          'Set OPENAI_API_KEY or run `codex login` to import OAuth credentials.'
      );
    }

    const cfg = provider.buildSdkConfig('gpt-5.1-codex-mini', { workspacePath: process.cwd() });
    bridgeUrl = cfg.envVars.ANTHROPIC_BASE_URL as string;

    // Start a daemon server for provider-session and daemon-level tests.
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    provider?.stopAllBridgeServers();
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  // -------------------------------------------------------------------------
  // Test 1: Basic conversation
  // -------------------------------------------------------------------------
  test('basic conversation: user message → assistant text reply', async () => {
    const events = await callBridge(bridgeUrl, [
      { role: 'user', content: 'Reply with exactly: PONG' },
    ]);

    const stopReason = getStopReason(events);
    const text = extractText(events);
    if (stopReason !== 'end_turn' || !text.toUpperCase().includes('PONG')) {
      console.log('[diag] basic-conversation events:', JSON.stringify(events, null, 2));
    }
    expect(stopReason).toBe('end_turn');
    expect(text.toUpperCase()).toContain('PONG');
  }, 120_000);

  // -------------------------------------------------------------------------
  // Test 2: Tool use round-trip
  // -------------------------------------------------------------------------
  test('tool use: bridge routes tool call and model uses result in reply', async () => {
    // Use gpt-5.1-codex-mini for tool-use tests — confirmed to support dynamic tools.
    const TOOL_MODEL = 'gpt-5.1-codex-mini';
    // System prompt that forces tool use even with models that prefer self-answering.
    const TOOL_SYSTEM =
      'When the user asks you to call a tool, you MUST call that tool. ' +
      'Never answer the question yourself without first calling the requested tool.';

    const getGreetingTool: BridgeTool = {
      name: 'get_greeting',
      description: 'Get a personalised greeting for a person by name.',
      input_schema: {
        type: 'object',
        properties: {
          person_name: { type: 'string', description: 'Name of the person to greet' },
        },
        required: ['person_name'],
      },
    };

    // Turn 1 — expect the model to call the tool
    const turn1 = await callBridge(
      bridgeUrl,
      [
        {
          role: 'user',
          content:
            'Call the get_greeting tool with person_name "Alice", then tell me what it returned.',
        },
      ],
      [getGreetingTool],
      TOOL_MODEL,
      TOOL_SYSTEM
    );

    const stopReason1 = getStopReason(turn1);
    if (stopReason1 !== 'tool_use') {
      console.log('[diag] tool-use turn1 events:', JSON.stringify(turn1, null, 2));
    }
    expect(stopReason1).toBe('tool_use');

    const toolUse = getToolUseBlock(turn1);
    expect(toolUse).not.toBeNull();
    expect(toolUse!.name).toBe('get_greeting');

    // Execute the tool locally
    const personName = String(toolUse!.input.person_name ?? 'Alice');
    const toolResult = `Hello, ${personName}! Pleased to meet you.`;

    // Turn 2 — send the tool result continuation
    const turn2 = await callBridge(
      bridgeUrl,
      [
        {
          role: 'user',
          content:
            'Call the get_greeting tool with person_name "Alice", then tell me what it returned.',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolUse!.id,
              name: toolUse!.name,
              input: toolUse!.input,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse!.id,
              content: toolResult,
            },
          ],
        },
      ],
      [getGreetingTool],
      TOOL_MODEL,
      TOOL_SYSTEM
    );

    expect(getStopReason(turn2)).toBe('end_turn');
    // The model should reference Alice or the greeting in its final reply
    expect(extractText(turn2).toLowerCase()).toMatch(/alice|greeting|hello|pleased/);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Test 3: MCP-style tool (in-process mock MCP server)
  // -------------------------------------------------------------------------
  test('mcp tool: bridge handles MCP-style tool naming and call round-trip', async () => {
    // Use gpt-5.1-codex-mini for tool-use tests — confirmed to support dynamic tools.
    const TOOL_MODEL = 'gpt-5.1-codex-mini';
    const TOOL_SYSTEM =
      'When the user asks you to call a tool, you MUST call that tool. ' +
      'Never answer the question yourself without first calling the requested tool.';

    // MCP tools use the naming convention: mcp__<server-name>__<tool-name>
    // This simulates a tool registered by a (mock) in-process MCP server.
    const mcpEchoTool: BridgeTool = {
      name: 'mcp__mockserver__echo',
      description: 'Echo a message back unchanged. Use this to repeat any text.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Text to echo back' },
        },
        required: ['message'],
      },
    };

    const SECRET = 'BRIDGE_MCP_TEST_42';

    // Turn 1 — expect the model to call the MCP echo tool
    const turn1 = await callBridge(
      bridgeUrl,
      [
        {
          role: 'user',
          content: `Call the mcp__mockserver__echo tool with message "${SECRET}", then repeat exactly what it returned.`,
        },
      ],
      [mcpEchoTool],
      TOOL_MODEL,
      TOOL_SYSTEM
    );

    const stopReason1mcp = getStopReason(turn1);
    if (stopReason1mcp !== 'tool_use') {
      console.log('[diag] mcp-tool turn1 events:', JSON.stringify(turn1, null, 2));
    }
    expect(stopReason1mcp).toBe('tool_use');

    const toolUse = getToolUseBlock(turn1);
    expect(toolUse).not.toBeNull();
    expect(toolUse!.name).toBe('mcp__mockserver__echo');

    // In-process MCP handler: echo the input message
    const toolResult = String(toolUse!.input.message ?? SECRET);

    // Turn 2 — send the MCP tool result back as a continuation
    const turn2 = await callBridge(
      bridgeUrl,
      [
        {
          role: 'user',
          content: `Call the mcp__mockserver__echo tool with message "${SECRET}", then repeat exactly what it returned.`,
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolUse!.id,
              name: toolUse!.name,
              input: toolUse!.input,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse!.id,
              content: toolResult,
            },
          ],
        },
      ],
      [mcpEchoTool],
      TOOL_MODEL,
      TOOL_SYSTEM
    );

    expect(getStopReason(turn2)).toBe('end_turn');
    // The model should repeat the SECRET string in its final response
    expect(extractText(turn2)).toContain(SECRET);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Test 4: Provider-aware session creation via daemon
  // -------------------------------------------------------------------------
  test(
    'provider session: session.create with explicit config.provider uses codex backend',
    async () => {
      const workspacePath = join(TMP_DIR, `codex-provider-session-${Date.now()}`);
      mkdirSync(workspacePath, { recursive: true });

      // Create session with explicit provider — must route to anthropic-codex.
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Codex Explicit Provider Test',
        config: {
          model: 'gpt-5.1-codex-mini',
          provider: 'anthropic-codex',
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      // Query the session metadata to confirm the stored provider is 'anthropic-codex'.
      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config?: { provider?: string } } };
      expect(session.config?.provider).toBe('anthropic-codex');

      // Send a message and verify the codex backend responds with the expected token.
      await sendMessage(daemon, sessionId, 'Reply with exactly: CODEX_OK');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const state = await getProcessingState(daemon, sessionId);
      expect(state.status).toBe('idle');

      const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
        minCount: 1,
        timeout: 5000,
      });
      const text = sdkMessages
        .filter((m) => (m as { type?: string }).type === 'assistant')
        .map((m) => {
          const msg = (m as { message?: { content?: unknown } }).message;
          if (!msg?.content) return '';
          if (typeof msg.content === 'string') return msg.content;
          if (Array.isArray(msg.content)) {
            return msg.content
              .filter((b: unknown) => (b as { type?: string }).type === 'text')
              .map((b: unknown) => (b as { text?: string }).text ?? '')
              .join('');
          }
          return '';
        })
        .join('');
      // The model must echo the token back -- a bare truthiness check would pass
      // even for error messages or refusals from a wrong backend.
      expect(text.toUpperCase()).toContain('CODEX_OK');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 5: Error envelope — invalid request returns Anthropic JSON error format
  // -------------------------------------------------------------------------
  test('error envelope: unknown route returns Anthropic JSON error body', async () => {
    // Hit a non-existent endpoint on the bridge server — the bridge must respond
    // with the Anthropic JSON error envelope rather than a plain-text error.
    const response = await fetch(`${bridgeUrl}/v1/unknown-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = (await response.json()) as {
      type?: string;
      error?: { type?: string; message?: string };
    };
    // Must be Anthropic JSON error envelope format
    expect(body.type).toBe('error');
    expect(typeof body.error?.type).toBe('string');
    expect(typeof body.error?.message).toBe('string');
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 6: Token usage — SSE stream has non-zero output_tokens
  // -------------------------------------------------------------------------
  test('token usage: SSE stream contains non-zero output_tokens', async () => {
    const events = await callBridge(bridgeUrl, [{ role: 'user', content: 'Say hello.' }]);

    // The codex bridge hard-codes input_tokens to 0 in the message_start event
    // because thread/tokenUsage/updated arrives after streaming starts and the
    // message_start event has already been sent by then.  Only assert output_tokens.
    const outputTokens = getOutputTokens(events);

    expect(outputTokens).toBeGreaterThan(0);
  }, 120_000);
});
