import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import {
  QueryModeHandler,
  type QueryModeHandlerContext,
} from '../../../../src/lib/agent/query-mode-handler';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';

const SESSION_ID = 'session-digest';

function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 23, hour, minute);
}

function essenceText(args: {
  eventId: string;
  topic: string;
  eventType: string;
  occurredAt: number;
  actor?: string;
  body?: string;
  extra?: Record<string, unknown>;
}): string {
  const event: ExternalEventPublishedPayload = {
    namespaceId: 'ns',
    spaceId: 'space-1',
    eventId: args.eventId,
    source: 'github',
    topic: args.topic,
    dedupeKey: args.eventId,
    summary: 'summary',
    externalUrl: `https://github.com/lsm/HyperNeo/pull/2828#${args.eventId}`,
    occurredAt: args.occurredAt,
    ingestedAt: args.occurredAt,
    payload: {
      eventType: args.eventType,
      action: 'polled',
      actor: args.actor ?? 'codex[bot]',
      repoOwner: 'lsm',
      repoName: 'HyperNeo',
      prNumber: 2828,
      prUrl: 'https://github.com/lsm/HyperNeo/pull/2828',
      body: args.body ?? '',
      ...args.extra,
    },
  };
  return formatExternalEventEssence(event);
}

function checkText(eventId: string, occurredAt: number): string {
  return essenceText({
    eventId,
    topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
    eventType: 'check_run',
    occurredAt,
    extra: { checkName: 'Build Binary (linux-x64)', conclusion: 'failure' },
  });
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
    isSynthetic: true,
    inputKind: 'system',
    dbId,
    timestamp: 0,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as SDKUserMessage & { dbId: string; timestamp: number };
}

