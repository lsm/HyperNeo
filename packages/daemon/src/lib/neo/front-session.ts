import { mkdirSync } from 'node:fs';
import type { NeoModelPreference, Session } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { SessionUpdate } from '../../storage/repositories/session-status-write.ts';
import { Logger } from '../logger.ts';
import { neoFolderPath } from './folder.ts';
import { neoDerivedId } from './derived-id.ts';
import type { NeoService } from './service.ts';

const CONVO_TITLE = 'Convo';

function unusable(session: Session): boolean {
  return session.status === 'archived' || session.status === 'ended';
}

export async function frontSession(
  service: NeoService,
  ask: NeoConversationAsk,
  model: NeoModelPreference
): Promise<Session> {
  const id = neoDerivedId(`front-session:${ask.conversationId}`);
  const config: Partial<Session['config']> = {
    model: model.model,
    provider: model.provider as Session['config']['provider'],
    thinkingLevel: model.thinkingLevel,
    queryMode: 'manual',
  };
  const neo = service.db.getSession(
    service.repo.defaultBinding()?.sessionId ?? ask.askOrigin.sessionId
  );
  const executionProjectPath =
    neo?.metadata.executionProjectPath ?? neo?.workspacePath ?? neoFolderPath();
  mkdirSync(service.userFolder, { recursive: true });
  const existing = service.db.getSession(id);
  if (!existing) {
    await createConvo(service, id, config, executionProjectPath);
    return requireSession(service, id);
  }
  if (unusable(existing)) {
    new Logger('NeoFront').warn('Convo session was unusable; restoring it', {
      status: existing.status,
    });
    const restore: SessionUpdate = { status: 'active', archivedAt: null, sdkSessionId: undefined };
    const outcome = await service.db.updateSession(id, restore);
    if (outcome !== 'written') throw new Error('front_session_restore_refused');
  }
  const current = requireSession(service, id);
  await service.db.updateSession(id, {
    title: CONVO_TITLE,
    workspacePath: service.userFolder,
    metadata: { ...current.metadata, executionProjectPath },
    config: { ...current.config, ...config },
    lastActiveAt: new Date().toISOString(),
  });
  return requireSession(service, id);
}

function requireSession(service: NeoService, id: string): Session {
  const session = service.db.getSession(id);
  if (!session) throw new Error('front_session_unavailable');
  return session;
}

async function createConvo(
  service: NeoService,
  id: string,
  config: Partial<Session['config']>,
  executionProjectPath: string
): Promise<void> {
  try {
    await service.sessions.createSession({
      sessionId: id,
      title: CONVO_TITLE,
      workspacePath: service.userFolder,
      executionProjectPath,
      config,
      detectGit: false,
      worktreeMode: 'direct',
    });
  } catch (error) {
    new Logger('NeoFront').warn('Convo session creation failed', {
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
}
