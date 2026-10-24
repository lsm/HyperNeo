import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service.ts';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../../../../src/lib/external-events/session-external-event-store.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { isSessionTopicCovered } from '../../../../src/lib/external-events/topic-trie.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const PR = 'https://github.com/lsm/HyperNeo/pull/7';
const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 'local_worker' };
const open = {
  url: PR,
  state: 'OPEN' as const,
  checks: 'passing' as const,
  review: 'none' as const,
};

describe('isSessionTopicCovered', () => {
  const followed = [{ session: 's9', topic: 'github/lsm/HyperNeo/pull_request/7.*' }];
  test.each([
    ['the same PR pattern', 's9', 'github/lsm/hyperneo/pull_request/7.*', true],
    ['one of its events', 's9', 'github/lsm/hyperneo/pull_request/7.review_submitted', true],
    ['a narrower pattern', 's9', 'github/lsm/hyperneo/pull_request/7.review_*', true],
    ['another PR', 's9', 'github/lsm/hyperneo/pull_request/8.*', false],
    ['every PR', 's9', 'github/lsm/hyperneo/pull_request/*', false],
    ['another session', 's1', 'github/lsm/hyperneo/pull_request/7.*', false],
  ] as const)('%s: %s', (_label, session, topic, covered) => {
    expect(isSessionTopicCovered(followed, session, topic)).toBe(covered);
  });
});

