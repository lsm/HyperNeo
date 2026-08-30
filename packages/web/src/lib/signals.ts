import type { Session } from '@hyperneo/shared';
import { signal } from '@preact/signals';

export const currentSessionIdSignal = signal<string | null>(null);

export const sidebarOpenSignal = signal<boolean>(false);

export const sessionsSignal = signal<Session[]>([]);

export const slashCommandsSignal = signal<string[]>([]);

export type NavSection = 'chats' | 'spaces' | 'settings';
export const navSectionSignal = signal<NavSection>('spaces');

export const currentSpaceIdSignal = signal<string | null>(null);
export const currentSpaceCanonicalIdSignal = signal<string | null>(null);
export const currentSpaceSessionIdSignal = signal<string | null>(null);
export const currentSpaceTaskIdSignal = signal<string | null>(null);
export const currentSpaceAgentHandleSignal = signal<string | null>(null);
export type SpaceViewMode =
  | 'overview'
  | 'goals'
  | 'tasks'
  | 'sessions'
  | 'forge'
  | 'configure'
  | 'agents'
  | 'memories';
export const currentSpaceViewModeSignal = signal<SpaceViewMode>('overview');

export type SpaceConfigureTab = 'agents' | 'workflows' | 'settings';
export const currentSpaceConfigureTabSignal = signal<SpaceConfigureTab>('agents');

export type SpaceTasksFilterTab = 'action' | 'active' | 'completed' | 'draft' | 'scheduled';
export const currentSpaceTasksFilterTabSignal = signal<SpaceTasksFilterTab>('active');

export type SpaceTaskViewTab = 'thread' | 'timeline' | 'log' | 'canvas' | 'artifacts';
export const currentSpaceTaskViewTabSignal = signal<SpaceTaskViewTab>('thread');

export const spaceOverlaySessionIdSignal = signal<string | null>(null);
export const spaceOverlayAgentNameSignal = signal<string | null>(null);
export const spaceOverlayHighlightMessageIdSignal = signal<string | null>(null);

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
export interface SpaceOverlayTaskContext {
  taskId: string;
  agentName: string;
  readonly?: boolean;
  nodeExecutionId?: string | null;
  workflowNodeId?: string | null;
  sessionId?: string | null;
}

export const spaceOverlayTaskContextSignal = signal<SpaceOverlayTaskContext | null>(null);
export const spaceOverlayPendingTaskIdSignal = signal<string | null>(null);
export const spaceOverlayPendingAgentNameSignal = signal<string | null>(null);

export const contextPanelOpenSignal = signal<boolean>(false);

export type CommandPaletteMode = 'commands' | 'quick-open';
export const commandPaletteOpenSignal = signal<boolean>(false);
export const commandPaletteModeSignal = signal<CommandPaletteMode>('commands');

export type RightPanelTarget =
  | { type: 'git'; sessionId: string }
  | { type: 'goal'; spaceId: string; goalId: string }
  | { type: 'scope'; spaceId: string; scopeId: string }
  | { type: 'task'; spaceId: string; taskId: string; tab?: TaskRightPanelTab };
export const rightPanelTargetSignal = signal<RightPanelTarget | null>(null);

export type TaskRightPanelTab =
  | 'details'
  | 'workflow'
  | 'agents'
  | 'gates'
  | 'artifacts'
  | 'timeline'
  | 'log';

export const currentSpaceGoalIdSignal = signal<string | null>(null);
export const currentSpaceScopeIdSignal = signal<string | null>(null);

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'providers'
  | 'voice'
  | 'app-mcp-servers'
  | 'skills'
  | 'models'
  | 'usage'
  | 'shortcuts'
  | 'about';
export const settingsSectionSignal = signal<SettingsSection>('general');
