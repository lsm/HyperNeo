import { describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { InjectionDeliveryRowDeps } from '../../../../src/lib/space/runtime/injection-delivery-steps';
import {
  flipDeliveryRowToDeferred,
  reopenFailedDeliveryRow,
  settleDeliveryRowStatus,
} from '../../../../src/lib/space/runtime/injection-delivery-steps';

const SESSION_ID = 'session-inject-steps';
const MESSAGE_ID = '11111111-2222-3333-4444-555555555555';

function makeRowDeps(
  opts: { savedDbId?: string; reopenDbId?: string | null; deferredDbId?: string | null } = {}
) {
  const publishStatusChanged = mock(async () => {});
  const saveUserMessage = mock(() => opts.savedDbId ?? 'db-id');
  const reopenDeliveryByUuid = mock(() => opts.reopenDbId ?? null);
  const markDeliveryDeferredByUuid = mock(() => opts.deferredDbId ?? null);
  const deps: InjectionDeliveryRowDeps = {
    publishStatusChanged,
    saveUserMessage,
    reopenDeliveryByUuid,
    markDeliveryDeferredByUuid,
  };
  return {
    deps,
    publishStatusChanged,
    saveUserMessage,
    reopenDeliveryByUuid,
    markDeliveryDeferredByUuid,
  };
}

function makeSdkUserMessage(text = 'shell step'): SDKUserMessage {
  return {
    type: 'user',
    uuid: MESSAGE_ID,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

describe('injection delivery row transitions', () => {
  it('publishes reopened and deferred row ids', async () => {
    const rows = makeRowDeps({ reopenDbId: 'reopened-db', deferredDbId: 'deferred-db' });

    await reopenFailedDeliveryRow(rows.deps, SESSION_ID, MESSAGE_ID);
    const deferred = await flipDeliveryRowToDeferred(rows.deps, SESSION_ID, MESSAGE_ID);

    expect(deferred).toBe('deferred-db');
    expect(rows.publishStatusChanged.mock.calls).toEqual([
      [SESSION_ID, 'reopened-db', 'enqueued'],
      [SESSION_ID, 'deferred-db', 'deferred'],
    ]);
  });

  it('persists fresh rows and reuses existing row ids', async () => {
    const rows = makeRowDeps({ savedDbId: 'saved-db' });
    const fresh = await settleDeliveryRowStatus(rows.deps, {
      sessionId: SESSION_ID,
      message: makeSdkUserMessage(),
      messageId: MESSAGE_ID,
      rowExists: false,
      status: 'deferred',
      origin: 'system',
    });
    const existing = await settleDeliveryRowStatus(rows.deps, {
      sessionId: SESSION_ID,
      message: makeSdkUserMessage(),
      messageId: MESSAGE_ID,
      rowExists: true,
      status: 'enqueued',
    });

    expect(fresh).toBe('saved-db');
    expect(existing).toBe(MESSAGE_ID);
    expect(rows.saveUserMessage).toHaveBeenCalledTimes(1);
  });
});
