import { commandRegistry, type CommandDescriptor } from './command-registry.ts';
import {
  commandPaletteModeSignal,
  commandPaletteOpenSignal,
  currentSpaceIdSignal,
  navSectionSignal,
  settingsSectionSignal,
} from './signals.ts';
import {
  navigateToSessions,
  navigateToSettings,
  navigateToSpace,
  navigateToSpaceConfigure,
  navigateToSpaceSessions,
  navigateToSpaceTasks,
  navigateToSpacesPage,
} from './router.ts';
import { createSession } from './api-helpers.ts';
import { toast } from './toast.ts';
import { connectionState } from './state.ts';
import { ConnectionNotReadyError } from './errors.ts';

function closePalette() {
  commandPaletteOpenSignal.value = false;
}

function openPalette(mode: 'commands' | 'quick-open') {
  commandPaletteModeSignal.value = mode;
  commandPaletteOpenSignal.value = true;
}

async function runCreateSession() {
  if (connectionState.value !== 'connected') {
    toast.error('Not connected to server. Please wait...');
    return;
  }
  try {
    const response = await createSession({ workspacePath: undefined });
    if (!response?.sessionId) {
      toast.error('No sessionId in response');
      return;
    }
    const { navigateToSession } = await import('./router.ts');
    navigateToSession(response.sessionId);
    toast.success('Session created');
  } catch (err) {
    if (err instanceof ConnectionNotReadyError) {
      toast.error('Connection lost. Please try again.');
    } else {
      toast.error(err instanceof Error ? err.message : 'Failed to create session');
    }
  }
}

function requireSpace(action: (spaceId: string) => void) {
  return () => {
    const spaceId = currentSpaceIdSignal.value;
    if (!spaceId) {
      toast.error('Open a space first');
      return;
    }
    action(spaceId);
  };
}

export const DEFAULT_COMMANDS: readonly CommandDescriptor[] = [
  {
    id: 'palette.open',
    label: 'Open command palette',
    category: 'help',
    description: 'Show the command palette',
    keywords: ['cmd', 'search', 'palette'],
    shortcut: { code: 'KeyK', mod: true },
    run: () => {
      openPalette('commands');
    },
  },
  {
    id: 'quickOpen.open',
    label: 'Open quick open',
    category: 'navigation',
    description: 'Jump to chats, messages, tasks, and spaces',
    keywords: ['spotlight', 'search', 'jump', 'go'],
    shortcut: { code: 'KeyP', mod: true },
    run: () => {
      openPalette('quick-open');
    },
  },
  {
    id: 'session.new',
    label: 'New session',
    category: 'session',
    description: 'Create a new chat session',
    keywords: ['create', 'chat', 'start'],
    shortcut: { code: 'KeyN', mod: true, shift: true },
    run: async () => {
      closePalette();
      await runCreateSession();
    },
  },
  {
    id: 'nav.sessions',
    label: 'Go to sessions',
    category: 'navigation',
    keywords: ['chats', 'history'],
    run: () => {
      closePalette();
      navSectionSignal.value = 'chats';
      navigateToSessions();
    },
  },
  {
    id: 'nav.spaces',
    label: 'Go to spaces',
    category: 'navigation',
    keywords: ['workspace'],
    run: () => {
      closePalette();
      navSectionSignal.value = 'spaces';
      navigateToSpacesPage();
    },
  },
  {
    id: 'nav.settings',
    label: 'Open settings',
    category: 'settings',
    keywords: ['preferences', 'config'],
    shortcut: { code: 'Comma', mod: true },
    run: () => {
      closePalette();
      navSectionSignal.value = 'settings';
      navigateToSettings();
    },
  },
  {
    id: 'settings.providers',
    label: 'Settings: Providers',
    category: 'settings',
    keywords: ['api', 'keys', 'auth'],
    run: () => {
      closePalette();
      navSectionSignal.value = 'settings';
      settingsSectionSignal.value = 'providers';
      navigateToSettings('providers');
    },
  },
  {
    id: 'settings.models',
    label: 'Settings: Models',
    category: 'settings',
    keywords: ['model', 'switch'],
    run: () => {
      closePalette();
      navSectionSignal.value = 'settings';
      settingsSectionSignal.value = 'models';
      navigateToSettings('models');
    },
  },
  {
    id: 'settings.skills',
    label: 'Settings: Skills',
    category: 'settings',
    keywords: ['plugins', 'commands'],
    run: () => {
      closePalette();
      navSectionSignal.value = 'settings';
      settingsSectionSignal.value = 'skills';
      navigateToSettings('skills');
    },
  },
  {
    id: 'settings.shortcuts',
    label: 'Settings: Keyboard shortcuts',
    category: 'settings',
    keywords: ['keys', 'bindings', 'hotkeys'],
    run: () => {
      closePalette();
      navSectionSignal.value = 'settings';
      settingsSectionSignal.value = 'shortcuts';
      navigateToSettings('shortcuts');
    },
  },
  {
    id: 'space.tasks',
    label: 'Space: View tasks',
    category: 'space',
    keywords: ['mission'],
    run: requireSpace((spaceId) => {
      closePalette();
      navigateToSpaceTasks(spaceId);
    }),
  },
  {
    id: 'space.sessions',
    label: 'Space: View sessions',
    category: 'space',
    run: requireSpace((spaceId) => {
      closePalette();
      navigateToSpaceSessions(spaceId);
    }),
  },
  {
    id: 'space.configure',
    label: 'Space: Configure',
    category: 'space',
    keywords: ['agents', 'workflows'],
    run: requireSpace((spaceId) => {
      closePalette();
      navigateToSpaceConfigure(spaceId);
    }),
  },
  {
    id: 'space.overview',
    label: 'Space: Overview',
    category: 'space',
    run: requireSpace((spaceId) => {
      closePalette();
      navigateToSpace(spaceId);
    }),
  },
];

let registered = false;

export function registerDefaultCommands(): void {
  if (registered) return;
  commandRegistry.registerAll(DEFAULT_COMMANDS);
  registered = true;
}

export function _resetDefaultCommandRegistration(): void {
  registered = false;
}

registerDefaultCommands();
