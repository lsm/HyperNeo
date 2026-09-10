import superpipe, { type PipelineAPI } from 'superpipe';

export interface ConnectionResumeEffects {
  checkHealth(): Promise<unknown>;
  joinChannel(channel: string): Promise<void>;
  getActiveSpaceId(): string | null;
  refreshSessions(): Promise<void>;
  refreshApp(): Promise<void>;
  refreshGlobal(): Promise<void>;
  refreshSpace(): Promise<void>;
  recoverAgents(): Promise<void>;
}

export function checkResumeHealth(effects: ConnectionResumeEffects): Promise<unknown> {
  return effects.checkHealth();
}

export function rejoinGlobalChannel(effects: ConnectionResumeEffects): Promise<void> {
  return effects.joinChannel('global');
}

export function rejoinActiveSpace(effects: ConnectionResumeEffects): Promise<void> | undefined {
  const activeSpaceId = effects.getActiveSpaceId();
  if (activeSpaceId) return effects.joinChannel(`space:${activeSpaceId}`);
}

export async function refreshResumeStores(effects: ConnectionResumeEffects): Promise<void> {
  await Promise.all([
    effects.refreshSessions(),
    effects.refreshApp(),
    effects.refreshGlobal(),
    effects.refreshSpace(),
    effects.recoverAgents(),
  ]);
}

export const runConnectionResume = (superpipe({})('connection-resume') as PipelineAPI)
  .input(['effects'])
  .pipe(checkResumeHealth, 'effects')
  .pipe(rejoinGlobalChannel, 'effects')
  .pipe(rejoinActiveSpace, 'effects')
  .pipe(refreshResumeStores, 'effects', 'completion')
  .endAsync('completion') as (effects: ConnectionResumeEffects) => Promise<void>;
