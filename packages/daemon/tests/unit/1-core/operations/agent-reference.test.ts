import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createAgentSessionResolver,
  createResolveAgentOperation,
  pickByReference,
  resolveAgentReference,
  type AgentReferenceLookups,
} from '../../../../src/lib/agents/agent-reference';
import { createSendMessageOperation } from '../../../../src/lib/messaging/message-send';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { parseMailboxEntry } from '../../../../src/lib/mailbox/entry';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const lookups: AgentReferenceLookups = {
  listSpaces: () => [
    { id: 'space-dev', slug: 'dev-neokai', name: 'dev-neokai' },
    { id: 'space-ops', slug: 'ops', name: 'Operations' },
  ],
  listAgents: (spaceId) =>
    spaceId === 'space-dev'
      ? [
          { id: 'agent-ui', handle: 'ui-ux', displayName: 'UI / UX' },
          { id: 'agent-asr', handle: 'macos-local-asr', displayName: 'Research' },
          { id: 'agent-meta', handle: 'meta-research', displayName: 'Research' },
        ]
      : [],
};

describe('pickByReference', () => {
  const rows = ['alpha', 'beta'];
  const passes = [(row: string, needle: string) => row === needle];

  test('returns the single match', () => {
    expect(pickByReference('alpha', 'thing', rows, passes, (row) => row)).toEqual({
      value: 'alpha',
    });
  });

  test('lists what exists when nothing matches', () => {
    expect(pickByReference('gamma', 'thing', rows, passes, (row) => row)).toEqual({
      reason: 'No thing matches "gamma"; known: alpha, beta',
    });
  });
});

describe('resolveAgentReference', () => {
  test.each([
    ['agent-ui', 'id'],
    ['@ui-ux', 'handle with @'],
    ['UI-UX', 'handle without @, any case'],
    ['ui / ux', 'display name'],
  ])('finds the agent by %s (%s)', (agent) => {
    expect(resolveAgentReference({ space: 'dev-neokai', agent }, lookups)).toEqual({
      value: {
        spaceId: 'space-dev',
        spaceSlug: 'dev-neokai',
        agentId: 'agent-ui',
        handle: '@ui-ux',
        displayName: 'UI / UX',
      },
    });
  });

  test('accepts the space by name', () => {
    expect(resolveAgentReference({ space: 'operations', agent: 'x' }, lookups)).toEqual({
      reason: 'No agent matches "x"',
    });
  });

  test('rejects an ambiguous display name with the candidates', () => {
    expect(resolveAgentReference({ space: 'dev-neokai', agent: 'Research' }, lookups)).toEqual({
      reason:
        'agent "Research" is ambiguous; use one of: @macos-local-asr (Research), @meta-research (Research)',
    });
  });

  test('rejects an unknown space with the known slugs', () => {
    expect(resolveAgentReference({ space: 'nope', agent: 'ui-ux' }, lookups)).toEqual({
      reason: 'No space matches "nope"; known: dev-neokai, ops',
    });
  });
});

describe('agent.resolve operation', () => {
  test('returns the resolved agent without starting a session', async () => {
    const registry = createOperationRegistry([createResolveAgentOperation(lookups)]);
    expect(
      await invokeOperation(
        registry,
        'agent.resolve',
        { space: 'dev-neokai', agent: '@ui-ux' },
        { source: 'rpc' }
      )
    ).toMatchObject({
      kind: 'completed',
      value: { resolved: true, agent: { agentId: 'agent-ui', handle: '@ui-ux' } },
    });
  });
});

describe('message.send to an agent', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });
  afterEach(() => mailbox.close());

  const message = { type: 'user', message: { content: 'font size?' }, parent_tool_use_id: null };

  test('finds or starts the agent session and queues the message there', async () => {
    const ensure = mock(async () => ({ kind: 'resolved' as const, sessionId: 'agent-ui-session' }));
    const registry = createOperationRegistry([
      createSendMessageOperation(
        mailbox.jobQueue,
        (sessionId) => (sessionId === 'agent-ui-session' ? 'active' : null),
        undefined,
        createAgentSessionResolver(lookups, ensure)
      ),
    ]);
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { agent: { space: 'dev-neokai', agent: '@ui-ux' }, message },
      { source: 'mcp', sessionId: 'neo:root' }
    );
    expect(outcome).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(ensure).toHaveBeenCalledWith({
      kind: 'agent',
      spaceId: 'space-dev',
      agentId: 'agent-ui',
    });
    expect(parseMailboxEntry(JSON.parse(mailbox.rows()[0].payload))?.to).toEqual({
      kind: 'session',
      sessionId: 'agent-ui-session',
    });
  });

  test('rejects when the agent session cannot be started', async () => {
    const registry = createOperationRegistry([
      createSendMessageOperation(
        mailbox.jobQueue,
        () => 'active',
        undefined,
        createAgentSessionResolver(lookups, async () => ({
          kind: 'unresolved',
          reason: 'ensure_failed',
        }))
      ),
    ]);
    expect(
      await invokeOperation(
        registry,
        'message.send',
        { agent: { space: 'dev-neokai', agent: 'ui-ux' }, message },
        { source: 'mcp', sessionId: 'neo:root' }
      )
    ).toEqual({
      kind: 'completed',
      value: {
        kind: 'rejected',
        reason: '@ui-ux in dev-neokai has no session that can receive messages (ensure_failed)',
      },
    });
    expect(mailbox.rowCount()).toBe(0);
  });

  test('requires exactly one of sessionId or agent', async () => {
    const registry = createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, () => 'active'),
    ]);
    const outcome = await invokeOperation(
      registry,
      'message.send',
      { sessionId: 's', agent: { space: 'dev-neokai', agent: 'ui-ux' }, message },
      { source: 'mcp', sessionId: 'neo:root' }
    );
    expect(outcome.kind).toBe('failed');
    expect(mailbox.rowCount()).toBe(0);
  });
});