describe('Neo todo pull request events', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  let publisher: ExternalEventService;
  let sent: { ref: unknown; message: string }[];
  let prs: NeoWorkPr[];
  let sendFails: boolean;

  beforeEach(async () => {
    db = await createTestDb();
    await db.createSession(createTestSession('root'));
    sent = [];
    prs = [open];
    sendFails = false;
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.send',
        description: 'test send',
        inputSchema: z.object({ ref: z.unknown(), message: z.string() }),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'mutate' },
        execute: async (input: { ref: unknown; message: string }) => {
          sent.push(input);
          return sendFails
            ? { ok: false, reason: 'unreachable' }
            : { ok: true, value: { delivered: true } };
        },
      }),
    ]);
    const bus = new InternalEventBus<DaemonInternalEventMap>();
    service = createNeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      bus
    );
    service.readPrs = async () => prs;
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', projectId: null });
    publisher = new ExternalEventService(new SessionExternalEventStore(db.getDatabase()), bus);
    service.todos.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'root',
      originMessageId: null,
      title: 'Ship fix',
      request: 'Fix and merge',
      createdAt: Date.now(),
    });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  function todo(target: WorkRef = ref, id = 'todo') {
    const row = service.todos.addTodo(
      id,
      'ask',
      {
        title: 'Fix the bug',
        instruction: 'Fix and merge',
        doneWhen: 'PR merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [PR] } },
        named: null,
      },
      1
    );
    service.todoSessions.create(row.id, { verb: 'send', ref: target });
    service.todoSessions.recordRef(row.id, target, 2);
    const doing = service.todos.updateTodo(row, { state: 'doing', report: `Opened ${PR}` }, 2);
    service.todoPrs.claim(row.id, [{ url: PR, claim: 'named' }], 1);
    service.todoPrs.record(row.id, prs, 2);
    return doing;
  }
  const jobs = () =>
    db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'root' });
  let seq = 0;
  async function event(
    action: string,
    payload: Record<string, unknown> = {},
    occurredAt = Date.now()
  ) {
    const record: ExternalEvent = {
      id: `event-${++seq}`,
      spaceId: SESSION_EVENT_SCOPE,
      source: 'github',
      topic: `github/lsm/hyperneo/pull_request/7.${action}`,
      dedupeKey: `pr7:${action}:${seq}`,
      occurredAt,
      ingestedAt: Date.now(),
      summary: `PR #7 ${action}`,
      payload: { prUrl: PR, prNumber: 7, actor: 'hyperneo-ai-test[bot]', ...payload },
      render: `PR #7 ${action}`,
    };
    await publisher.publish(record);
  }

  test('archived local workers are never card-event targets', async () => {
    await db.createSession({ ...createTestSession('archived-worker'), status: 'archived' });
    todo({ adapter: 'hyperneo', id: 'archived-worker' });
    await event('review_submitted', { body: 'Fresh review' });
    expect(sent).toHaveLength(0);
    expect(db.getSession('archived-worker')?.status).toBe('archived');
  });

  test('archived subscriptions remain stored but are not delivery targets', async () => {
    await db.createSession({ ...createTestSession('archived-worker'), status: 'archived' });
    const subscriptions = new SessionEventSubscriptionRepository(db.getDatabase());
    subscriptions.upsert({
      sessionId: 'archived-worker',
      topic: 'github/lsm/hyperneo/pull_request/7.*',
    });
    expect(subscriptions.listAll()).toHaveLength(0);
    expect(subscriptions.listBySession('archived-worker')).toHaveLength(1);
  });

  test.each(['review_submitted', 'review_comment_created', 'comment_created', 'comment_polled'])(
    'raw %s leaves worker messaging to the ledger',
    async (action) => {
      todo();
      await event(action, { body: 'Please handle the empty result.', state: 'changes_requested' });
      expect(sent).toEqual([]);
      expect(jobs()).toEqual([]);
    }
  );
  test.each(['review_submitted', 'review_comment_created', 'comment_created', 'comment_polled'])(
    'raw %s forwards neither driver-signed nor human comments',
    async (action) => {
      todo();
      await event(action, {
        body: 'Fixed.\n\n_🤖 Addressed by [Codex](https://chatgpt.com/codex)_',
      });
      expect(sent).toEqual([]);
      await event(action, { body: 'Still needs a test.' });
      expect(sent).toEqual([]);
    }
  );
  test.each(['review_submitted', 'review_comment_polled', 'comment_polled', 'reaction_added'])(
    'raw %s neither delivers nor forces completion reads or a global worker sweep',
    async (action) => {
      todo();
      await service.todoRunner.refresh(() => {});
      const reads = mock(async () => prs);
      service.readPrs = reads;
      await event(action, { body: 'Synthetic feedback', state: 'APPROVED' });
      expect(sent).toEqual([]);
      expect(reads).not.toHaveBeenCalled();
      expect(service.todos.getTodo('todo')?.state).toBe('doing');
    }
  );

  test('a raw event does not duplicate ledger delivery across subscribed todos', async () => {
    todo();
    todo(ref, 'todo-2');
    todo({ adapter: 'claude-desktop', daemon: 'laptop', id: 'local_other' }, 'todo-3');
    await event('check_failed', { checkName: 'Web Tests' });
    expect(sent).toEqual([]);
  });
  test.each([
    ['fails', async () => null],
    [
      'throws',
      async () => {
        throw new Error('gh down');
      },
    ],
  ])('a raw event never bypasses the ledger when the PR re-read %s', async (_, read) => {
    prs = [{ ...open, head: 'old' }];
    todo();
    service.readPrs = read;
    await event('check_failed', { checkName: 'Lint', headSha: 'new' });
    expect(sent).toEqual([]);
  });
  test('a merge event leaves a removed todo removed', async () => {
    const row = todo();
    service.todos.updateTodo(row, { state: 'removed' }, 3);
    prs = [{ ...open, state: 'MERGED' }];
    await event('closed', { state: 'closed', merged: true });
    expect(service.todos.getTodo(row.id)?.state).toBe('removed');
    expect(jobs()).toEqual([]);
  });

  test('raw feedback on old and new heads stays off the worker delivery path', async () => {
    prs = [{ ...open, head: 'old' }];
    todo();
    todo({ adapter: 'claude-desktop', daemon: 'laptop', id: 'local_other' }, 'todo-2');
    prs = [{ ...open, head: 'new' }];
    await event('review_comment_created', { body: 'Outdated thread', commitId: 'old' });
    await event('check_failed', { checkName: 'Lint', headSha: 'old' });
    expect(sent).toEqual([]);
    await event('check_failed', { checkName: 'Lint', headSha: 'new' });
    await event('comment_created', { body: 'No commit on this one' });
    expect(sent).toEqual([]);
  });

  test('historical head-specific feedback reuses a newer read without raw delivery', async () => {
    prs = [{ ...open, head: 'new' }];
    todo();
    await service.todoRunner.refresh(() => {});
    const reads = mock(async () => prs);
    service.readPrs = reads;
    await event('review_comment_created', { body: 'Old thread', commitId: 'old' }, 1);
    await event('review_comment_created', { body: 'Current thread', commitId: 'new' }, 1);
    expect(reads).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
  test('routine polls and pending checks do not send work to the todo session', async () => {
    todo();
    await event('polled');
    await event('check_skipped');
    await event('status_pending');
    expect(sent).toEqual([]);
  });
});
