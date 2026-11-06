import { signal } from '@preact/signals';

export const currentSpaceIdSignal = signal<string | null>(null);
export const currentSpaceCanonicalIdSignal = signal<string | null>(null);
export const currentSpaceSessionIdSignal = signal<string | null>(null);
export const currentSpaceTaskIdSignal = signal<string | null>(null);
export const currentSpaceAgentHandleSignal = signal<string | null>(null);
export type SpaceViewMode =
  | 'overview'
  | 'goals'
  | 'tasks'
  | 'forge'
  | 'configure'
  | 'agents'
  | 'memories';
export const currentSpaceViewModeSignal = signal<SpaceViewMode>('overview');

export type SpaceSettingsTab =
  | 'general'
  | 'runtime'
  | 'tools'
  | 'events'
  | 'agent-templates'
  | 'workflow-templates'
  | 'advanced';
export const currentSpaceSettingsTabSignal = signal<SpaceSettingsTab>('general');

export type SpaceTasksFilterTab = 'action' | 'active' | 'completed' | 'draft' | 'scheduled';
export const currentSpaceTasksFilterTabSignal = signal<SpaceTasksFilterTab>('active');

export const spaceOverlaySessionIdSignal = signal<string | null>(null);
export const spaceOverlayAgentNameSignal = signal<string | null>(null);
export const spaceOverlayHighlightMessageIdSignal = signal<string | null>(null);

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

export const currentSpaceGoalIdSignal = signal<string | null>(null);
export const currentSpaceScopeIdSignal = signal<string | null>(null);
