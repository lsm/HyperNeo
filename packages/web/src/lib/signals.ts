import type { Session } from '@hyperneo/shared';
import { signal } from '@preact/signals';

export const currentSessionIdSignal = signal<string | null>(null);

export const sidebarOpenSignal = signal<boolean>(false);

export const sessionsSignal = signal<Session[]>([]);

export const slashCommandsSignal = signal<string[]>([]);

export type NavSection = string;
export const navSectionSignal = signal<NavSection>('chats');

export interface SearchMessageLoadTarget {
  sessionId: string;
  before?: number;
  rowid?: number;
}

export interface SearchHighlightTarget {
  sessionId: string;
  messageId: string;
  loadTarget?: SearchMessageLoadTarget;
}
export const searchHighlightMessageIdSignal = signal<SearchHighlightTarget | null>(null);
export const contextPanelOpenSignal = signal<boolean>(false);

export type CommandPaletteMode = 'commands' | 'quick-open';
export const commandPaletteOpenSignal = signal<boolean>(false);
export const commandPaletteModeSignal = signal<CommandPaletteMode>('commands');

export type InspectorSection = 'session' | 'work' | 'changes';
export interface ExtensionPanelTarget {
  type: 'extension';
  panel: string;
  owner: string;
  item: string;
}
export type RightPanelTarget =
  | { type: 'inspector'; sessionId: string; section?: InspectorSection }
  | ExtensionPanelTarget;
export const rightPanelTargetSignal = signal<RightPanelTarget | null>(null);

export type SettingsSection =
  | 'preferences'
  | 'general'
  | 'providers'
  | 'connections'
  | 'voice'
  | 'exa'
  | 'app-mcp-servers'
  | 'devices'
  | 'remote-daemons'
  | 'skills'
  | 'coding-pack'
  | 'neo-model'
  | 'harness'
  | 'usage'
  | 'shortcuts'
  | 'about';
export const settingsSectionSignal = signal<SettingsSection>('preferences');
