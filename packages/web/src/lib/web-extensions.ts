import type {
  Space,
  SpaceLongHorizonAgent,
  SpaceTask,
  SpaceTaskActivityMember,
} from '@hyperneo/shared';
import type { ComponentType } from 'preact';
import { type ReadonlySignal, signal } from '@preact/signals';
import type { SpaceViewMode } from './signals';

export type SpaceWithTaskList = Space & { tasks: SpaceTask[] };

export interface SpaceWebExtension {
  store: {
    spaceId: ReadonlySignal<string | null>;
    space: ReadonlySignal<Space | null>;
    spacesWithTasks: ReadonlySignal<SpaceWithTaskList[]>;
    tasks: ReadonlySignal<SpaceTask[]>;
    agents: ReadonlySignal<SpaceLongHorizonAgent[]>;
    taskActivity: ReadonlySignal<Map<string, SpaceTaskActivityMember[]>>;
    initGlobalList(): Promise<void>;
    refresh(): Promise<void>;
    rejoinChannel(): void;
    updateSession(sessionId: string, patch: { title: string }): void;
    activateTaskNodeAgent(
      taskId: string,
      agentName: string,
      message?: string,
      workflowNodeId?: string,
      clientMessageId?: string
    ): Promise<{ sessionId: string | null }>;
  };
  SpaceIsland: ComponentType<{
    spaceId: string;
    routeSpaceId?: string | null;
    viewMode: SpaceViewMode;
    sessionViewId?: string | null;
    taskViewId?: string | null;
  }>;
  SpaceDetailPanel: ComponentType<{
    spaceId: string;
    navigationSpaceId?: string;
    onNavigate?: () => void;
  }>;
  SpacesHome: ComponentType;
  SpaceCreateDialog: ComponentType<{ isOpen: boolean; onClose: () => void }>;
  GoalDetailPanel: ComponentType<{ spaceId: string; navigationSpaceId?: string; goalId: string }>;
  ScopeDetailPanel: ComponentType<{ spaceId: string; scopeId: string }>;
}

interface WebExtensions {
  space: SpaceWebExtension;
}

const registered = signal<Partial<WebExtensions>>({});

export function registerWebExtension<K extends keyof WebExtensions>(
  id: K,
  extension: WebExtensions[K]
): void {
  registered.value = { ...registered.value, [id]: extension };
}

export function webExtension<K extends keyof WebExtensions>(id: K): WebExtensions[K] | undefined {
  return registered.value[id];
}
