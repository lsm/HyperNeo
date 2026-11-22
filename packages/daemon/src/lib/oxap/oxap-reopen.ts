import type { MessageHub, Session } from '@hyperneo/shared';
import {
  isOxapHarness,
  oxapHarness,
  type OxapHarness,
} from '@hyperneo/shared/types/oxap-harnesses';
import type { Database } from '../../storage/index.ts';
import { MessageDeliveryTerminalTurnError } from '../agent/message-delivery.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { OxapHubRequestError, type OxapHubClient } from './oxap-hub-client.ts';
import { announceOxapNotice } from './oxap-notice.ts';
import { recoveryContext } from './oxap-recovery.ts';
import { decideReopenFailure, decideSessionOpen } from './oxap-session-open.ts';

export class OxapReopenRefusedError extends MessageDeliveryTerminalTurnError {
  constructor(label: string) {
    super(`${label} opened the previous thread again. Start a new chat.`, 'oap_reopen_refused');
    this.name = 'OxapReopenRefusedError';
  }
}

export type OxapReopenStore = Pick<
  Database,
  | 'updateSession'
  | 'getSDKMessages'
  | 'getUserMessagesByStatus'
  | 'saveSDKMessage'
  | 'updateAuthStatusMessage'
  | 'getSDKMessageRepo'
>;
export type OxapReopenEvents = Pick<MessageHub, 'event'>;
export type OxapOpenPlan = {
  sessionId: string;
  directory: string;
  request: Record<string, unknown>;
};
type WorkStatus = {
  held?: boolean;
  directory?: unknown;
  ref?: { adapter?: unknown; session_id?: unknown };
  link?: unknown;
  status?: unknown;
};

export function sessionHarness(session: Session): OxapHarness {
  if (!isOxapHarness(session.config.harness)) throw new Error('Session is not an OXAP chat');
  return oxapHarness(session.config.harness);
}

function validatePlacement(status: WorkStatus, plan: OxapOpenPlan): void {
  if (status.directory !== plan.directory)
    throw new Error('OAP open-directory did not confirm the workspace');
  if (status.ref?.adapter !== plan.request.adapter || status.ref?.session_id !== plan.sessionId)
    throw new Error('OAP returned an invalid session identity');
}

function nativeId(status: WorkStatus | undefined, plan: OxapOpenPlan, row: OxapHarness): string {
  if (!status) throw new Error(`OAP did not confirm the ${row.label} thread identity`);
  validatePlacement(status, plan);
  const id = typeof status.link === 'string' ? row.nativeId(status.link) : undefined;
  if (!id || id === '.' || id === '..')
    throw new Error(`OAP returned an invalid ${row.label} thread identity`);
  return id;
}

async function open(client: OxapHubClient, plan: OxapOpenPlan, revision?: string): Promise<void> {
  const envelope = plan.request.request as { payload: Record<string, unknown> };
  const request = revision
    ? { ...envelope, capability_revision: revision, payload: { ...envelope.payload, reopen: true } }
    : envelope;
  const result = (await client.request('open', { ...plan.request, request })) as {
    type?: unknown;
    payload?: { session_id?: unknown };
  };
  if (result?.type !== 'session.open.response' || result.payload?.session_id !== plan.sessionId)
    throw new Error('OAP returned an invalid session open response');
}

async function reopenRevision(
  client: OxapHubClient,
  session: Session,
  adapter: unknown
): Promise<string | undefined> {
  const response = (await client.request('capabilities', { adapter })) as {
    type?: unknown;
    capability_revision?: unknown;
    payload?: { features?: Record<string, { level?: unknown }> };
  };
  if (
    response.type !== 'capabilities.response' ||
    typeof response.capability_revision !== 'string' ||
    !response.capability_revision
  )
    throw new Error('OAP returned invalid adapter capabilities');
  const level = response.payload?.features?.['session.open.reopen']?.level;
  const supported = level === 'native' || level === 'emulated';
  const decision = decideSessionOpen({
    nativeSessionId: session.sdkSessionId,
    supportsReopen: supported,
  });
  return decision.mode === 'unavailable' || !supported ? undefined : response.capability_revision;
}

function hasHistory(db: OxapReopenStore, sessionId: string): boolean {
  const { messages } = db.getSDKMessages(sessionId, 100);
  return (
    messages.some((message) => message.type === 'assistant' || message.type === 'user') ||
    (['submitted', 'consumed', 'failed'] as const).some(
      (status) => db.getUserMessagesByStatus(sessionId, status, 1).total > 0
    )
  );
}

function recoveryNotice(text: string, row: OxapHarness): string {
  return text
    ? `The previous ${row.label} thread cannot be resumed. A new thread will use a saved conversation excerpt with your next message.`
    : `The previous ${row.label} thread cannot be resumed. A new thread will start without earlier conversation.`;
}

