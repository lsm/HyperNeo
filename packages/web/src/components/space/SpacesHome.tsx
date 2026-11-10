import { CheckGlyph, ChevronRightGlyph } from '../icons/common-glyphs.tsx';
import type { ComponentChildren } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import {
  navigateToSpace,
  navigateToSpaceTask,
  navigateToSpaceSession,
} from '../../lib/space-router.ts';
import { spaceStore } from '../../lib/space-store.ts';
import { isActionRequired, isActiveTask } from '../../lib/space-task-filters.ts';
import { getTaskStatusClasses, getTaskStatusConfig } from '../../lib/space-task-status.ts';
import { StatusBadge } from '../ui/StatusBadge.tsx';
import { SpaceCreateDialog } from './SpaceCreateDialog.tsx';
import { MobileMenuButton } from '../ui/MobileMenuButton.tsx';

function SpacesSection({
  dotClass,
  label,
  count,
  countClass,
  children,
}: {
  dotClass: string;
  label: string;
  count: number;
  countClass: string;
  children: ComponentChildren;
}) {
  return (
    <section class="flat-surface overflow-hidden rounded-2xl">
      <div class="flex items-center gap-2 px-4 pb-2.5 pt-3">
        <span class={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${dotClass}`} />
        <span class="text-xs font-semibold text-fg-muted uppercase tracking-wide">{label}</span>
        <span class={`ml-auto text-xs font-medium tabular-nums ${countClass}`}>{count}</span>
      </div>
      <div class="divide-y divide-line border-t border-line">{children}</div>
    </section>
  );
}

export function SpacesHome() {
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const spaces = spaceStore.spacesWithTasks.value.filter((s) => s.status !== 'archived');

  useEffect(() => {
    spaceStore.initGlobalList().catch(() => {});
  }, []);

  const actionItems = spaces.flatMap((space) =>
    space.tasks.filter(isActionRequired).map((task) => ({ task, space }))
  );

  const runningItems = spaces.flatMap((space) =>
    space.tasks
      .filter((task) => isActiveTask(task) && task.status !== 'stopped')
      .map((task) => ({ task, space }))
  );

  const activeSessions = spaces
    .flatMap((space) =>
      space.sessions.filter((s) => s.status === 'active').map((session) => ({ session, space }))
    )
    .sort((a, b) => b.session.lastActiveAt - a.session.lastActiveAt);

  const hasContent = actionItems.length > 0 || runningItems.length > 0 || activeSessions.length > 0;

  const rowClass =
    'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-fill-soft transition-colors group';

  return (
    <div class="glass-route-shell">
      <div class="desktop-empty-drag-strip" data-tauri-drag-region />
      <div class="flex-1 overflow-y-auto scrollbar-dark">
        <div class="glass-content-container">
          <div class="mb-4 flex items-center gap-3 md:hidden">
            <MobileMenuButton />
          </div>

          <section
            class="glass-surface mb-5 flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
            data-testid="spaces-introduction"
            aria-label="Spaces overview"
          >
            <div class="max-w-2xl">
              <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-soft">
                <span class="h-1.5 w-1.5 rounded-full bg-accent" />
                {spaces.length} {spaces.length === 1 ? 'space' : 'spaces'}
              </div>
              <h1 class="mt-2 text-lg font-semibold tracking-tight text-fg">Spaces</h1>
              <p class="mt-1 text-sm leading-5 text-fg-soft">
                Attention, active sessions, and in-progress work across every space.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreateSpaceOpen(true)}
              class="glass-primary-button !h-9 !px-3.5 !text-xs"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              <span class="ml-1.5">New Space</span>
            </button>
          </section>

          {spaces.length === 0 ? (
            <div class="flat-surface flex flex-col items-center justify-center rounded-2xl py-12 text-center">
              <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-raised">
                <svg
                  class="w-5 h-5 text-fg-muted"
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
              </div>
              <p class="text-sm text-fg-muted">No spaces yet</p>
              <p class="mt-1 text-xs text-fg-muted">
                Create a Space to coordinate agents around a project goal.
              </p>
              <button
                type="button"
                onClick={() => setCreateSpaceOpen(true)}
                class="glass-primary-button mt-4 !h-9 !px-3.5 !text-xs"
              >
                Create your first Space
              </button>
            </div>
          ) : !hasContent ? (
            <div class="flat-surface overflow-hidden rounded-2xl">
              <div class="flex items-center gap-2.5 px-4 py-3 text-sm text-fg-faint">
                <CheckGlyph
                  class="w-4 h-4 text-success flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                />
                All quiet — no active work across your spaces
              </div>
              <div class="divide-y divide-line border-t border-line">
                {spaces.map((space) => (
                  <button
                    key={space.id}
                    type="button"
                    onClick={() => navigateToSpace(space.slug)}
                    class={rowClass}
                  >
                    <svg
                      class="w-4 h-4 text-fg-faint flex-shrink-0"
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
                    <span class="text-sm text-fg-muted group-hover:text-fg transition-colors truncate flex-1">
                      {space.name}
                    </span>
                    <ChevronRightGlyph
                      class="w-3.5 h-3.5 text-fg-faint group-hover:text-fg-soft flex-shrink-0 transition-colors"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div class="flex flex-col gap-5">
              {actionItems.length > 0 && (
                <SpacesSection
                  dotClass="bg-warning"
                  label="Needs Attention"
                  count={actionItems.length}
                  countClass="text-warning-soft"
                >
                  {actionItems.map(({ task, space }) => {
                    const statusConfig = getTaskStatusConfig(task.status);
                    const statusClasses = getTaskStatusClasses(task.status);
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => navigateToSpaceTask(space.slug, task.id)}
                        class={`relative ${rowClass} ${statusClasses.wash}`}
                      >
                        <span
                          class={`absolute inset-y-0 left-0 w-[3px] ${statusClasses.rail}`}
                          aria-hidden="true"
                        />
                        <div class="min-w-0 flex-1">
                          <div class="text-sm text-fg-soft truncate">{task.title}</div>
                          <div class="text-xs text-fg-faint truncate mt-0.5">{space.name}</div>
                        </div>
                        <StatusBadge tone={statusConfig.tone} label={statusConfig.label} />
                      </button>
                    );
                  })}
                </SpacesSection>
              )}

              {activeSessions.length > 0 && (
                <SpacesSection
                  dotClass="bg-success"
                  label="Active Sessions"
                  count={activeSessions.length}
                  countClass="text-success"
                >
                  {activeSessions.map(({ session, space }) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => navigateToSpaceSession(space.slug, session.id)}
                      class={rowClass}
                    >
                      <div class="w-2 h-2 rounded-full bg-success flex-shrink-0" />
                      <div class="min-w-0 flex-1">
                        <div class="text-sm text-fg-soft truncate">{session.title}</div>
                        <div class="text-xs text-fg-faint truncate mt-0.5">{space.name}</div>
                      </div>
                    </button>
                  ))}
                </SpacesSection>
              )}

              {runningItems.length > 0 && (
                <SpacesSection
                  dotClass="bg-accent"
                  label="In Progress"
                  count={runningItems.length}
                  countClass="text-accent"
                >
                  {runningItems.map(({ task, space }) => {
                    const statusConfig = getTaskStatusConfig(task.status);
                    const statusClasses = getTaskStatusClasses(task.status);
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => navigateToSpaceTask(space.slug, task.id)}
                        class={`relative ${rowClass} ${statusClasses.wash}`}
                      >
                        <span
                          class={`absolute inset-y-0 left-0 w-[3px] ${statusClasses.rail}`}
                          aria-hidden="true"
                        />
                        <div class="min-w-0 flex-1">
                          <div class="text-sm text-fg-soft truncate">{task.title}</div>
                          <div class="text-xs text-fg-faint truncate mt-0.5">{space.name}</div>
                        </div>
                        <StatusBadge tone={statusConfig.tone} label={statusConfig.label} />
                      </button>
                    );
                  })}
                </SpacesSection>
              )}
            </div>
          )}
        </div>
      </div>
      <SpaceCreateDialog isOpen={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} />
    </div>
  );
}
