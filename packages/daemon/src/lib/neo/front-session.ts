import { mkdirSync } from 'node:fs';
import type { McpServerConfig, NeoModelPreference, Session } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { SessionUpdate } from '../../storage/repositories/session-status-write.ts';
import { Logger } from '../logger.ts';
import { neoFolderPath } from './folder.ts';
import { frontSessionId } from './front-mode.ts';
import { createFrontTools } from './front-model.ts';
import { NEO_FRONT } from '@hyperneo/prompts';
import type { NeoService } from './service.ts';

const CONVO_TITLE = 'Convo';

function unusable(session: Session): boolean {
  return session.status === 'archived' || session.status === 'ended';
}

export async function frontSession(
  service: NeoService,
  ask: Pick<NeoConversationAsk, 'conversationId' | 'askOrigin'>,
  model: NeoModelPreference
): Promise<Session> {
  const id = frontSessionId(ask.conversationId);
  const config: Partial<Session['config']> = {
    model: model.model,
    provider: model.provider as Session['config']['provider'],
    thinkingLevel: model.thinkingLevel,
    queryMode: 'immediate',
    systemPrompt: NEO_FRONT,
    autoCompactPercent: model.autoCompactPercent,
    tools: { useClaudeCodePreset: false },
    operationTools: false,
    disallowedTools: ['mcp__exa'],
    sdkToolsPreset: [],
    allowedTools: [
      'projects_read',
      'asks_read',
      'cards_read',
      'todos_read',
      'handoff_read',
      'neo_send',
    ].map((name) => `mcp__front__${name}`),
    permissionMode: 'dontAsk',
    settingSources: [],
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
    await attachFrontTools(service, id, ask.conversationId);
    return requireSession(service, id);
  }
  if (unusable(existing)) {
    new Logger('NeoFront').warn('Convo session was unusable; restoring it', {
      status: existing.status,
    });
    const restore: SessionUpdate = { status: 'active', archivedAt: null };
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
  await attachFrontTools(service, id, ask.conversationId);
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
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: sessions\.id/.test(error.message) &&
      service.db.getSession(id)
    )
      return;
    new Logger('NeoFront').warn('Convo session creation failed', {
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
}

async function attachFrontTools(
  service: NeoService,
  id: string,
  conversationId: string
): Promise<void> {
  const live = await service.sessions.getSessionForControl(id);
  if (!live) throw new Error('front_session_unavailable');
  let config = requireSession(service, id).config;
  if (Object.keys(config.toolSelection?.choices ?? {}).length) {
    const snapshot = service.db.captureSessionRuntimeSettings(id);
    if (!snapshot) throw new Error('front_session_tools_superseded');
    const outcome = await service.db.casSessionRuntimeSettings(snapshot, {
      toolSelection: { version: 1, choices: {} },
    });
    config = requireSession(service, id).config;
    if (outcome !== 'won' && Object.keys(config.toolSelection?.choices ?? {}).length)
      throw new Error('front_session_tools_superseded');
  }
  const previous = live.getSessionData().config;
  if (
    live.queryObject &&
    (previous.model !== config.model || previous.provider !== config.provider)
  ) {
    const switched = await live.requestModelSwitch(config.model, config.provider!);
    if (!switched.success) throw new Error(switched.error ?? 'front_model_switch_failed');
  }
  await live.updateMetadata({ config });
  if (live.queryObject && previous.thinkingLevel !== config.thinkingLevel)
    await live.applyThinkingLevel();
  if (live.queryObject && previous.autoCompactPercent !== config.autoCompactPercent) {
    await live.updateMetadata({
      config: { ...config, autoCompactPercent: previous.autoCompactPercent },
    });
    await live.updateConfig({ autoCompactPercent: config.autoCompactPercent });
  }
  live.mergeRuntimeMcpServers({
    front: createFrontTools(service, conversationId) as unknown as McpServerConfig,
  });
}
