import { generateUUID, type MessageHub, type Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../storage/index.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { OapHubRequestError, type OapHubClient } from './oap-hub-client.ts';
import { decideReopenFailure, decideSessionOpen } from './oap-session-open.ts';

export class OapReopenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OapReopenRefusedError';
  }
}

export type OapReopenStore = Pick<
  Database,
  'updateSession' | 'getSDKMessages' | 'getUserMessagesByStatus' | 'saveSDKMessage'
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

async function refuseReopen(
  session: Session,
  db: OapReopenStore,
  hub: OapReopenEvents,
  ensureLive: () => void
): Promise<never> {
  const text = 'The previous Codex thread cannot be resumed. No new thread was started.';
  const message = {
    type: 'assistant',
    uuid: generateUUID(),
    session_id: session.id,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text, citations: null }] },
  } as unknown as SDKMessage;
  if (!(await db.saveSDKMessage(session.id, message)))
    throw new Error('Could not save the Codex reopen notice');
  ensureLive();
  hub.event(
    'state.sdkMessages.delta',
    { added: [message], timestamp: Date.now() },
    { channel: `session:${session.id}` }
  );
  throw new OapReopenRefusedError(text);
}

async function openAfterClear(
  client: OapHubClient,
  plan: OapOpenPlan,
  session: Session,
  status: WorkStatus | undefined,
  ensureLive: () => void
): Promise<WorkStatus> {
  const oldId = session.metadata.oapClearThreadId;
  let current = status?.held === false ? undefined : status;
  if (status?.held === false) {
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
  if (current && nativeId(current, plan) !== oldId) return current;
  if (current) {
    await client.request('close', { session_id: plan.sessionId });
    ensureLive();
  }
  await open(client, plan);
  ensureLive();
  current = (await client.request('work.status', { session_id: plan.sessionId })) as WorkStatus;
  ensureLive();
  if (nativeId(current, plan) === oldId) throw new Error('Codex opened the previous thread again');
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
  const prior = !!session.sdkSessionId || !!status || hasHistory(db, session.id);
  if (clearing) {
    status = await openAfterClear(client, plan, session, status, ensureLive);
  } else if (!status || status.held === false) {
    if (prior) {
      if (!session.sdkSessionId && !status) await refuseReopen(session, db, hub, ensureLive);
      const revision = await reopenRevision(client, session);
      ensureLive();
      if (!revision) await refuseReopen(session, db, hub, ensureLive);
      try {
        await open(client, plan, revision);
      } catch (error) {
        ensureLive();
        if (error instanceof OapHubRequestError && decideReopenFailure(error).mode === 'summary')
          await refuseReopen(session, db, hub, ensureLive);
        throw error;
      }
    } else await open(client, plan);
    ensureLive();
    status = (await client.request('work.status', { session_id: plan.sessionId })) as WorkStatus;
    ensureLive();
  } else if (status.status && status.status !== 'done')
    throw new Error('Codex session has unfinished work');
  const id = nativeId(status, plan);
  if (!clearing && session.sdkSessionId && session.sdkSessionId !== id)
    throw new Error('Codex native thread identity changed');
  if (clearing || id !== session.sdkSessionId) {
    const metadata = clearing ? { ...session.metadata, oapClearThreadId: undefined } : undefined;
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
