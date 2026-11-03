import type {
  MessageHub,
  Space,
  SpaceLongHorizonAgent,
  SpaceTask,
  SpaceTaskActivityMember,
} from '@hyperneo/shared';
import type { ComponentType } from 'preact';
import { type ReadonlySignal, signal } from '@preact/signals';
import { invokeOperation } from './operations';
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

type WebExtensionLoaders = { [K in keyof WebExtensions]: () => Promise<WebExtensions[K]> };

const registered = signal<{ [K in keyof WebExtensions]?: WebExtensions[K] | null }>({});

export function registerWebExtension<K extends keyof WebExtensions>(
  id: K,
  extension: WebExtensions[K] | null
): void {
  registered.value = { ...registered.value, [id]: extension };
}

export function webExtension<K extends keyof WebExtensions>(id: K): WebExtensions[K] | undefined {
  return registered.value[id] ?? undefined;
}

export function webExtensionDeclined(id: keyof WebExtensions): boolean {
  return registered.value[id] === null;
}

export async function loadWebExtensions(
  hub: MessageHub,
  loaders: WebExtensionLoaders
): Promise<void> {
  const listed = await invokeOperation<{ extensions: { id: string }[] }>(
    hub,
    'daemon.extensions'
  ).then(
    (result) => new Set(result.extensions.map((extension) => extension.id)),
    () => null
  );
  for (const id of Object.keys(loaders) as (keyof WebExtensions)[]) {
    registerWebExtension(id, !listed || listed.has(id) ? await loaders[id]() : null);
  }
}
