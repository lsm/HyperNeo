import type { CommandDescriptor } from './command-registry.ts';
import {
  navigateToSpace,
  navigateToSpaceConfigure,
  navigateToSpacesPage,
  navigateToSpaceTasks,
} from './space-router.ts';
import { commandPaletteOpenSignal, navSectionSignal } from './signals.ts';
import { currentSpaceIdSignal } from './space-signals.ts';
import { toast } from './toast.ts';

function inCurrentSpace(action: (spaceId: string) => void) {
  return () => {
    const spaceId = currentSpaceIdSignal.value;
    if (!spaceId) {
      toast.error('Open a space first');
      return;
    }
    commandPaletteOpenSignal.value = false;
    action(spaceId);
  };
}

export const SPACE_COMMANDS: readonly CommandDescriptor[] = [
  {
    id: 'nav.spaces',
    label: 'Go to spaces',
    category: 'navigation',
    keywords: ['workspace'],
    extension: 'space',
    run: () => {
      commandPaletteOpenSignal.value = false;
      navSectionSignal.value = 'spaces';
      navigateToSpacesPage();
    },
  },
  {
    id: 'space.tasks',
    label: 'Space: View tasks',
    category: 'Spaces',
    keywords: ['mission'],
    extension: 'space',
    run: inCurrentSpace((spaceId) => navigateToSpaceTasks(spaceId)),
  },
  {
    id: 'space.configure',
    label: 'Space: Configure',
    category: 'Spaces',
    keywords: ['agents', 'workflows'],
    extension: 'space',
    run: inCurrentSpace((spaceId) => navigateToSpaceConfigure(spaceId)),
  },
  {
    id: 'space.overview',
    label: 'Space: Overview',
    category: 'Spaces',
    extension: 'space',
    run: inCurrentSpace((spaceId) => navigateToSpace(spaceId)),
  },
];
