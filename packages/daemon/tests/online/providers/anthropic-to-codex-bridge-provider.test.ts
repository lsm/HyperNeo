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

type SseEvent = { event: string; data: Record<string, unknown> };

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

function extractText(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => {
      const delta = (e.data as { delta?: { type?: string; text?: string } }).delta;
      return delta?.type === 'text_delta' ? (delta.text ?? '') : '';
    })
    .join('');
}

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

function getToolUseBlock(events: SseEvent[]): ToolUseBlock | null {
  let id = '';
  let name = '';
  const inputParts: string[] = [];

  for (const e of events) {
    if (e.event === 'content_block_start') {
      const cb = (e.data as { content_block?: { type?: string; id?: string; name?: string } })
        .content_block;
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

type BridgeMessage = {
  role: 'user' | 'assistant';
  content: string | unknown[];
};

type BridgeTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

async function callBridge(
  bridgeUrl: string,
  messages: BridgeMessage[],
  tools: BridgeTool[] = [],
  model = 'gpt-5.4-mini',
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
  if (events.length === 0) {
    console.log(
      `[codex-bridge-test] raw-sse (${text.length} bytes, no events):`,
      text.slice(0, 2000)
    );
  }
  return events;
}

function getOutputTokens(events: SseEvent[]): number {
  for (const e of events) {
    if (e.event === 'message_delta') {
      const usage = (e.data as { usage?: { output_tokens?: number } }).usage;
      return usage?.output_tokens ?? 0;
    }
  }
  return 0;
}

describe('Codex Bridge (Online)', () => {
  let provider: AnthropicToCodexBridgeProvider;
  let bridgeUrl: string;
  let daemon: DaemonServerContext;

  beforeAll(async () => {
    provider = new AnthropicToCodexBridgeProvider();

    if (!(await provider.isAvailable())) {
      throw new Error(
        'anthropic-codex provider is not available. ' +
          'Set OPENAI_API_KEY or run `codex login` to import OAuth credentials.'
      );
    }

    const cfg = provider.buildSdkConfig('gpt-5.4-mini', { workspacePath: process.cwd() });
    bridgeUrl = cfg.envVars.ANTHROPIC_BASE_URL as string;

    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    provider?.stopAllBridgeServers();
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

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

  test('tool use: bridge routes tool call and model uses result in reply', async () => {
    const TOOL_MODEL = 'gpt-5.4-mini';
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

    const personName = String(toolUse!.input.person_name ?? 'Alice');
    const toolResult = `Hello, ${personName}! Pleased to meet you.`;

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
    expect(extractText(turn2).toLowerCase()).toMatch(/alice|greeting|hello|pleased/);
  }, 180_000);

  test('mcp tool: bridge handles MCP-style tool naming and call round-trip', async () => {
    const TOOL_MODEL = 'gpt-5.4-mini';
    const TOOL_SYSTEM =
      'When the user asks you to call a tool, you MUST call that tool. ' +
      'Never answer the question yourself without first calling the requested tool.';

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

    const toolResult = String(toolUse!.input.message ?? SECRET);

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
    expect(extractText(turn2)).toContain(SECRET);
  }, 180_000);

  test(
    'provider session: session.create with explicit config.provider uses codex backend',
    async () => {
      const workspacePath = join(TMP_DIR, `codex-provider-session-${Date.now()}`);
      mkdirSync(workspacePath, { recursive: true });

      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Codex Explicit Provider Test',
        config: {
          model: 'gpt-5.4-mini',
          provider: 'anthropic-codex',
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config?: { provider?: string } } };
      expect(session.config?.provider).toBe('anthropic-codex');

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
      expect(text.toUpperCase()).toContain('CODEX_OK');
    },
    TEST_TIMEOUT
  );

  test('error envelope: unknown route returns Anthropic JSON error body', async () => {
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
    expect(body.type).toBe('error');
    expect(typeof body.error?.type).toBe('string');
    expect(typeof body.error?.message).toBe('string');
  }, 30_000);

  test('token usage: SSE stream contains non-zero output_tokens', async () => {
    const events = await callBridge(bridgeUrl, [{ role: 'user', content: 'Say hello.' }]);

    const outputTokens = getOutputTokens(events);

    expect(outputTokens).toBeGreaterThan(0);
  }, 120_000);
});
