import { isAbsolute } from 'node:path';
import { generateUUID, type Session } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OapQueryRuntime } from '../agent/query-runner.ts';
import type { OapEngine, OapEngineOptions } from './oap-engine.ts';
import { OapHubRequestError, type OapHubClient } from './oap-hub-client.ts';
import type { OapQueryHub } from './oap-query.ts';

type OpenPlan = { sessionId: string; directory: string; request: Record<string, unknown> };

function validateSession(session: Session): { sessionId: string; directory: string } {
  if (session.sdkSessionId) throw new Error('Codex session reopen is not available yet');
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

async function openSession(client: OapHubClient, plan: OpenPlan): Promise<OapHubClient> {
  try {
    await client.request('work.status', { session_id: plan.sessionId });
    throw new Error('Codex session reopen is not available yet');
  } catch (error) {
    if (!(error instanceof OapHubRequestError) || error.code !== 'unknown_session') throw error;
  }
  const result = (await client.request('open', plan.request)) as {
    type?: unknown;
    payload?: { session_id?: unknown };
  };
  if (result?.type !== 'session.open.response' || result.payload?.session_id !== plan.sessionId) {
    throw new Error('OAP returned an invalid session open response');
  }
  const status = (await client.request('work.status', { session_id: plan.sessionId })) as {
    directory?: unknown;
  };
  if (status?.directory !== plan.directory) {
    throw new Error('Codex is unavailable: OAP open-directory did not confirm the workspace');
  }
  return client;
}

export function createOapRuntime(
  engine: OapEngine,
  options?: OapEngineOptions
): (session: Session) => OapQueryRuntime {
  const sessions = new Map<string, { directory: string; opening: Promise<OapQueryHub> }>();
  return (session) => ({
    openDirectorySupported: true,
    get hub() {
      return (async () => {
        if (!options) throw new Error('Codex OAP configuration is incomplete');
        const plan = prepareOpen(session, generateUUID());
        let opening = sessions.get(plan.sessionId);
        if (opening && opening.directory !== plan.directory) {
          throw new Error('Codex session workspace changed; reopen is required');
        }
        if (!opening && (session.metadata?.messageCount ?? 0) > 0) {
          throw new Error('Codex session reopen is not available yet');
        }
        if (!opening) {
          opening = {
            directory: plan.directory,
            opening: engine.getHub(options).then(async (client) => {
              await openSession(client, plan);
              return engine.createQueryHub(client);
            }),
          };
          sessions.set(plan.sessionId, opening);
        }
        return opening.opening;
      })();
    },
  });
}
