import { beforeEach, expect, test, vi } from 'vitest';
import type { NeoService } from '../../../../src/lib/neo/service.ts';
import { runNeoFrontModel } from '../../../../src/lib/neo/front-model.ts';
import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
const env = { ANTHROPIC_MODEL: 'front-route' };
vi.mock('../../../../src/lib/provider-service.ts', () => ({
  getProviderService: () => ({ getIsolatedEnvForModel: vi.fn(async () => env) }),
}));
vi.mock('../../../../src/lib/agent/sdk-cli-resolver.ts', () => ({
  awaitSDKCliPath: async () => '/synthetic/claude',
  isRunningUnderBun: () => false,
}));
const ask = {
  conversationId: '10000000-0000-4000-8000-000000000001',
  requestId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: 'neo:root', messageId: '20000000-0000-4000-8000-000000000001' },
  content: 'Hello',
  sequence: 1,
  createdAt: '2026-01-01T00:00:00Z',
};
const preference = { model: 'glm-4.7-flashx', provider: 'glm', thinkingLevel: 'off' as const };
const read = vi.fn();
const note = vi.fn();
vi.mock('../../../../src/lib/neo/front-session.ts', () => ({
  frontSession: async () => ({
    id: '30000000-0000-4000-8000-000000000001',
    workspacePath: '/synthetic',
  }),
}));
const service = {
  db: {
    gateway: { run: read, call: vi.fn(async () => true) },
    getSDKMessageRepo: () => ({ saveSDKMessage: () => true }),
  },
  wakeNeo: note,
} as unknown as NeoService;
type Tool = { name: string; handler: (input: object) => Promise<unknown> };
let tools: Tool[];
function response(kind: string, text: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text: JSON.stringify({ kind, text }) }] },
  };
}
beforeEach(() => {
  read.mockReset().mockResolvedValue({ id: 'one', state: 'done' });
  note.mockReset().mockResolvedValue(true);
  vi.mocked(query).mockImplementation(async function* () {
    yield response('chat', 'Hello!');
    yield { type: 'result', subtype: 'success' };
  } as unknown as typeof query);
  tools = [];
  vi.mocked(createSdkMcpServer).mockImplementation((options) => {
    tools = options.tools as unknown as Tool[];
    return { type: 'sdk', name: 'front', instance: {} } as ReturnType<typeof createSdkMcpServer>;
  });
});
test('chat uses the selected GLM route, original input and only five private tools', async () => {
  expect(await runNeoFrontModel(service, ask, preference)).toBe('Hello!');
  const call = vi.mocked(query).mock.calls[0][0];
  expect(call.options).toMatchObject({
    model: 'haiku',
    env,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'dontAsk',
  });
  expect(call.options?.allowedTools).toEqual(
    ['projects_read', 'asks_read', 'cards_read', 'todos_read', 'neo_send'].map(
      (name) => `mcp__front__${name}`
    )
  );
  expect(tools.map((tool) => tool.name)).toEqual([
    'projects_read',
    'asks_read',
    'cards_read',
    'todos_read',
    'neo_send',
  ]);
  expect(read).not.toHaveBeenCalled();
  expect(note).not.toHaveBeenCalled();
  expect(typeof call.options?.systemPrompt).toBe('string');
});
test('status requires a successful fresh read in this call', async () => {
  vi.mocked(query).mockImplementation(async function* () {
    yield response('status', 'Done.');
  } as unknown as typeof query);
  await expect(runNeoFrontModel(service, ask, preference)).rejects.toThrow(
    'front_status_not_grounded'
  );
  vi.mocked(query).mockImplementation(async function* () {
    await tools[3].handler({ id: 'one' });
    yield response('status', 'Done.');
  } as unknown as typeof query);
  expect(await runNeoFrontModel(service, ask, preference)).toBe('Done.');
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ name: 'neo.front.read' }), {
    conversationId: ask.conversationId,
    kind: 'todos',
    input: { id: 'one' },
  });
  read.mockResolvedValue(null);
  await expect(runNeoFrontModel(service, ask, preference)).rejects.toThrow(
    'front_status_not_grounded'
  );
});
test('each invocation discards reads and refuses a second lookup', async () => {
  vi.mocked(query).mockImplementation(async function* () {
    await tools[0].handler({ text: 'Project' });
    const repeated = await tools[1].handler({});
    expect(repeated).toMatchObject({ isError: true });
    yield response('status', 'Done.');
  } as unknown as typeof query);
  await expect(runNeoFrontModel(service, ask, preference)).rejects.toThrow(
    'front_status_not_grounded'
  );
  expect(read).toHaveBeenCalledTimes(1);
  vi.mocked(query).mockImplementation(async function* () {
    yield response('status', 'Done.');
  } as unknown as typeof query);
  await expect(runNeoFrontModel(service, ask, preference)).rejects.toThrow(
    'front_status_not_grounded'
  );
});
test('action and mixed requests can only return a brief deferral', async () => {
  vi.mocked(query).mockImplementation(async function* () {
    yield response('defer', 'Let me check.');
  } as unknown as typeof query);
  expect(
    await runNeoFrontModel(
      service,
      { ...ask, content: 'Book it and tell me its status' },
      preference
    )
  ).toBe('Let me check.');
  expect(read).not.toHaveBeenCalled();
  expect(note).not.toHaveBeenCalled();
});
test('a note has the daemon-fixed input identity and root recipient', async () => {
  vi.mocked(query).mockImplementation(async function* () {
    await tools[4].handler({ text: 'Need a closer check.' });
    yield response('defer', 'Let me check.');
  } as unknown as typeof query);
  await runNeoFrontModel(service, ask, preference);
  expect(note).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(ask.requestId));
});

