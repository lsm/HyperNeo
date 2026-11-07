import type { MessageHub, Session } from '@hyperneo/shared';
import type { Database } from '../../storage/index.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { OapHubRequestError, type OapHubClient } from './oap-hub-client.ts';
import { announceOapNotice } from './oap-notice.ts';
import { recoveryContext } from './oap-recovery.ts';
import { decideReopenFailure, decideSessionOpen } from './oap-session-open.ts';

export class OapReopenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OapReopenRefusedError';
  }
}

export type OapReopenStore = Pick<
  Database,
  | 'updateSession'
  | 'getSDKMessages'
  | 'getUserMessagesByStatus'
  | 'saveSDKMessage'
  | 'getSDKMessageRepo'
>;
export type OapReopenEvents = Pick<MessageHub, 'event'>;
export type OapOpenPlan = {
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

function validatePlacement(status: WorkStatus, plan: OapOpenPlan): void {
  if (status.directory !== plan.directory)
    throw new Error('OAP open-directory did not confirm the workspace');
  if (status.ref?.adapter !== 'codex' || status.ref.session_id !== plan.sessionId)
    throw new Error('OAP returned an invalid Codex session identity');
}

function nativeId(status: WorkStatus | undefined, plan: OapOpenPlan): string {
  if (!status) throw new Error('OAP did not confirm the Codex thread identity');
  validatePlacement(status, plan);
  const match =
    typeof status.link === 'string'
      ? /^codex:\/\/threads\/([a-zA-Z0-9._~-]+)$/.exec(status.link)
      : null;
  if (!match || match[1] === '.' || match[1] === '..')
    throw new Error('OAP returned an invalid Codex thread identity');
  return match[1];
}

async function open(client: OapHubClient, plan: OapOpenPlan, revision?: string): Promise<void> {
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

async function reopenRevision(client: OapHubClient, session: Session): Promise<string | undefined> {
  const response = (await client.request('capabilities', { adapter: 'codex' })) as {
    type?: unknown;
    capability_revision?: unknown;
    payload?: { features?: Record<string, { level?: unknown }> };
  };
  if (
    response.type !== 'capabilities.response' ||
    typeof response.capability_revision !== 'string' ||
    !response.capability_revision
  )
    throw new Error('OAP returned invalid Codex capabilities');
  const level = response.payload?.features?.['session.open.reopen']?.level;
  const supported = level === 'native' || level === 'emulated';
  const decision = decideSessionOpen({
    nativeSessionId: session.sdkSessionId,
    supportsReopen: supported,
  });
  return decision.mode === 'unavailable' || !supported ? undefined : response.capability_revision;
}

function hasHistory(db: OapReopenStore, sessionId: string): boolean {
  const { messages } = db.getSDKMessages(sessionId, 100);
  return (
    messages.some((message) => message.type === 'assistant' || message.type === 'user') ||
    (['submitted', 'consumed', 'failed'] as const).some(
      (status) => db.getUserMessagesByStatus(sessionId, status, 1).total > 0
    )
  );
}

function recoveryNotice(text: string): string {
  return text
    ? 'The previous Codex thread cannot be resumed. A new thread will use a saved conversation excerpt with your next message.'
    : 'The previous Codex thread cannot be resumed. A new thread will start without earlier conversation.';
}

async function openAfterClear(
  client: OapHubClient,
  plan: OapOpenPlan,
  session: Session,
  status: WorkStatus | undefined,
  ensureLive: () => void,
  oldId: string | null
): Promise<WorkStatus> {
  let current = status?.held === false ? undefined : status;
  if (status?.held === false && oldId) {
    const revision = await reopenRevision(client, session);
    ensureLive();
    if (revision) {
      try {
        await open(client, plan, revision);
        current = (await client.request('work.status', {
          session_id: plan.sessionId,
        })) as WorkStatus;
      } catch (error) {
        if (!(error instanceof OapHubRequestError) || decideReopenFailure(error).mode !== 'summary')
          throw error;
      }
      ensureLive();
    }
  }
  if (current && (!oldId || nativeId(current, plan) !== oldId)) return current;
  if (current) {
    await client.request('close', { session_id: plan.sessionId });
    ensureLive();
  }
  await open(client, plan);
  ensureLive();
  current = (await client.request('work.status', { session_id: plan.sessionId })) as WorkStatus;
  ensureLive();
  if (oldId && nativeId(current, plan) === oldId)
    throw new Error('Codex opened the previous thread again');
  return current;
}

export async function openOapSession(
  client: OapHubClient,
  plan: OapOpenPlan,
  session: Session,
  db: OapReopenStore,
  hub: OapReopenEvents,
  events: InternalEventBus<DaemonInternalEventMap> | undefined,
  ensureLive: () => void
): Promise<void> {
  let status: WorkStatus | undefined;
  try {
    status = (await client.request('work.status', { session_id: plan.sessionId })) as WorkStatus;
  } catch (error) {
    if (!(error instanceof OapHubRequestError) || error.code !== 'unknown_session') throw error;
  }
  ensureLive();
  if (status) validatePlacement(status, plan);
  const clearing = !!session.metadata?.oapClearThreadId;
  let recovery = session.metadata?.oapRecovery;
  const prior = !!session.sdkSessionId || !!status || hasHistory(db, session.id);
  if (clearing) {
    status = await openAfterClear(
      client,
      plan,
      session,
      status,
      ensureLive,
      session.metadata.oapClearThreadId!
    );
  } else if (recovery?.pendingOpen) {
    status = await openAfterClear(client, plan, session, status, ensureLive, recovery.previous);
    await announceOapNotice(session.id, recoveryNotice(recovery.text), db, hub, ensureLive);
  } else if (!status || status.held === false) {
    let fallback = false;
    if (prior) {
      if (!session.sdkSessionId && !status) fallback = true;
      else {
        const revision = await reopenRevision(client, session);
        ensureLive();
        if (!revision) fallback = true;
        else
          try {
            await open(client, plan, revision);
          } catch (error) {
            ensureLive();
            if (
              !(error instanceof OapHubRequestError) ||
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
        throw new Error('Could not save the Codex recovery context');
      ensureLive();
      session.metadata = metadata;
      await open(client, plan);
      ensureLive();
      await announceOapNotice(session.id, recoveryNotice(recovery.text), db, hub, ensureLive);
    }
    ensureLive();
    status = (await client.request('work.status', { session_id: plan.sessionId })) as WorkStatus;
    ensureLive();
  } else if (status.status && status.status !== 'done')
    throw new Error('Codex session has unfinished work');
  const id = nativeId(status, plan);
  if (recovery?.pendingOpen && recovery.previous === id)
    throw new Error('Codex opened the previous thread again');
  if (!clearing && !recovery?.pendingOpen && session.sdkSessionId && session.sdkSessionId !== id)
    throw new Error('Codex native thread identity changed');
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
      throw new Error('Could not save Codex thread identity');
    ensureLive();
    Object.assign(session, update);
    events?.publishAsync('session.updated', {
      sessionId: session.id,
      source: 'oap-reopen',
      session: update,
    });
  }
}
