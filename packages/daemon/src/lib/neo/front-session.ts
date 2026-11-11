import type { NeoModelPreference, Session } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { neoDerivedId } from './derived-id.ts';
import type { NeoService } from './service.ts';

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
  const existing = service.db.getSession(id);
  if (!existing) {
    await service.sessions.createSession({
      sessionId: id,
      title: '前端',
      workspacePath: service.userFolder,
      config,
      detectGit: false,
      worktreeMode: 'direct',
    });
  } else {
    await service.db.updateSession(id, {
      config: { ...existing.config, ...config },
      lastActiveAt: new Date().toISOString(),
    });
  }
  return service.db.getSession(id)!;
}
