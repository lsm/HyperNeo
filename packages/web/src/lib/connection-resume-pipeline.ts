import superpipe, { type PipelineAPI } from 'superpipe';

export interface ConnectionResumeEffects {
  checkHealth(): Promise<unknown>;
  joinChannel(channel: string): Promise<void>;
  extensionChannels(): string[];
  refreshSessions(): Promise<void>;
  refreshApp(): Promise<void>;
  refreshGlobal(): Promise<void>;
  refreshExtensions(): Promise<void>;
}

export function checkResumeHealth(effects: ConnectionResumeEffects): Promise<unknown> {
  return effects.checkHealth();
}

export function rejoinGlobalChannel(effects: ConnectionResumeEffects): Promise<void> {
  return effects.joinChannel('global');
}

export async function rejoinExtensionChannels(effects: ConnectionResumeEffects): Promise<void> {
  await Promise.all(effects.extensionChannels().map((channel) => effects.joinChannel(channel)));
}

export async function refreshResumeStores(effects: ConnectionResumeEffects): Promise<void> {
  await Promise.all([
    effects.refreshSessions(),
    effects.refreshApp(),
    effects.refreshGlobal(),
    effects.refreshExtensions(),
  ]);
}

export const runConnectionResume = (superpipe({})('connection-resume') as PipelineAPI)
  .input(['effects'])
  .pipe(checkResumeHealth, 'effects')
  .pipe(rejoinGlobalChannel, 'effects')
  .pipe(rejoinExtensionChannels, 'effects')
  .pipe(refreshResumeStores, 'effects', 'completion')
  .endAsync('completion') as (effects: ConnectionResumeEffects) => Promise<void>;
