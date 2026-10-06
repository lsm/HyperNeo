import type { ChatDisplayMode } from '@hyperneo/shared';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

const OFFERED_MODES: readonly ChatDisplayMode[] = ['full', 'compact'];

export const ChatDisplayModeContext = createContext<ChatDisplayMode>('full');

export function useFoldedActivity(): boolean {
  return useContext(ChatDisplayModeContext) !== 'full';
}

export function resolveChatDisplayMode(
  sessionMode: ChatDisplayMode | undefined,
  defaultMode: ChatDisplayMode | undefined
): ChatDisplayMode {
  const mode = sessionMode ?? defaultMode ?? 'compact';
  return OFFERED_MODES.includes(mode) ? mode : 'compact';
}

export function nextChatDisplayMode(mode: ChatDisplayMode): ChatDisplayMode {
  return OFFERED_MODES[(OFFERED_MODES.indexOf(mode) + 1) % OFFERED_MODES.length];
}
