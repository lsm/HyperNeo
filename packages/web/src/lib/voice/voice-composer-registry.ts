import { signal } from '@preact/signals';

export const voiceReturnTaskTargetSessionSignal = signal<string | null>(null);

export interface VoiceComposerInfo {
  surfaceId: string;
  sessionId: string;
  canAdopt: boolean;
}

const composersByOwner = new Map<string, VoiceComposerInfo>();

export function registerVoiceComposer(ownerId: string, info: VoiceComposerInfo): void {
  composersByOwner.set(ownerId, info);
}

export function unregisterVoiceComposer(ownerId: string): void {
  composersByOwner.delete(ownerId);
}

export function voiceComposerSurfaceOf(ownerId: string | null): string | null {
  if (ownerId === null) return null;
  return composersByOwner.get(ownerId)?.surfaceId ?? null;
}

export function hasAdoptableComposerOnSurface(surfaceId: string, sessionId: string): boolean {
  for (const info of composersByOwner.values()) {
    if (info.surfaceId === surfaceId && info.sessionId === sessionId && info.canAdopt) {
      return true;
    }
  }
  return false;
}