async function openAfterClear(
  client: OxapHubClient,
  plan: OxapOpenPlan,
  session: Session,
  status: WorkStatus | undefined,
  ensureLive: () => void,
  oldId: string | null
): Promise<WorkStatus> {
  let current = status?.held === false ? undefined : status;
  if (status?.held === false && oldId) {
    const revision = await reopenRevision(client, session, plan.request.adapter);
    ensureLive();
    if (revision) {
      try {
        await open(client, plan, revision);
        current = (await client.request('work.status', {
          session_id: plan.sessionId,
        })) as WorkStatus;
      } catch (error) {
        if (
          !(error instanceof OxapHubRequestError) ||
          decideReopenFailure(error).mode !== 'summary'
        )
          throw error;
      }
      ensureLive();
    }
  }
  const row = sessionHarness(session);
  if (current && (!oldId || nativeId(current, plan, row) !== oldId)) return current;
  if (current) {
    await client.request('close', { session_id: plan.sessionId });
    ensureLive();
  }
  await open(client, plan);
  ensureLive();
  current = (await client.request('work.status', { session_id: plan.sessionId })) as WorkStatus;
  ensureLive();
  return current;
}

export async function openOxapSession(
  client: OxapHubClient,
  plan: OxapOpenPlan,
  session: Session,
  db: OxapReopenStore,
  hub: OxapReopenEvents,
  events: InternalEventBus<DaemonInternalEventMap> | undefined,
  ensureLive: () => void
): Promise<void> {
  const row = sessionHarness(session);
  const clearing = session.metadata?.oapClearThreadId;
  let recovery = session.metadata?.oapRecovery;
  if (!clearing && recovery?.failure === 'same_native_thread')
    throw new OxapReopenRefusedError(row.label);
  let status: WorkStatus | undefined;
  try {
    status = (await client.request('work.status', { session_id: plan.sessionId })) as WorkStatus;
  } catch (error) {
    if (!(error instanceof OxapHubRequestError) || error.code !== 'unknown_session') throw error;
  }
  ensureLive();
  if (status) validatePlacement(status, plan);
  const prior = !!session.sdkSessionId || !!status || hasHistory(db, session.id);
  if (clearing) {
    status = await openAfterClear(client, plan, session, status, ensureLive, clearing);
  } else if (recovery?.pendingOpen) {
    status = await openAfterClear(client, plan, session, status, ensureLive, recovery.previous);
  } else if (!status || status.held === false) {
    let fallback = false;
    if (prior) {
      if (!session.sdkSessionId && !status) fallback = true;
      else {
        const revision = await reopenRevision(client, session, plan.request.adapter);
        ensureLive();
        if (!revision) fallback = true;
        else
          try {
            await open(client, plan, revision);
          } catch (error) {
            ensureLive();
            if (
              !(error instanceof OxapHubRequestError) ||
              decideReopenFailure(error).mode !== 'summary'
            )
              throw error;
            fallback = true;
          }
      }
    } else await open(client, plan);
    if (fallback) {
      recovery = {
        previous: session.sdkSessionId ?? null,
        text: recoveryContext(db.getSDKMessages(session.id, 100).messages),
        pendingOpen: true,
      };
      const metadata = { ...session.metadata, oapRecovery: recovery };
      if ((await db.updateSession(session.id, { metadata })) !== 'written')
        throw new Error(`Could not save the ${row.label} recovery context`);
      ensureLive();
      session.metadata = metadata;
      await open(client, plan);
    }
    ensureLive();
    status = (await client.request('work.status', { session_id: plan.sessionId })) as WorkStatus;
    ensureLive();
  } else if (status.status && status.status !== 'done')
    throw new Error(`${row.label} session has unfinished work`);
  const id = nativeId(status, plan, row);
  if (clearing === id) throw new OxapReopenRefusedError(row.label);
  if (!clearing && recovery?.pendingOpen && recovery.previous === id) {
    const metadata = {
      ...session.metadata,
      oapRecovery: { ...recovery, pendingOpen: false, failure: 'same_native_thread' as const },
    };
    if ((await db.updateSession(session.id, { metadata })) !== 'written')
      throw new Error(`Could not save the ${row.label} recovery failure`);
    session.metadata = metadata;
    throw new OxapReopenRefusedError(row.label);
  }
  if (!clearing && !recovery?.pendingOpen && session.sdkSessionId && session.sdkSessionId !== id)
    throw new Error(`${row.label} native thread identity changed`);
  if (clearing || recovery?.pendingOpen || id !== session.sdkSessionId) {
    const metadata = clearing
      ? { ...session.metadata, oapClearThreadId: undefined }
      : recovery?.pendingOpen
        ? {
            ...session.metadata,
            oapRecovery: recovery.text ? { ...recovery, pendingOpen: false } : undefined,
          }
        : undefined;
    const update = {
      sdkSessionId: id,
      ...(metadata ? { metadata, sdkOriginPath: undefined } : {}),
    };
    if ((await db.updateSession(session.id, update)) !== 'written')
      throw new Error(`Could not save ${row.label} thread identity`);
    ensureLive();
    Object.assign(session, update);
    events?.publishAsync('session.updated', {
      sessionId: session.id,
      source: 'oap-reopen',
      session: update,
    });
    if (!clearing && recovery?.pendingOpen)
      await announceOxapNotice(session.id, recoveryNotice(recovery.text, row), db, hub, ensureLive);
  }
}
