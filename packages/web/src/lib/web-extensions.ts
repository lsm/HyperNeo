import type {
  MessageHub,
  Session,
  Space,
  SpaceLongHorizonAgent,
  SpaceTask,
} from '@hyperneo/shared';
import type { ComponentChild, ComponentType } from 'preact';
import { type ReadonlySignal, signal } from '@preact/signals';
import { invokeOperation } from './operations';
import type { ExtensionPanelTarget } from './signals';

export type SpaceWithTaskList = Space & { tasks: SpaceTask[] };

export interface ShellExtension {
  activeChannel(): string | null;
  rejoinChannel(): void;
  refresh(): Promise<void>;
  sessionRenamed(sessionId: string, title: string): void;
  panelTarget(): ExtensionPanelTarget | null;
  sidebar(section: string): ComponentType<{ onClose: () => void }> | null;
  Content: ComponentType<{ fallback: ComponentChild }>;
  renderPanel(target: ExtensionPanelTarget): ComponentChild;
  sessionAgent(sessionId: string): ExtensionSessionAgent | null;
}

export interface ExtensionSessionAgent {
  rows: { label: string; value: string }[];
  instructions?: string;
  openSettings?(): void;
}

export interface ExtensionNavTab {
  id: string;
  label: string;
  icon: ComponentType;
  active: boolean;
  open(): void;
}

export interface ExtensionSearchResult {
  taskId?: string;
  spaceId?: string;
}

export interface ExtensionPaletteItem {
  id: string;
  group: string;
  title: string;
  subtitle: string;
  icon: ComponentType;
  open(): void;
}

export interface ExtensionRoute {
  path: string;
  open(): void;
}

export interface ExtensionNav {
  extension: keyof WebExtensions;
  section: string;
  label: string;
  icon: ComponentType;
  open(): void;
  contextTabs(): { label: string; tabs: ExtensionNavTab[] } | null;
  contentKey(): string | null;
  currentRoute(): ExtensionRoute | null;
  holdsSessionSelection(): boolean;
  voiceScope(): string | null;
  paletteItems(query: string): ExtensionPaletteItem[];
  warmPalette(): void;
  paletteSource(): unknown;
  openSearchResult(result: ExtensionSearchResult): boolean;
  sessionFocus(): {
    overlayOpen: boolean;
    overlaySessionId: string | null;
    sessionId: string | null;
    closeOverlay(): void;
    clearOverlay(): void;
  } | null;
  recordingReturn(
    scopeId: string,
    sessionId: string,
    taskId: string | null
  ): { path: string; open(replace: boolean): void } | null;
}

export interface SpaceWebExtension {
  shell: ShellExtension;
  store: {
    spaceId: ReadonlySignal<string | null>;
    space: ReadonlySignal<Space | null>;
    spacesWithTasks: ReadonlySignal<SpaceWithTaskList[]>;
    tasks: ReadonlySignal<SpaceTask[]>;
    agents: ReadonlySignal<SpaceLongHorizonAgent[]>;
    initGlobalList(): Promise<void>;
  };
}

export function extensionOwnsSession(session: Session): boolean {
  return !!session.context?.spaceId;
}

interface WebExtensions {
  space: SpaceWebExtension;
}

type WebExtensionLoaders = { [K in keyof WebExtensions]: () => Promise<WebExtensions[K]> };

const registered = signal<{ [K in keyof WebExtensions]?: WebExtensions[K] | null }>({});
const declaredNav = signal<ExtensionNav[]>([]);

export function declareExtensionNav(nav: ExtensionNav): void {
  declaredNav.value = [...declaredNav.value.filter((entry) => entry !== nav), nav];
}

export function extensionNav(): ExtensionNav[] {
  return declaredNav.value.filter((nav) => registered.value[nav.extension] !== null);
}

export function registerWebExtension<K extends keyof WebExtensions>(
  id: K,
  extension: WebExtensions[K] | null
): void {
  registered.value = { ...registered.value, [id]: extension };
}

export function webExtension<K extends keyof WebExtensions>(id: K): WebExtensions[K] | undefined {
  return registered.value[id] ?? undefined;
}

export function shellExtensions(): ShellExtension[] {
  return Object.values(registered.value).flatMap((extension) =>
    extension ? [extension.shell] : []
  );
}

export function webExtensionDeclined(id: keyof WebExtensions): boolean {
  return registered.value[id] === null;
}

export async function loadWebExtensions(
  getHub: () => Promise<MessageHub>,
  loaders: WebExtensionLoaders,
  retryMs = 2000
): Promise<void> {
  for (;;) {
    try {
      const listed = await invokeOperation<{ extensions: { id: string }[] }>(
        await getHub(),
        'daemon.extensions'
      )
        .then((result) => new Set(result.extensions.map((extension) => extension.id)))
        .catch(() => null);
      for (const id of Object.keys(loaders) as (keyof WebExtensions)[]) {
        registerWebExtension(id, !listed || listed.has(id) ? await loaders[id]() : null);
      }
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
