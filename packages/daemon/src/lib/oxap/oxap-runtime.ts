import { isAbsolute } from 'node:path';
import { generateUUID, type ProviderRecord, type Session } from '@hyperneo/shared';
import { isOxapHarness } from '@hyperneo/shared/types/oxap-harnesses';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OxapQueryRuntime } from '../agent/query-runner.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { OxapEngine, OxapEngineOptions } from './oxap-engine.ts';
import { OxapHubRequestError, type OxapHubClient } from './oxap-hub-client.ts';
import type { OxapQueryHub } from './oxap-query.ts';
import { withOxapRecovery } from './oxap-recovery.ts';
import { openOxapSession, type OxapReopenStore, type OxapReopenEvents } from './oxap-reopen.ts';
import { decideOxapOpen } from '../agent/session-engine.ts';
import { canonicalModelId } from '../model-service.ts';
import { checkCodexLogin } from './oxap-codex-login.ts';
import { savedOxapAdapter } from './oxap-hub-config.ts';

type OpenPlan = { sessionId: string; directory: string; request: Record<string, unknown> };

function validateSession(session: Session): { sessionId: string; directory: string } {
  const directory = session.worktree?.worktreePath ?? session.workspacePath ?? process.cwd();
  if (!isAbsolute(directory)) throw new Error('Codex workspace must be absolute');
  return { sessionId: session.id, directory };
}

function openPlan(
  input: { sessionId: string; directory: string },
  id: string,
  open: { adapter: string } | string
): OpenPlan {
  if (typeof open === 'string') throw new Error(open);
  return {
    ...input,
    request: {
      adapter: open.adapter,
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
  .input(['session', 'id', 'record'])
  .pipe(validateSession, 'session', 'placement')
  .pipe(
    (session: Session, record: ProviderRecord | null) => decideOxapOpen(session.config, record),
    ['session', 'record'],
    'open'
  )
  .pipe(openPlan, ['placement', 'id', 'open'], 'plan')
  .end('plan') as (session: Session, id: string, record: ProviderRecord | null) => OpenPlan;

type SessionSlot = {
  session: Session;
  directory?: string;
  opening?: Promise<OxapQueryHub>;
  client?: OxapHubClient;
  hub?: OxapQueryHub;
  deleted: boolean;
};

function planClear(
  session: Session,
  slot: SessionSlot | undefined,
  db: OxapReopenStore | undefined,
  _hub: OxapQueryHub
): Session['metadata'] {
  if (!slot || slot.deleted || !db || !session.sdkSessionId)
    throw new Error('Codex thread is unavailable for clearing');
  return { ...session.metadata, oapClearThreadId: session.sdkSessionId, oapRecovery: undefined };
}

async function recordClear(
  session: Session,
  db: OxapReopenStore | undefined,
  metadata: Session['metadata']
): Promise<true> {
  if ((await db!.updateSession(session.id, { metadata })) !== 'written')
    throw new Error('Could not save the Codex clear request');
  session.metadata = metadata;
  return true;
}

async function reopenClearedSession(
  runtime: OxapQueryRuntime,
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
  .pipe((runtime: OxapQueryRuntime) => runtime.hub, 'runtime', 'hub')
  .pipe(planClear, ['session', 'slot', 'db', 'hub'], 'metadata')
  .pipe(recordClear, ['session', 'db', 'metadata'], 'recorded')
  .pipe(reopenClearedSession, ['runtime', 'slot', 'recorded'], 'cleared')
  .endAsync('cleared') as (
  runtime: OxapQueryRuntime,
  session: Session,
  slot: SessionSlot | undefined,
  db: OxapReopenStore | undefined
) => Promise<void>;

export function createOxapRuntime(
  engine: OxapEngine,
  hubOptions?: { installed: () => boolean; read: () => Promise<OxapEngineOptions> },
  events?: InternalEventBus<DaemonInternalEventMap>,
  db?: OxapReopenStore,
  messageHub?: OxapReopenEvents,
  providerRecord: (providerId: string) => ProviderRecord | null = () => null,
  checkLogin = checkCodexLogin
): (session: Session) => OxapQueryRuntime {
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
        if (!(error instanceof OxapHubRequestError) || error.code !== 'unknown_session')
          throw error;
      }
    },
    { subscriberName: 'oap-runtime' }
  );
  return (session) => {
    const slot = isOxapHarness(session.config.harness)
      ? (sessions.get(session.id) ?? { deleted: false, session })
      : undefined;
    if (slot) {
      slot.session = session;
      sessions.set(session.id, slot);
    }
    const runtime: OxapQueryRuntime = {
      openDirectorySupported: true,
      clear() {
        return clearSession(runtime, session, slot, db);
      },
      get hub() {
        return (async () => {
          if (!slot || slot.deleted) throw new Error('Codex session was deleted or is unavailable');
          if (!hubOptions?.installed())
            throw new Error('OXAP hub is not installed; choose an OXAP harness in Settings');
          if (!db || !messageHub) throw new Error('Codex OAP session storage is unavailable');
          const record = session.config.provider ? providerRecord(session.config.provider) : null;
          const plan = prepareOpen(session, generateUUID(), record);
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
            const adapter = plan.request.adapter as string;
            slot.opening = engine
              .getHub(hubOptions.read)
              .then(async (client) => {
                if (slot.deleted) throw new Error('Codex session was deleted');
                slot.client = client;
                if (session.config.harness === 'oxap-codex') {
                  const executable = record && savedOxapAdapter(record)?.settings.executable;
                  if (!executable) throw new Error('Codex executable is not configured');
                  await checkLogin(session.id, db, messageHub, executable);
                }
                await openOxapSession(client, plan, session, db, messageHub, events, () => {
                  if (slot.deleted) throw new Error('Codex session was deleted');
                });
                if (slot.deleted) throw new Error('Codex session was deleted');
                slot.hub = withOxapRecovery(
                  engine.createQueryHub(client, {
                    adapter,
                    id: () => {
                      const model = slot.session.config.model;
                      return model && canonicalModelId(adapter, model);
                    },
                  }),
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
