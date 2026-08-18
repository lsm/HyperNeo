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

function getInputTokens(events: SseEvent[]): number {
  for (const e of events) {
    if (e.event === 'message_start') {
      const msg = (e.data as { message?: { usage?: { input_tokens?: number } } }).message;
      return msg?.usage?.input_tokens ?? 0;
    }
  }
  return 0;
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
  const errorEvent = events.find((e) => e.event === 'error');
  if (errorEvent) {
    const err = (errorEvent.data as { error?: { type?: string; message?: string } }).error;
    throw new Error(
      `Copilot bridge returned SSE error: ${err?.type ?? 'unknown'} — ${err?.message ?? '(no message)'}`
    );
  }
  return events;
}

const IDLE_TIMEOUT = 120_000;
const SETUP_TIMEOUT = 60_000;
const TEST_TIMEOUT = IDLE_TIMEOUT + 30_000;

function makeMcpServerScript(uniqueToken: string, toolsListedFlag: string): string {
  return `
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

describe('AnthropicToCopilotBridgeProvider (Online)', () => {
  let daemon: DaemonServerContext;
  let testModelId: string;

  beforeAll(async () => {
    daemon = await createDaemonServer();

    const copilotProvider = new AnthropicToCopilotBridgeProvider();
    if (!(await copilotProvider.isAvailable())) {
      throw new Error(
        'anthropic-copilot provider is not available. ' +
          'Set COPILOT_GITHUB_TOKEN to a fine-grained PAT (not a classic ghp_ PAT) with ' +
          'Copilot access, or use the OAuth login flow. ' +
          'See: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token'
      );
    }

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
          timeout: 10_000,
        });
        const assistantMessages = sdkMessages.filter(
          (m) => (m as { type?: string }).type === 'assistant'
        );
        expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

        const text = assistantMessages
          .map((m) => extractAssistantText(m as Record<string, unknown>))
          .join('');
        expect(text).toContain('13');
        return;
      }
    },
    TEST_TIMEOUT
  );

  test(
    'tool use: bridge routes tool_use/tool_result correctly',
    async () => {
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

      expect(hasToolUseBlock(sdkMessages)).toBe(true);

      const text = sdkMessages
        .filter((m) => (m as { type?: string }).type === 'assistant')
        .map((m) => extractAssistantText(m as Record<string, unknown>))
        .join('');
      expect(text).toContain('secret');
      expect(text).toContain('42');
    },
    TEST_TIMEOUT
  );

  test(
    'custom MCP: programmatically registered server is discovered and exposed to the model',
    async () => {
      const workspacePath = join(TMP_DIR, `copilot-anthropic-mcp-${Date.now()}`);
      mkdirSync(workspacePath, { recursive: true });

      const uniqueToken = `tok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      const toolsListedFlag = join(workspacePath, '.mcp-tools-listed');

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

      const flagDeadline = Date.now() + 5_000;
      while (!existsSync(toolsListedFlag) && Date.now() < flagDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(toolsListedFlag)).toBe(true);

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

  test('models list: anthropic-copilot models are present when authenticated', async () => {
    expect(testModelId).toBeTruthy();
  });

  test(
    'provider session: session.create with explicit config.provider uses copilot backend',
    async () => {
      const workspacePath = join(TMP_DIR, `copilot-provider-session-${Date.now()}`);
      mkdirSync(workspacePath, { recursive: true });

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

      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config?: { provider?: string } } };
      expect(session.config?.provider).toBe('anthropic-copilot');

      await sendMessage(daemon, sessionId, 'Reply with exactly: COPILOT_OK');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
        minCount: 1,
        timeout: IDLE_TIMEOUT,
      });
      const text = sdkMessages
        .filter((m) => (m as { type?: string }).type === 'assistant')
        .map((m) => extractAssistantText(m as Record<string, unknown>))
        .join('');
      expect(text.toUpperCase()).toContain('COPILOT_OK');
    },
    TEST_TIMEOUT
  );

  test(
    'error envelope: stream:false returns Anthropic JSON error envelope',
    async () => {
      const directProvider = new AnthropicToCopilotBridgeProvider();
      const bridgeUrl = await directProvider.ensureServerStarted();

      try {
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
        expect(body.type).toBe('error');
        expect(body.error?.type).toBe('invalid_request_error');
        expect(typeof body.error?.message).toBe('string');
      } finally {
        await directProvider.shutdown();
      }
    },
    SETUP_TIMEOUT
  );

  test(
    'token usage: session metadata contains non-zero input_tokens and output_tokens',
    async () => {
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

      await waitForSdkMessages(daemon, sessionId, { minCount: 1, timeout: 5000 });

      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { metadata?: { inputTokens?: number; outputTokens?: number } } };

      expect(session.metadata?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(session.metadata?.outputTokens ?? 0).toBeGreaterThan(0);
    },
    TEST_TIMEOUT
  );
});
