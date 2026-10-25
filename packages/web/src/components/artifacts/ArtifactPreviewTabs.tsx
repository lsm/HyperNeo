import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { artifactPreviewWorkspace } from '../../lib/artifact-preview-store.ts';
import type { PreviewWorkspaceFile } from '../../lib/artifact-preview-workspace.ts';
import { t } from '../../lib/i18n/index.ts';
import { Dropdown } from '../ui/Dropdown.tsx';

export const artifactTabIds = (id: string) => ({
  tab: `artifact-tab-${id}`,
  panel: `artifact-panel-${id}`,
  title: `artifact-title-${id}`,
});
export const artifactWorkTabId = 'artifact-preview-work-tab';

export function ArtifactPreviewTabs({
  files,
  selectedId,
  work,
}: {
  files: readonly PreviewWorkspaceFile[];
  selectedId: string | null;
  work?: { id: string; count: number; selected: boolean };
}) {
  const root = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const focusSelected = useRef(false);
  const [available, setAvailable] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => setAvailable(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const budget = Math.max(0, available - 8 - (work ? 84 : 0));
  const count =
    files.length * 92 > budget ? Math.max(1, Math.floor((budget - 40) / 92)) : files.length;
  const indices = files.slice(0, count).map((_, index) => index);
  const selected = files.findIndex((file) => file.artifactId === selectedId);
  if (selected >= count && indices.length) indices[indices.length - 1] = selected;
  const shown = indices.map((index) => files[index]);
  const overflow = files.filter((_, index) => !indices.includes(index));
  const width = Math.min(
    176,
    Math.max(88, (budget - (overflow.length ? 40 : 0)) / Math.max(1, shown.length) - 4)
  );
  useLayoutEffect(() => {
    if (menuOpen) root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const focusId = selectedId
      ? artifactTabIds(selectedId).tab
      : work?.selected
        ? artifactWorkTabId
        : null;
    if (focusSelected.current && focusId) {
      document.getElementById(focusId)?.focus();
      focusSelected.current = false;
    }
  }, [selectedId, menuOpen, files.length, work?.selected]);
  useEffect(() => {
    if (!overflow.length) setMenuOpen(false);
  }, [overflow.length]);
  return (
    <div
      ref={root}
      class="flex min-w-0 flex-1 items-center gap-1 rounded-full bg-fill-soft p-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menuOpen) {
          event.preventDefault();
          setMenuOpen(false);
          more.current?.focus();
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
        );
        const index = tabs.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
    >
      <div role="tablist" aria-label={t('artifact.region')} class="flex min-w-0 flex-1 gap-1">
        {work && (
          <button
            type="button"
            role="tab"
            id={artifactWorkTabId}
            aria-controls={work.id}
            aria-selected={work.selected}
            tabIndex={work.selected || (!selectedId && !files.length) ? 0 : -1}
            class={`h-8 w-20 shrink-0 truncate rounded-full px-2 text-xs hover:bg-surface-raised hover:text-fg ${work.selected ? 'bg-surface-raised text-fg' : 'text-fg-muted'}`}
            onClick={() => {
              setMenuOpen(false);
              artifactPreviewWorkspace.select(null);
            }}
            onKeyDown={(event) => {
              const panel = document.getElementById(work.id);
              if (event.key === 'Tab' && !event.shiftKey && work.selected && panel) {
                event.preventDefault();
                panel.focus({ preventScroll: true });
              }
            }}
          >
            {t('live.work')} · {work.count}
          </button>
        )}
        {shown.map((file) => (
          <div
            key={file.artifactId}
            style={{ width: `${width}px` }}
            class={`group flex shrink-0 items-center rounded-full hover:bg-surface-raised hover:text-fg ${file.artifactId === selectedId ? 'bg-surface-raised text-fg' : 'text-fg-muted'}`}
          >
            <button
              type="button"
              role="tab"
              id={artifactTabIds(file.artifactId).tab}
              aria-controls={artifactTabIds(file.artifactId).panel}
              aria-selected={file.artifactId === selectedId}
              tabIndex={
                !work?.selected && file.artifactId === (selectedId ?? shown[0]?.artifactId) ? 0 : -1
              }
              title={file.title || t('artifact.untitled')}
              class="min-w-0 flex-1 truncate rounded-full px-3 py-1.5 text-left text-xs"
              onClick={() => artifactPreviewWorkspace.select(file.artifactId)}
            >
              {file.title || t('artifact.untitled')}
            </button>
            <button
              type="button"
              aria-label={t('artifact.closeFile', { name: file.title || t('artifact.untitled') })}
              tabIndex={file.artifactId === selectedId ? 0 : -1}
              class={`mr-1 h-6 w-6 shrink-0 rounded-full text-xs hover:bg-fill-strong group-hover:opacity-100 group-focus-within:opacity-100 ${file.artifactId === selectedId ? 'opacity-100' : 'opacity-0'}`}
              onClick={() => {
                focusSelected.current = true;
                setMenuOpen(false);
                artifactPreviewWorkspace.close(file.artifactId);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {overflow.length > 0 && (
        <Dropdown
          class="shrink-0 [&_[role=menu]]:animate-none"
          isOpen={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={
            <button
              ref={more}
              type="button"
              aria-label={t('artifact.moreFiles', { count: overflow.length })}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              class="h-8 w-9 rounded-full text-xs text-fg-muted hover:bg-surface-raised"
            >
              <span aria-hidden="true">⌄ </span>
              {overflow.length}
            </button>
          }
          items={overflow.map((file) => ({
            label: file.title || t('artifact.untitled'),
            onClick: () => {
              focusSelected.current = true;
              artifactPreviewWorkspace.select(file.artifactId);
              setMenuOpen(false);
            },
          }))}
        />
      )}
    </div>
  );
}