describe('QueryModeHandler deferred external-event digest flush', () => {
  let handler: QueryModeHandler;
  let deferredRows: Array<SDKUserMessage & { dbId: string; timestamp: number }>;
  let savedRows: Array<{ message: SDKUserMessage; sendStatus: string }>;
  let statusUpdates: Array<{ dbIds: string[]; status: string }>;
  let enqueued: Array<{ uuid: string; content: unknown }>;
  let published: Array<{ messageIds: string[]; status: string }>;
  let v2Previous: string | undefined;

  beforeEach(() => {
    v2Previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    deferredRows = [];
    savedRows = [];
    statusUpdates = [];
    enqueued = [];
    published = [];

    const session = {
      id: SESSION_ID,
      title: 'Digest',
      workspacePath: '/test',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1 },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    } as unknown as Session;

    const db = {
      getUserMessagesByStatus: mock((_sessionId: string, _status: string) => ({
        messages: deferredRows,
        total: deferredRows.length,
      })),
      updateMessageStatus: mock((dbIds: string[], status: string) => {
        statusUpdates.push({ dbIds, status });
      }),
      saveUserMessage: mock((_sessionId: string, message: SDKUserMessage, sendStatus: string) => {
        savedRows.push({ message, sendStatus });
        return `db-digest-${savedRows.length}`;
      }),
      getSDKMessageRepo: () => ({
        getMessageByStatusAndUuid: () => null,
      }),
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () => new Set<string>(),
        hasActiveTurnDeliveryJob: () => false,
      }),
    } as unknown as Database;

    const internalEventBus = {
      publish: mock(async (event: string, payload: { messageIds?: string[]; status?: string }) => {
        if (event === 'messages.statusChanged') {
          published.push({ messageIds: payload.messageIds ?? [], status: payload.status ?? '' });
        }
      }),
      publishAsync: mock(async () => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<any>;

    const messageQueue = {
      enqueueWithId: mock(async (uuid: string, content: unknown) => {
        enqueued.push({ uuid, content });
      }),
      hasPendingOrInFlight: mock(() => false),
      size: mock(() => 0),
    } as unknown as MessageQueue;

    const logger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    const context: QueryModeHandlerContext = {
      session,
      db,
      internalEventBus,
      messageQueue,
      logger,
      ensureQueryStarted: mock(async () => {}),
    };
    handler = new QueryModeHandler(context);
  });

  afterEach(() => {
    if (v2Previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = v2Previous;
  });

  it('flushes a mixed deferred external-event backlog as one digest and keeps task input individual', async () => {
    deferredRows = [
      deferredRow('db-task', 'uuid-task', '─── Message from coder ───'),
      deferredRow('db-check-1', 'uuid-check-1', checkText('chk-1', at(15, 5))),
      deferredRow('db-check-2', 'uuid-check-2', checkText('chk-2', at(16, 34))),
      deferredRow(
        'db-reaction-1',
        'uuid-reaction-1',
        essenceText({
          eventId: 're-1',
          topic: 'github/lsm/hyperneo/pull_request/2828.reaction_added',
          eventType: 'reaction',
          occurredAt: at(15, 10),
          body: '👍',
        })
      ),
    ];

    const result = await handler.handleQueryTrigger({
      deliverIndividually: true,
      skipResetCoordination: true,
    });

    expect(result.success).toBe(true);

    expect(savedRows).toHaveLength(1);
    expect(savedRows[0]?.sendStatus).toBe('enqueued');
    const digestText =
      (savedRows[0]?.message.message?.content as Array<{ type: string; text?: string }>)[0]?.text ??
      '';
    expect(digestText).toContain('External events while you were working (3 events, PR #2828):');
    expect(digestText).toContain('CI check "Build Binary (linux-x64)": failure ×2');
    expect(digestText).toContain('latest 16:34 UTC');
    expect(digestText).toContain('Reactions on PR #2828: ×1');

    expect(statusUpdates).toContainEqual({
      dbIds: ['db-check-1', 'db-check-2', 'db-reaction-1'],
      status: 'consumed',
    });
    expect(published).toContainEqual({
      messageIds: ['db-check-1', 'db-check-2', 'db-reaction-1'],
      status: 'consumed',
    });

    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]?.uuid).toBe('uuid-task');
    expect(enqueued[0]?.content).toBe('─── Message from coder ───');
    const digestDelivery = enqueued[1]!;
    expect(digestDelivery.uuid).toBe(savedRows[0]?.message.uuid);
    expect(String(digestDelivery.content)).toContain('(3 events, PR #2828):');
  });

  it('delivers a subsequent normal deferred message individually without a digest', async () => {
    deferredRows = [deferredRow('db-human', 'uuid-human', 'a human follow-up')];

    const result = await handler.handleQueryTrigger({
      deliverIndividually: true,
      skipResetCoordination: true,
    });

    expect(result.success).toBe(true);
    expect(savedRows).toHaveLength(0);
    expect(statusUpdates).toEqual([{ dbIds: ['db-human'], status: 'enqueued' }]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.uuid).toBe('uuid-human');
  });

  it('does not fold the excluded in-flight message even when it is an external event', async () => {
    deferredRows = [
      deferredRow('db-kept', 'uuid-kept', checkText('chk-kept', at(15))),
      deferredRow('db-current', 'uuid-current', checkText('chk-current', at(16))),
    ];

    const result = await handler.handleQueryTrigger({
      deliverIndividually: true,
      excludeMessageUuid: 'uuid-current',
      skipResetCoordination: true,
    });

    expect(result.success).toBe(true);
    expect(savedRows).toHaveLength(1);
    expect(statusUpdates).toContainEqual({ dbIds: ['db-kept'], status: 'consumed' });
    expect(statusUpdates.some((update) => update.dbIds.includes('db-current'))).toBe(false);
  });

  it('folds an early-overflow envelope row into the turn-end digest', async () => {
    const envelope = JSON.stringify({
      type: 'external_event_digest',
      events: [
        {
          eventId: 'env-1',
          topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
          repo: 'lsm/HyperNeo',
          prNumber: 2828,
          checkName: 'Build Binary (linux-x64)',
          conclusion: 'failure',
        },
      ],
    });
    deferredRows = [
      deferredRow('db-envelope', 'uuid-envelope', envelope),
      deferredRow('db-fresh', 'uuid-fresh', checkText('chk-fresh', at(16, 34))),
    ];

    const result = await handler.handleQueryTrigger({ skipResetCoordination: true });

    expect(result.success).toBe(true);
    expect(savedRows).toHaveLength(1);
    const digestText =
      (savedRows[0]?.message.message?.content as Array<{ type: string; text?: string }>)[0]?.text ??
      '';
    expect(digestText).toContain('(2 events, PR #2828):');
    expect(digestText).toContain('failure ×2');
    expect(statusUpdates).toContainEqual({
      dbIds: ['db-envelope', 'db-fresh'],
      status: 'consumed',
    });
  });
});
