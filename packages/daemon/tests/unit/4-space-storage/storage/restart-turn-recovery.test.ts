import { beforeEach, describe, expect, test } from 'bun:test';
import {
  planRestartRecovery,
  type RestartRecoveryDeps,
  recoverRestartCutTurns,
} from '../../../../src/lib/agent/restart-turn-recovery';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTestSession } from '../../../helpers/database';

describe('planRestartRecovery', () => {
  test.each([
    ['no prompt', null, false, { kind: 'skip', sessionId: 's', reason: 'no_prompt' }],
    [
      'a prompt nothing answered',
      { promptUuid: 'p', workedAfter: false },
      false,
      { kind: 'resend', sessionId: 's', uuid: 'p', enqueueDelivery: true },
    ],
    [
      'a prompt whose stale delivery is still queued',
      { promptUuid: 'p', workedAfter: false },
      true,
      { kind: 'resend', sessionId: 's', uuid: 'p', enqueueDelivery: false },
    ],
    [
      'a turn that had already worked',
      { promptUuid: 'p', workedAfter: true },
      false,
      { kind: 'continue', sessionId: 's', promptUuid: 'p' },
    ],
  ] as const)('%s', (_label, evidence, deliveryActive, expected) => {
    expect(
      planRestartRecovery({ sessionId: 's', resumeAt: 0 }, { evidence, deliveryActive })
    ).toEqual(expected);
  });

  test('a cut-off cooldown resumes at its retry time', () => {
    const turn = { sessionId: 's', resumeAt: 5000 };
    expect(
      planRestartRecovery(turn, {
        evidence: { promptUuid: 'p', workedAfter: false },
        deliveryActive: false,
      })
    ).toEqual({ kind: 'resend', sessionId: 's', uuid: 'p', enqueueDelivery: true, runAt: 5000 });
    expect(
      planRestartRecovery(turn, {
        evidence: { promptUuid: 'p', workedAfter: true },
        deliveryActive: false,
      })
    ).toEqual({ kind: 'continue', sessionId: 's', promptUuid: 'p', runAt: 5000 });
  });
});

describe('recoverRestartCutTurns', () => {
  test('re-sends an unanswered prompt, notes a partial turn, and skips the rest', async () => {
    const calls: string[] = [];
    const deps: RestartRecoveryDeps = {
      readEvidence: (id) =>
        id === 'fresh'
          ? { promptUuid: 'p1', workedAfter: false }
          : id === 'busy'
            ? { promptUuid: 'p2', workedAfter: true }
            : null,
      hasActiveDelivery: () => false,
      resend: (id, uuid, enqueueDelivery, runAt) => {
        calls.push(`resend ${id} ${uuid} ${enqueueDelivery} ${runAt}`);
        return true;
      },
      sendNote: async (id, uuid, runAt) => {
        calls.push(`note ${id} ${uuid} ${runAt}`);
        return id !== 'busy';
      },
    };
    const plans = await recoverRestartCutTurns(
      [
        { sessionId: 'fresh', resumeAt: 0 },
        { sessionId: 'busy', resumeAt: 9000 },
        { sessionId: 'empty', resumeAt: 0 },
      ],
      deps
    );
    expect(calls).toEqual(['resend fresh p1 true undefined', 'note busy p2 9000']);
    expect(plans.map((plan) => [plan.kind, plan.resumed])).toEqual([
      ['resend', true],
      ['continue', false],
      ['skip', false],
    ]);
  });
});

describe('restart recovery reads', () => {
  let db: Database;
  let sdk: SDKMessageRepository;
  let sessions: SessionRepository;
  let id = 0;
  const row = (
    sessionId: string,
    type: string,
    at: string,
    message: unknown,
    extra: { uuid?: string; status?: string } = {}
  ) =>
    db
      .prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `m${++id}`,
        sessionId,
        type,
        JSON.stringify(message),
        at,
        extra.status ?? null,
        extra.uuid ?? null
      );
  const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
  const toolResult = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  };

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    sdk = new SDKMessageRepository(db);
    sessions = new SessionRepository(db);
    for (const sessionId of ['asked', 'working', 'idle', 'space-worker', 'cooling'])
      sessions.createSession(
        {
          ...createTestSession(sessionId),
          ...(sessionId === 'space-worker' ? { context: { spaceId: 'space-1' } } : {}),
          processingState: JSON.stringify(
            sessionId === 'idle'
              ? { status: 'idle' }
              : sessionId === 'cooling'
                ? { status: 'rate_limit_cooldown', messageId: 'x', retryAt: 1 }
                : { status: 'processing', messageId: 'x' }
          ),
        },
        { enforceWorkspaceOwnership: false }
      );
  });

  test('finds the cut-off prompt and whether the turn had already worked', () => {
    row('asked', 'user', '2026-10-11T01:00:00.000Z', prompt('old'), {
      uuid: 'u0',
      status: 'consumed',
    });
    row('asked', 'assistant', '2026-10-11T01:00:05.000Z', { type: 'assistant' });
    row('asked', 'user', '2026-10-11T02:00:00.000Z', prompt('new'), {
      uuid: 'u1',
      status: 'consumed',
    });
    row('working', 'user', '2026-10-11T03:00:00.000Z', prompt('go'), {
      uuid: 'u2',
      status: 'consumed',
    });
    row('working', 'assistant', '2026-10-11T03:00:05.000Z', { type: 'assistant' });
    row('working', 'user', '2026-10-11T03:00:06.000Z', toolResult, {
      uuid: 'u3',
      status: 'consumed',
    });
    row(
      'working',
      'user',
      '2026-10-11T03:00:07.000Z',
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'reminder' },
            { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
          ],
        },
      },
      { uuid: 'u4', status: 'consumed' }
    );
    expect(sdk.readRestartRecoveryEvidence('asked')).toEqual({
      promptUuid: 'u1',
      workedAfter: false,
    });
    expect(sdk.readRestartRecoveryEvidence('working')).toEqual({
      promptUuid: 'u2',
      workedAfter: true,
    });
    expect(sdk.readRestartRecoveryEvidence('idle')).toBeNull();
    expect(
      sessions.listRestartCutTurns().sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    ).toEqual([
      { sessionId: 'asked', resumeAt: 0 },
      { sessionId: 'cooling', resumeAt: 1 },
      { sessionId: 'working', resumeAt: 0 },
    ]);
  });

  test('the cut-off prompt reopens for delivery through the shared retry transition', () => {
    row('asked', 'user', '2026-10-11T02:00:00.000Z', prompt('new'), {
      uuid: 'u1',
      status: 'consumed',
    });
    expect(sdk.markDeliveryRetryableByUuid('asked', 'u1')).not.toBeNull();
    expect(sdk.getDeliveryContent('asked', 'u1')?.sendStatus).toBe('enqueued');
  });

  test('a cooldown cut off by the restart is marked interrupted and not listed again', () => {
    expect(sessions.markRestartInterruptedTurns()).toBe(4);
    expect(JSON.parse(sessions.getSession('cooling')?.processingState ?? '{}')).toEqual({
      status: 'interrupted',
      reason: 'restart',
      messageId: 'x',
    });
    expect(sessions.listRestartCutTurns()).toEqual([]);
  });

  test('archived sessions are not resumed', () => {
    sessions.updateSession('asked', { status: 'archived' });
    expect(
      sessions
        .listRestartCutTurns()
        .map((turn) => turn.sessionId)
        .sort()
    ).toEqual(['cooling', 'working']);
  });
});
