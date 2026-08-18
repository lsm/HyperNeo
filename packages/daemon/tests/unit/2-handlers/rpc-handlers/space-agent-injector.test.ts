/**
 * Space Agent injector — the send_message handoff lane (round-15 P2).
 *
 * The injector was previously a closure inside setupRPCHandlers that no test
 * executed; it is now an exported factory (createSpaceAgentInjector). These
 * tests drive its v2 idempotent-persist branches directly — in particular the
 * failed-row reopen + startup-timeout budget reset wiring.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { signalDeliveryConsumed } from '../../../../src/lib/agent/message-delivery';
import { createSpaceAgentInjector } from '../../../../src/lib/rpc-handlers/index';
import type { RPCHandlerDependencies } from '../../../../src/lib/rpc-handlers/index';

describe('createSpaceAgentInjector — send_message handoff lane (v2)', () => {
  const SESSION_ID = 'space:chat:s1';
  let resetBudgetSpy: ReturnType<typeof mock>;
  let reopenDeliveryByUuid: ReturnType<typeof mock>;
  let saveUserMessage: ReturnType<typeof mock>;
  let session: AgentSession;

  beforeEach(() => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
    resetBudgetSpy = mock(() => {});
    reopenDeliveryByUuid = mock(() => 'db-id');
    saveUserMessage = mock(() => 'db-msg');
    session = {
      getSessionData: () => ({ id: SESSION_ID, config: {} }),
      stateManager: { getState: () => ({ status: 'idle' }) },
      resetStartupTimeoutRetryBudget: resetBudgetSpy,
    } as unknown as AgentSession;
  });

  function buildInjector(existing: { sendStatus: string } | null) {
    const sessionManager = {
      getSessionAsync: mock(async () => session),
    } as unknown as RPCHandlerDependencies['sessionManager'];
    const deps = {
      reactiveDb: {
        db: {
          saveUserMessage,
          getSDKMessageRepo: () => ({
            getDeliveryContent: () => existing,
            markDeliveryFailedByUuid: () => null,
            reopenDeliveryByUuid,
          }),
          getJobQueueRepo: () => ({
            getActiveDeliveryRole: () => null,
            enqueue: () => ({ id: 'job-1' }),
          }),
        },
      },
    } as unknown as RPCHandlerDependencies;
    return createSpaceAgentInjector(sessionManager, deps);
  }

  it('a failed prior handoff row is reopened AND the startup budget reset for the same uuid', async () => {
    const injector = buildInjector({ sendStatus: 'failed' });
    const pending = injector('s1', 'handoff body', null, 'stable-handoff-id');
    // Resolve the consumption await — after a tick so the injector has
    // registered its waiter (signaling before registration loses the edge).
    await new Promise((resolve) => setTimeout(resolve, 10));
    signalDeliveryConsumed(SESSION_ID, 'stable-handoff-id');
    await pending;

    expect(reopenDeliveryByUuid).toHaveBeenCalledWith(SESSION_ID, 'stable-handoff-id');
    // Round-15 P2: the handoff lane's budget reset actually executes —
    // previously this wiring had zero coverage.
    expect(resetBudgetSpy).toHaveBeenCalledTimes(1);
    expect(resetBudgetSpy).toHaveBeenCalledWith('stable-handoff-id');
  });

  it('a fresh handoff persists the row and does not touch the reopen/reset lane', async () => {
    const injector = buildInjector(null);
    const pending = injector('s1', 'fresh body', null, 'fresh-handoff-id');
    await new Promise((resolve) => setTimeout(resolve, 10));
    signalDeliveryConsumed(SESSION_ID, 'fresh-handoff-id');
    await pending;

    expect(saveUserMessage).toHaveBeenCalledTimes(1);
    expect(reopenDeliveryByUuid).not.toHaveBeenCalled();
    expect(resetBudgetSpy).not.toHaveBeenCalled();
  });

  it('a consumed prior handoff short-circuits without re-driving', async () => {
    const injector = buildInjector({ sendStatus: 'consumed' });
    await injector('s1', 'already delivered', null, 'consumed-handoff-id');

    expect(saveUserMessage).not.toHaveBeenCalled();
    expect(reopenDeliveryByUuid).not.toHaveBeenCalled();
    expect(resetBudgetSpy).not.toHaveBeenCalled();
  });
});
