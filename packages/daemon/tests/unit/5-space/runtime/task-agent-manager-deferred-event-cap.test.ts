import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';

const SESSION_ID = 'session-cap';
const RUN_ID = 'run-cap';
const NODE_ID = 'node-build';
const AGENT_NAME = 'coder';
const PR_URL = 'https://github.com/lsm/HyperNeo/pull/2828';

function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 23, hour, minute);
}

function essenceText(eventId: string, occurredAt: number): string {
  const event: ExternalEventPublishedPayload = {
    namespaceId: 'ns',
    spaceId: 'space-1',
    eventId,
    source: 'github',
    topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
    dedupeKey: eventId,
    summary: 'summary',
    externalUrl: `${PR_URL}#${eventId}`,
    occurredAt,
    ingestedAt: occurredAt,
    payload: {
      eventType: 'check_run',
      action: 'polled',
      actor: 'github-actions[bot]',
      repoOwner: 'lsm',
      repoName: 'HyperNeo',
      prNumber: 2828,
      prUrl: PR_URL,
      body: '',
      checkName: 'Build Binary (linux-x64)',
      conclusion: 'failure',
    },
  };
  return formatExternalEventEssence(event);
}

function deferredRow(
  dbId: string,
  uuid: string,
  text: string
): SDKUserMessage & {
  dbId: string;
  timestamp: number;
} {
  return {
    type: 'user',
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    dbId,
    timestamp: 0,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SDKUserMessage & { dbId: string; timestamp: number };
}

function makeHarness(existingDeferredRows: Array<SDKUserMessage & { dbId: string }>): {
  manager: TaskAgentManager;
  savedRows: Array<{ message: SDKUserMessage; sendStatus: string }>;
  statusUpdates: Array<{ dbIds: string[]; status: string }>;
} {
  const savedRows: Array<{ message: SDKUserMessage; sendStatus: string }> = [];
  const statusUpdates: Array<{ dbIds: string[]; status: string }> = [];
  const session = {
    session: { id: SESSION_ID },
    getProcessingState: () => ({ status: 'processing' }),
    handleQueryTrigger: mock(async () => ({ success: true, messageCount: 0 })),
    ensureQueryStarted: mock(async () => {}),
    clearConversationContext: mock(async () => {}),
    messageQueue: { enqueueWithId: mock(async () => {}), size: () => 0 },
  } as unknown as AgentSession;

  const config = {
    db: {
      getDatabase: () => ({}),
      saveUserMessage: mock((_sessionId: string, message: SDKUserMessage, sendStatus: string) => {
        savedRows.push({ message, sendStatus });
        return `db-saved-${savedRows.length}`;
      }),
      updateMessageStatus: mock((dbIds: string[], status: string) => {
        statusUpdates.push({ dbIds, status });
      }),
      getUserMessagesByStatus: mock((_sessionId: string, status: string) =>
        status === 'deferred'
          ? { messages: existingDeferredRows, total: existingDeferredRows.length }
          : { messages: [], total: 0 }
      ),
      getUserMessageIdsByStatus: mock(() => []),
      getSDKMessageRepo: () => ({
        getDeliveryContent: () => null,
        reopenDeliveryByUuid: () => null,
        markDeliveryFailedByUuid: () => null,
        markDeliveryDeferredByUuid: () => null,
      }),
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () => new Set<string>(),
        getActiveDeliveryRole: () => null,
      }),
    },
    internalEventBus: {
      subscribe: mock(() => () => {}),
      publish: mock(async () => {}),
    },
    nodeExecutionRepo: {
      getByAgentSessionId: () => ({
        workflowRunId: RUN_ID,
        workflowNodeId: NODE_ID,
        agentName: AGENT_NAME,
        agentSessionId: SESSION_ID,
      }),
      listByAgentSessionId: () => [],
    },
    workflowRunRepo: { getRun: () => ({ workflowId: 'wf-cap' }) },
    taskRepo: {
      getTask: () => null,
      listByWorkflowRunIncludingArchived: () => [],
    },
    spaceWorkflowManager: {
      getWorkflow: () => ({
        nodes: [{ id: NODE_ID, name: 'Build', agents: [{ agentId: 'Coder', name: AGENT_NAME }] }],
      }),
      getWorkflowForRun: () => ({
        nodes: [{ id: NODE_ID, name: 'Build', agents: [{ agentId: 'Coder', name: AGENT_NAME }] }],
      }),
    },
  } as unknown as TaskAgentManagerConfig;

  const manager = new TaskAgentManager(config);
  (manager as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
    SESSION_ID,
    session
  );
  return { manager, savedRows, statusUpdates };
}

function rowText(message: SDKUserMessage): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) return '';
  const block = content[0] as { text?: unknown } | undefined;
  return typeof block?.text === 'string' ? block.text : '';
}

describe('TaskAgentManager deferred external-event backlog cap', () => {
  const previousFlag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
  beforeAll(() => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousFlag;
  });

  it('folds the oldest overflow rows into an early digest envelope above the cap', async () => {
    const rows = Array.from({ length: 101 }, (_, i) =>
      deferredRow(`db-${i}`, `uuid-${i}`, essenceText(`chk-${i}`, at(15) + i * 1000))
    );
    const { manager, savedRows, statusUpdates } = makeHarness(rows);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      essenceText('chk-new', at(16, 40)),
      true,
      undefined,
      'defer',
      'system'
    );

    expect(savedRows).toHaveLength(2);
    expect(savedRows[0]?.sendStatus).toBe('deferred');
    expect(savedRows[1]?.sendStatus).toBe('deferred');

    const envelope = JSON.parse(rowText(savedRows[1]!.message)) as {
      type: string;
      events: Array<{ eventId: string }>;
    };
    expect(envelope.type).toBe('external_event_digest');
    expect(envelope.events.map((event) => event.eventId)).toEqual(['chk-0', 'chk-1']);

    expect(statusUpdates).toContainEqual({ dbIds: ['db-0', 'db-1'], status: 'consumed' });
  });

  it('leaves a backlog under the cap untouched', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      deferredRow(`db-${i}`, `uuid-${i}`, essenceText(`chk-${i}`, at(15) + i * 1000))
    );
    const { manager, savedRows, statusUpdates } = makeHarness(rows);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      essenceText('chk-new', at(16, 40)),
      true,
      undefined,
      'defer',
      'system'
    );

    expect(savedRows).toHaveLength(1);
    expect(statusUpdates).toEqual([]);
  });

  it('skips cap enforcement for non-external-event deferrals', async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      deferredRow(`db-${i}`, `uuid-${i}`, 'plain deferred message')
    );
    const { manager, savedRows, statusUpdates } = makeHarness(rows);

    await manager.injectSubSessionMessage(
      SESSION_ID,
      '─── Message from coder ───',
      true,
      undefined,
      'defer',
      'system'
    );

    expect(savedRows).toHaveLength(1);
    expect(statusUpdates).toEqual([]);
  });
});
