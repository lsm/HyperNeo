import type { Session } from '@neokai/shared';
import { signal } from '@preact/signals';

// Shared signal for the current session ID - always starts as null
// Refreshing the page will return to recent conversations view
export const currentSessionIdSignal = signal<string | null>(null);

// Shared signal for sidebar open/closed state on mobile
export const sidebarOpenSignal = signal<boolean>(false);

/**
 * @deprecated Use the reactive state channels from lib/state.ts instead:
 * - sessions: import { sessions } from "../lib/state.ts"
 * This signal is kept for backward compatibility but will be removed in the future.
 */
export const sessionsSignal = signal<Session[]>([]);

// Shared signal for available slash commands from SDK
// TODO: Migrate to state channels when slash commands are added to state management
export const slashCommandsSignal = signal<string[]>([]);

// Navigation section signal - which nav item is active
export type NavSection = 'chats' | 'spaces' | 'settings';
export const navSectionSignal = signal<NavSection>('spaces');

// Space navigation signals
export const currentSpaceIdSignal = signal<string | null>(null);
export const currentSpaceSessionIdSignal = signal<string | null>(null);
export const currentSpaceTaskIdSignal = signal<string | null>(null);
export type SpaceViewMode =
  | 'overview'
  | 'goals'
  | 'tasks'
  | 'sessions'
  | 'forge'
  | 'configure'
  | 'agents';
export const currentSpaceViewModeSignal = signal<SpaceViewMode>('overview');

// Configure sub-tab (agents | workflows | settings) — driven by URL
export type SpaceConfigureTab = 'agents' | 'workflows' | 'settings';
export const currentSpaceConfigureTabSignal = signal<SpaceConfigureTab>('agents');

// Tasks filter tab (action | active | draft | completed | scheduled) — driven by URL
export type SpaceTasksFilterTab = 'action' | 'active' | 'completed' | 'draft' | 'scheduled';
export const currentSpaceTasksFilterTabSignal = signal<SpaceTasksFilterTab>('active');

// Task detail sub-view (thread | timeline | log | canvas | artifacts) — driven by URL.
// Thread/canvas render in the main column; timeline/log/artifacts route into
// the contextual right panel for backward-compatible deep links.
export type SpaceTaskViewTab = 'thread' | 'timeline' | 'log' | 'canvas' | 'artifacts';
export const currentSpaceTaskViewTabSignal = signal<SpaceTaskViewTab>('thread');

// Overlay signals — session shown in slide-over panel on top of the current view
// When spaceOverlaySessionIdSignal is set, opens AgentOverlayChat without replacing the task/overview view
export const spaceOverlaySessionIdSignal = signal<string | null>(null);
// Human-readable label for the overlay header (e.g. "View Leader Session", "manual-se")
export const spaceOverlayAgentNameSignal = signal<string | null>(null);
// Optional message UUID to scroll into view + briefly highlight when the overlay
// opens. Set when the user opens a session from a specific message in the
// minimal thread feed so they land on the message they clicked instead of the
// session's tail. Cleared along with the other overlay signals on close.
export const spaceOverlayHighlightMessageIdSignal = signal<string | null>(null);

// Message selected from search results. ChatContainer consumes this after routing to target session.
export interface SearchMessageLoadTarget {
  sessionId: string;
  before?: number;
}

export interface SearchHighlightTarget {
  sessionId: string;
  messageId: string;
  loadTarget?: SearchMessageLoadTarget;
}
export const searchHighlightMessageIdSignal = signal<SearchHighlightTarget | null>(null);
// Task messaging context for live workflow node-agent overlays. When set, sends
// from AgentOverlayChat route through space.task.sendMessage instead of the
// generic message.send RPC so they target the already-live workflow sub-session.
export interface SpaceOverlayTaskContext {
  taskId: string;
  agentName: string;
  nodeExecutionId?: string | null;
}

export const spaceOverlayTaskContextSignal = signal<SpaceOverlayTaskContext | null>(null);
// Pending-agent overlay routing — set when the user opens a not-started peer
// from the node-agent target picker. The overlay renders a "Starting…" composer
// against the agent name; on first send it invokes
// `space.task.activateNodeAgent` to lazily spawn the workflow node, and
// hydrates to a normal chat overlay as soon as the live session appears in
// `taskActivity`. Both signals are cleared together on close.
export const spaceOverlayPendingTaskIdSignal = signal<string | null>(null);
export const spaceOverlayPendingAgentNameSignal = signal<string | null>(null);

// Mobile drawer signals
export const contextPanelOpenSignal = signal<boolean>(false);

// Global palette visibility. Cmd+K opens command mode; Cmd+P opens quick-open mode.
export type CommandPaletteMode = 'commands' | 'quick-open';
export const commandPaletteOpenSignal = signal<boolean>(false);
export const commandPaletteModeSignal = signal<CommandPaletteMode>('commands');

// Global right-side panel. The shell is target-based so any view can attach a
// contextual detail panel: Git status for sessions, goal/scope detail for the
// Space Goals and Forge views.
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

// Current selection within the Space Goals / Forge lists. Drives card highlight
// and gives the right-panel toggle something to (re)open. Distinct from
// rightPanelTargetSignal, which only tracks what is currently open.
export const currentSpaceGoalIdSignal = signal<string | null>(null);
export const currentSpaceScopeIdSignal = signal<string | null>(null);

// Settings section signal - which settings section is active
export type SettingsSection =
  | 'general'
  | 'providers'
  | 'custom-endpoints'
  | 'app-mcp-servers'
  | 'skills'
  | 'models'
  | 'usage'
  | 'shortcuts'
  | 'about';
export const settingsSectionSignal = signal<SettingsSection>('general');
