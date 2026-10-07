import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKMessage, SDKResultSuccess, SDKUserMessage } from '@hyperneo/shared/sdk';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('Neo terminal error results', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;

  beforeEach(async () => {
    db = await createTestDb();
    for (const id of ['root', 'worker', 'other']) db.createSession(createTestSession(id));
    service = new NeoService(
      db,
      {
        createSession: mock(async () => {}),
        getSessionAsync: mock(async () => null),
      } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'root', concernId: null, kind: 'neo' });
    service.repo.reserveBinding({ sessionId: 'worker', concernId: null, kind: 'worker' });
  });

  afterEach(() => {
    service.dispose();
    db.close();
  });

  function queue() {
    const proposed = service.repo.proposeWork({
      id: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
      concernId: null,
      originSessionId: 'root',
      originMessageId: 'original-ask',
      targetSessionId: null,
      title: 'Fictional review',
      instruction: 'Only review fictional flowers.',
    });
    const work = service.repo.transitionWork(proposed.id, proposed, {
      status: 'queued',
      sessionId: 'worker',
    });
    if (!work) throw new Error('Fixture queue failed');
    const sdk = db.getSDKMessageRepo();
    sdk.saveUserMessage(
      'worker',
      {
        type: 'user',
        uuid: work.id as SDKUserMessage['uuid'],
        session_id: 'worker',
        parent_tool_use_id: null,
        message: { role: 'user', content: work.instruction },
      },
      'enqueued'
    );
    expect(sdk.markDeliveryConsumedByUuid('worker', work.id)).not.toBeNull();
    return work;
  }

  function result(extra: Record<string, unknown>, sessionId = 'worker') {
    const value = {
      type: 'result',
      subtype: 'success',
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      is_error: false,
      result: 'Fictional result',
      duration_ms: 34,
      duration_api_ms: 5,
      num_turns: 1,
      stop_reason: 'stop_sequence',
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as SDKResultSuccess['usage'],
      modelUsage: {},
      permission_denials: [],
      ...extra,
    } as SDKMessage;
    expect(db.getSDKMessageRepo().saveSDKMessage(sessionId, value)).toBe(true);
    return value;
  }

  test.each([
    { name: 'flagged success', extra: { is_error: true }, expected: 'error' },
    { name: 'unflagged success', extra: { is_error: false }, expected: null },
    { name: 'absent error flag', extra: { is_error: undefined }, expected: null },
    {
      name: 'error-looking ordinary text',
      extra: { result: 'API Error: quoted evidence' },
      expected: null,
    },
    {
      name: 'ordinary error subtype',
      extra: { subtype: 'error_max_turns' },
      expected: 'error_max_turns',
    },
    {
      name: 'subagent error',
      extra: { is_error: true, parent_tool_use_id: 'subagent-tool' },
      expected: null,
    },
    {
      name: 'internal compaction',
      extra: { is_error: true, internal_compaction_turn: true },
      expected: null,
    },
    {
      name: 'intercepted recovery',
      extra: { is_error: true, recovery_intercepted: true },
      expected: null,
    },
    {
      name: 'terminal billing recovery',
      extra: { is_error: true, recovery_intercepted: true, recovery_billing_terminal: true },
      expected: 'error',
    },
  ])('$name classification preserves terminal boundaries', ({ extra, expected }) => {
    const work = queue();
    result(extra);
    expect(db.getSDKMessageRepo().getErrorTerminalResultSubtypeAfter('worker', work.id)).toBe(
      expected
    );
  });

  test('errors before the captured delivery or in another session cannot fail it', () => {
    const sdk = db.getSDKMessageRepo();
    sdk.saveUserMessage(
      'worker',
      {
        type: 'user',
        uuid: 'earlier' as SDKUserMessage['uuid'],
        session_id: 'worker',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Earlier fictional request' },
      },
      'enqueued'
    );
    expect(sdk.markDeliveryConsumedByUuid('worker', 'earlier')).not.toBeNull();
    result({ is_error: true });
    const work = queue();
    result({ is_error: true }, 'other');
    expect(sdk.getErrorTerminalResultSubtypeAfter('worker', work.id)).toBeNull();
    expect(sdk.getErrorTerminalResultSubtypeAfter('worker', 'earlier')).toBe('error');
  });
});