test('parallel lookup attempts cannot restore grounding after a rejected extra read', async () => {
  vi.mocked(query).mockImplementation(async function* () {
    await Promise.all([tools[0].handler({ id: 'one' }), tools[1].handler({ id: 'two' })]);
    yield response('status', 'Both are done.');
  } as unknown as typeof query);
  await expect(runNeoFrontModel(service, ask, preference)).rejects.toThrow(
    'front_status_not_grounded'
  );
  expect(read).toHaveBeenCalledTimes(1);
});

test('uses the selected thinking level and the daemon default compaction percentage', async () => {
  await runNeoFrontModel(service, ask, { ...preference, thinkingLevel: 'think24k' });
  const options = vi.mocked(query).mock.calls.at(-1)![0].options!;
  expect(options.thinking).toEqual({ type: 'enabled', budgetTokens: 24000 });
  expect(options.effort).toBe('high');
  expect(options.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('90');
  expect(options.maxTurns).toBe(4);
});

test('continues the same durable front SDK session on an extra human message', async () => {
  await runNeoFrontModel(service, ask, preference);
  const options = vi.mocked(query).mock.calls.at(-1)![0].options!;
  expect(options.persistSession).toBe(true);
  expect(options.resume ?? options.sessionId).toBeTruthy();
});

test('reads the SDK structured reply instead of silently rejecting non-JSON assistant text', async () => {
  vi.mocked(query).mockImplementation(async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      structured_output: { kind: 'chat', text: 'Hello!' },
    };
  } as unknown as typeof query);
  expect(await runNeoFrontModel(service, ask, preference)).toBe('Hello!');
  expect(vi.mocked(query).mock.calls.at(-1)![0].options?.outputFormat).toMatchObject({
    type: 'json_schema',
  });
});

test('uses the JSON Schema draft accepted by the SDK CLI', async () => {
  await runNeoFrontModel(service, ask, preference);
  expect(vi.mocked(query).mock.calls.at(-1)![0].options?.outputFormat).toMatchObject({
    schema: { $schema: 'http://json-schema.org/draft-07/schema#' },
  });
});

test('the deadline grows with the selected thinking budget', async () => {
  const { frontDeadlineMs } = await import('../../../../src/lib/neo/front-model.ts');
  expect(frontDeadlineMs('off')).toBe(15_000);
  expect(frontDeadlineMs('think8k')).toBe(23_000);
  expect(frontDeadlineMs('think64k')).toBe(78_999);
  expect(frontDeadlineMs('think64k')).toBeGreaterThan(frontDeadlineMs('think8k'));
});
