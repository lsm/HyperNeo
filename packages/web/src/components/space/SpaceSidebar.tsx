import { useEffect, useMemo, useState } from 'preact/hooks';
import { CheckGlyph, ChevronLeftGlyph } from '../icons/common-glyphs.tsx';
import { SpaceCreateDialog } from './SpaceCreateDialog.tsx';
import { SpaceDetailPanel } from './SpaceDetailPanel.tsx';
import {
  navigateToSpace,
  navigateToSpaceAgent,
  navigateToSpaceConfigure,
  navigateToSpaceEvolve,
  navigateToSpaceGoals,
  navigateToSpaceMemories,
  navigateToSpaces,
  navigateToSpaceTasks,
} from '../../lib/space-router.ts';
import {
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  currentSpaceSettingsTabSignal,
  currentSpaceTasksFilterTabSignal,
  currentSpaceViewModeSignal,
} from '../../lib/space-signals.ts';
import { spaceStore } from '../../lib/space-store.ts';
import { cn } from '../../lib/utils.ts';

export function SpaceSidebar({ onClose }: { onClose: () => void }) {
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

  useEffect(() => {
    spaceStore.initGlobalList().catch(() => {});
  }, []);

  const currentSpaceId = currentSpaceIdSignal.value;
  const detailPanelSpaceId = currentSpaceCanonicalIdSignal.value ?? currentSpaceId;
  const currentSpaceSettingsTab = currentSpaceSettingsTabSignal.value;
  const currentSpaceTasksFilterTab = currentSpaceTasksFilterTabSignal.value;
  const currentSpaceViewMode = currentSpaceViewModeSignal.value;
  const headerTitle = spaceStore.space.value?.name ?? 'Space';

  const handleSpaceSwitch = (spaceId: string) => {
    switch (currentSpaceViewMode) {
      case 'agents':
        navigateToSpaceAgent(spaceId);
        break;
      case 'tasks':
        navigateToSpaceTasks(spaceId, currentSpaceTasksFilterTab);
        break;
      case 'goals':
        navigateToSpaceGoals(spaceId);
        break;
      case 'memories':
        navigateToSpaceMemories(spaceId);
        break;
      case 'forge':
        navigateToSpaceEvolve(spaceId);
        break;
      case 'configure':
        navigateToSpaceConfigure(spaceId, currentSpaceSettingsTab);
        break;
      case 'overview':
      default:
        navigateToSpace(spaceId);
        break;
    }
    onClose();
  };

  const handleCreateSpace = () => {
    setCreateSpaceOpen(true);
    onClose();
  };

  const spacesWithTasks = spaceStore.spacesWithTasks.value;
  const activeSpaces = useMemo(
    () => spacesWithTasks.filter((space) => space.status === 'active'),
    [spacesWithTasks]
  );

  return (
    <>
      {currentSpaceId === null ? (
        <div class="flex-1 overflow-y-auto py-2" data-testid="space-switcher">
          {activeSpaces.length === 0 ? (
            <div class="px-4 py-8 text-center">
              <svg
                class="w-10 h-10 mx-auto text-fg-muted mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={1.5}
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
              <p class="text-sm font-medium text-fg-soft">No spaces yet</p>
              <p class="text-xs text-fg-muted mt-1">
                Create a Space to organize agents, missions, and project context.
              </p>
            </div>
          ) : (
            <nav class="px-2 space-y-1" aria-label="Switch spaces">
              {activeSpaces.map((space) => {
                const isCurrent = space.id === currentSpaceId;
                return (
                  <button
                    key={space.id}
                    type="button"
                    onClick={() => handleSpaceSwitch(space.slug)}
                    aria-current={isCurrent ? 'page' : undefined}
                    class={cn(
                      'w-full rounded-lg px-3 py-3 flex items-center gap-3 text-left transition-colors',
                      isCurrent
                        ? 'bg-fill border border-transparent text-fg'
                        : 'border border-transparent text-fg-muted hover:bg-fill-soft hover:text-fg'
                    )}
                  >
                    <svg
                      class="w-5 h-5 flex-shrink-0 text-fg-muted"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={1.75}
                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                      />
                    </svg>
                    <div class="min-w-0 flex-1">
                      <div class="text-sm font-medium truncate">{space.name}</div>
                      {space.description && (
                        <div class="text-xs text-fg-muted truncate mt-0.5">{space.description}</div>
                      )}
                    </div>
                    {isCurrent && (
                      <CheckGlyph
                        class="w-4 h-4 text-fg-soft flex-shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      />
                    )}
                  </button>
                );
              })}
            </nav>
          )}
          <div class="px-4 pt-4 pb-6">
            <button
              type="button"
              onClick={handleCreateSpace}
              class="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-line-strong hover:border-line-strong hover:bg-fill-soft text-sm text-fg-muted hover:text-fg transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Create Space
            </button>
          </div>
        </div>
      ) : (
        <>
          <div class="hidden h-9 items-center gap-1 px-4 pt-1 md:flex">
            <button
              type="button"
              onClick={() => navigateToSpaces()}
              class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg"
              title="Back to Spaces"
              aria-label="Back to Spaces"
            >
              <ChevronLeftGlyph
                class="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              />
            </button>
            <h2 class="min-w-0 flex-1 text-sm font-semibold text-fg truncate">{headerTitle}</h2>
          </div>

          <div class="flex-1 flex flex-col overflow-hidden">
            <div class="md:hidden px-2 pt-2 pb-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => {
                  navigateToSpaces();
                  onClose();
                }}
                class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg w-full text-sm text-fg-muted hover:text-fg hover:bg-fill-soft transition-colors"
              >
                <ChevronLeftGlyph
                  class="w-4 h-4 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                />
                All Spaces
              </button>
            </div>
            <SpaceDetailPanel
              spaceId={detailPanelSpaceId!}
              navigationSpaceId={currentSpaceId!}
              onNavigate={onClose}
            />
          </div>
        </>
      )}
      <SpaceCreateDialog isOpen={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} />
    </>
  );
}
