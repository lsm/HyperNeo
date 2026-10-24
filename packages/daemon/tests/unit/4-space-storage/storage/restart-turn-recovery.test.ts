import { beforeEach, describe, expect, test } from 'bun:test';
import { backfillSdkMessageColumns } from '../../../../src/storage/schema/m413-sdk-message-columns';
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
import { fillSdkMessageFixtureColumns } from '../../helpers/sdk-message-fixture-columns';

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
    expect(planRestartRecovery('s', { evidence, deliveryActive })).toEqual(expected);
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
      resend: (id, uuid, enqueueDelivery) => {
        calls.push(`resend ${id} ${uuid} ${enqueueDelivery}`);
        return true;
      },
      sendNote: async (id, uuid) => {
        calls.push(`note ${id} ${uuid}`);
        return id !== 'busy';
      },
    };
    const plans = await recoverRestartCutTurns(['fresh', 'busy', 'empty'], deps);
    expect(calls).toEqual(['resend fresh p1 true', 'note busy p2']);
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
  ) => {
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `m${++id}`,
      sessionId,
      type,
      JSON.stringify(message),
      at,
      extra.status ?? null,
      extra.uuid ?? null
    );
    fillSdkMessageFixtureColumns(db);
  };
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
    expect(sessions.listProcessingSessionIds().sort()).toEqual(['asked', 'working']);
  });

  test('restart recovery waits for projection evidence instead of resending a tool result', async () => {
    row('asked', 'user', '2026-10-23T00:00:00Z', prompt('retained request'), {
      uuid: 'request',
      status: 'consumed',
    });
    row('asked', 'user', '2026-10-23T00:00:01Z', toolResult, {
      uuid: 'tool-result',
      status: 'consumed',
    });
    db.exec(
      "UPDATE sdk_messages SET has_tool_result=NULL; DELETE FROM migration_markers WHERE key='sdk_message_columns_backfilled_v2'"
    );
    expect(sdk.readRestartRecoveryEvidence('asked')?.promptUuid).toBe('tool-result');
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resent: string[] = [];
    const deps: RestartRecoveryDeps = {
      readEvidence: async () => {
        await ready;
        return sdk.readRestartRecoveryEvidence('asked');
      },
      hasActiveDelivery: () => false,
      resend: (_id: string, uuid: string) => {
        resent.push(uuid);
        return true;
      },
      sendNote: async () => false,
    };
    const recovery = recoverRestartCutTurns(['asked'], deps);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resent).toEqual([]);
      await backfillSdkMessageColumns(db, () => {});
      release();
      await recovery;
      expect(resent).toEqual(['request']);
      expect(sdk.getDeliveryContent('asked', 'tool-result')?.sendStatus).toBe('consumed');
    } finally {
      release();
      await recovery;
    }
  });

  test('the cut-off prompt reopens for delivery through the shared retry transition', () => {
    row('asked', 'user', '2026-10-11T02:00:00.000Z', prompt('new'), {
      uuid: 'u1',
      status: 'consumed',
    });
    expect(sdk.markDeliveryRetryableByUuid('asked', 'u1')).not.toBeNull();
    expect(sdk.getDeliveryContent('asked', 'u1')?.sendStatus).toBe('enqueued');
  });

  test('a cooldown cut off by the restart resumes once, at its retry time', () => {
    expect(sessions.markRestartInterruptedTurns()).toBe(4);
    expect(sessions.listRestartCooldownResumes()).toEqual([{ sessionId: 'cooling', resumeAt: 1 }]);
    expect(sessions.takeRestartCooldownResume('cooling')).toBe(true);
    expect(sessions.takeRestartCooldownResume('cooling')).toBe(false);
    expect(sessions.listRestartCooldownResumes()).toEqual([]);
    expect(JSON.parse(sessions.getSession('cooling')?.processingState ?? '{}')).toEqual({
      status: 'interrupted',
      reason: 'restart',
      messageId: 'x',
    });
  });

  test('archived sessions are not resumed', () => {
    sessions.updateSession('asked', { status: 'archived' });
    expect(sessions.listProcessingSessionIds()).toEqual(['working']);
  });
});
