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
const service = { db: { gateway: { run: read } }, wakeNeo: note } as unknown as NeoService;
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
  expect(await runNeoFrontModel(service, ask, preference)).toBeNull();
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
  expect(await runNeoFrontModel(service, ask, preference)).toBeNull();
});
test('each invocation discards reads and refuses a second lookup', async () => {
  vi.mocked(query).mockImplementation(async function* () {
    await tools[0].handler({ text: 'Project' });
    const repeated = await tools[1].handler({});
    expect(repeated).toMatchObject({ isError: true });
    yield response('status', 'Done.');
  } as unknown as typeof query);
  expect(await runNeoFrontModel(service, ask, preference)).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  vi.mocked(query).mockImplementation(async function* () {
    yield response('status', 'Done.');
  } as unknown as typeof query);
  expect(await runNeoFrontModel(service, ask, preference)).toBeNull();
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
