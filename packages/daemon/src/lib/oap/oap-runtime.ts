import { isAbsolute } from 'node:path';
import { generateUUID, type Session } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OapQueryRuntime } from '../agent/query-runner.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { OapEngine, OapEngineOptions } from './oap-engine.ts';
import { OapHubRequestError, type OapHubClient } from './oap-hub-client.ts';
import type { OapQueryHub } from './oap-query.ts';
import { withOapRecovery } from './oap-recovery.ts';
import { openOapSession, type OapReopenStore, type OapReopenEvents } from './oap-reopen.ts';

type OpenPlan = { sessionId: string; directory: string; request: Record<string, unknown> };

function validateSession(session: Session): { sessionId: string; directory: string } {
  const directory = session.worktree?.worktreePath ?? session.workspacePath;
  if (!directory || !isAbsolute(directory)) throw new Error('Codex workspace must be absolute');
  return { sessionId: session.id, directory };
}

function openPlan(input: { sessionId: string; directory: string }, id: string): OpenPlan {
  return {
    ...input,
    request: {
      adapter: 'codex',
      directory: input.directory,
      request: {
        protocol: 'open-agent-protocol',
        version: '0.1',
        profile: 'open-agent-protocol.agent-control-core',
        type: 'session.open.request',
        id,
        payload: { session_id: input.sessionId },
      },
    },
  };
}

const prepareOpen = (superpipe({})('oap.runtime.open') as PipelineAPI)
  .input(['session', 'id'])
  .pipe(validateSession, 'session', 'placement')
  .pipe(openPlan, ['placement', 'id'], 'plan')
  .end('plan') as (session: Session, id: string) => OpenPlan;

type SessionSlot = {
  session: Session;
  directory?: string;
  opening?: Promise<OapQueryHub>;
  client?: OapHubClient;
  hub?: OapQueryHub;
  deleted: boolean;
};

function planClear(
  session: Session,
  slot: SessionSlot | undefined,
  db: OapReopenStore | undefined,
  _hub: OapQueryHub
): Session['metadata'] {
  if (!slot || slot.deleted || !db || !session.sdkSessionId)
    throw new Error('Codex thread is unavailable for clearing');
  return { ...session.metadata, oapClearThreadId: session.sdkSessionId, oapRecovery: undefined };
}

async function recordClear(
  session: Session,
  db: OapReopenStore | undefined,
  metadata: Session['metadata']
): Promise<true> {
  if ((await db!.updateSession(session.id, { metadata })) !== 'written')
    throw new Error('Could not save the Codex clear request');
  session.metadata = metadata;
  return true;
}

async function reopenClearedSession(
  runtime: OapQueryRuntime,
  slot: SessionSlot | undefined,
  _recorded: true
): Promise<void> {
  slot!.hub?.release?.();
  slot!.hub = undefined;
  slot!.opening = undefined;
  await runtime.hub;
}

const clearSession = (superpipe({})('oap.runtime.clear') as PipelineAPI)
  .input(['runtime', 'session', 'slot', 'db'])
  .pipe((runtime: OapQueryRuntime) => runtime.hub, 'runtime', 'hub')
  .pipe(planClear, ['session', 'slot', 'db', 'hub'], 'metadata')
  .pipe(recordClear, ['session', 'db', 'metadata'], 'recorded')
  .pipe(reopenClearedSession, ['runtime', 'slot', 'recorded'], 'cleared')
  .endAsync('cleared') as (
  runtime: OapQueryRuntime,
  session: Session,
  slot: SessionSlot | undefined,
  db: OapReopenStore | undefined
) => Promise<void>;

export function createOapRuntime(
  engine: OapEngine,
  options?: OapEngineOptions,
  events?: InternalEventBus<DaemonInternalEventMap>,
  db?: OapReopenStore,
  messageHub?: OapReopenEvents
): (session: Session) => OapQueryRuntime {
  const sessions = new Map<string, SessionSlot>();
  events?.subscribe(
    'session.deleted',
    async ({ sessionId }) => {
      const slot = sessions.get(sessionId);
      if (!slot) return;
      slot.deleted = true;
      sessions.delete(sessionId);
      try {
        (await slot.opening)?.release?.();
      } catch {}
      if (!slot.client) return;
      try {
        await slot.client.request('close', { session_id: sessionId });
      } catch (error) {
        if (!(error instanceof OapHubRequestError) || error.code !== 'unknown_session') throw error;
      }
    },
    { subscriberName: 'oap-runtime' }
  );
  return (session) => {
    const slot =
      session.config.harness === 'codex'
        ? (sessions.get(session.id) ?? { deleted: false, session })
        : undefined;
    if (slot) {
      slot.session = session;
      sessions.set(session.id, slot);
    }
    const runtime: OapQueryRuntime = {
      openDirectorySupported: true,
      clear() {
        return clearSession(runtime, session, slot, db);
      },
      get hub() {
        return (async () => {
          if (!slot || slot.deleted) throw new Error('Codex session was deleted or is unavailable');
          if (!options) throw new Error('Codex OAP configuration is incomplete');
          if (!db || !messageHub) throw new Error('Codex OAP session storage is unavailable');
          const plan = prepareOpen(session, generateUUID());
          if (slot.directory && slot.directory !== plan.directory) {
            throw new Error('Codex session workspace changed; reopen is required');
          }
          if (slot.hub && slot.client && !engine.isCurrentHub(slot.client)) {
            slot.hub.release?.();
            slot.hub = undefined;
            slot.opening = undefined;
            slot.client = undefined;
          }
          if (!slot.opening) {
            slot.directory = plan.directory;
            slot.opening = engine
              .getHub(options)
              .then(async (client) => {
                if (slot.deleted) throw new Error('Codex session was deleted');
                slot.client = client;
                await openOapSession(client, plan, session, db, messageHub, events, () => {
                  if (slot.deleted) throw new Error('Codex session was deleted');
                });
                if (slot.deleted) throw new Error('Codex session was deleted');
                slot.hub = withOapRecovery(
                  engine.createQueryHub(client),
                  () => slot.session,
                  db,
                  messageHub
                );
                return slot.hub;
              })
              .catch((error: unknown) => {
                slot.opening = undefined;
                throw error;
              });
          }
          return slot.opening;
        })();
      },
    };
    return runtime;
  };
}
