import { generateUUID } from '@hyperneo/shared/utils';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import { t } from '../../lib/i18n/index.ts';
import {
  artifactPreviewStack,
  artifactPreviewWorkspace,
  backArtifactPreview,
  closeArtifactPreview,
  takeArtifactPreviewOpener,
} from '../../lib/artifact-preview-store.ts';
import type { ArtifactResolution } from '../../lib/artifact-reference-client.ts';
import { ArtifactPreview } from './ArtifactPreview.tsx';
import { ReferenceView } from './ReferenceView.tsx';
import { ArtifactPreviewTabs, artifactTabIds, artifactWorkTabId } from './ArtifactPreviewTabs.tsx';

const rememberMetadata = (metadata: ArtifactFileMetadata) =>
  artifactPreviewWorkspace.update(metadata.artifact);

export function ArtifactPreviewPanel({
  markdownClass,
  fileTabs = false,
  work,
  suspended = false,
  expansion,
}: {
  markdownClass?: string;
  fileTabs?: boolean;
  work?: { id: string; showTab: boolean; count: number };
  suspended?: boolean;
  expansion?: { expanded: boolean; toggle: () => void };
} = {}) {
  const stack = artifactPreviewStack.value;
  const top = stack.at(-1);
  const desktopQuery = work ? '(min-width: 720px)' : '(min-width: 1120px)';
  const [desktop, setDesktop] = useState(() => fileTabs && window.matchMedia(desktopQuery).matches);
  useEffect(() => {
    if (!fileTabs) return;
    const update = () => setDesktop(window.matchMedia(desktopQuery).matches);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [fileTabs, desktopQuery]);
  const tabbed = fileTabs && desktop;
  const files = artifactPreviewWorkspace.state.value.files;
  const selectedId = top?.kind === 'artifact' ? top.artifactId : null;
  const workActive = tabbed && !!work && artifactPreviewWorkspace.state.value.open && !top;
  const open = !!top || workActive;
  const showWork = tabbed && work?.showTab && top?.kind !== 'reference';
  const focusEntry = workActive ? artifactWorkTabId : tabbed && selectedId ? open : stack[0];
  const dialog = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const resolved = useRef(new Map<string, ArtifactResolution>());
  const visible = useRef(!suspended);
  visible.current = !suspended;

  useLayoutEffect(() => {
    if (!open) return;
    const entry = generateUUID();
    history.pushState({ ...history.state, artifactPreview: entry }, '');
    const onPop = () => {
      if (visible.current) closeArtifactPreview();
    };
    let foregroundEscape: KeyboardEvent | undefined;
    const onCapture = (event: KeyboardEvent) => {
      if (
        visible.current &&
        event.key === 'Escape' &&
        document.querySelector(
          '[role="menu"], [aria-modal="true"], .markdown-image-overlay, #neo-preferences, #neo-preferences-session'
        )
      )
        foregroundEscape = event;
    };
    const onKey = (event: KeyboardEvent) => {
      if (!visible.current) return;
      if (
        event.key === 'Escape' &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !event.defaultPrevented &&
        foregroundEscape !== event
      )
        closeArtifactPreview();
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      if (history.state?.artifactPreview === entry) history.back();
      resolved.current.clear();
      takeArtifactPreviewOpener()?.focus({ preventScroll: true });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!visible.current) return;
    if (tabbed && document.activeElement?.getAttribute('role') === 'tab') return;
    dialog.current?.focus({ preventScroll: true });
  }, [focusEntry]);

  if (!top && !workActive) return null;
  return (
    <>
      <button
        type="button"
        aria-label={t('artifact.dismiss')}
        class="artifact-preview-backdrop"
        hidden={suspended}
        onClick={closeArtifactPreview}
      />
      <div
        ref={dialog}
        hidden={suspended}
        style={suspended ? { display: 'none' } : undefined}
        role="dialog"
        aria-labelledby={
          workActive
            ? artifactWorkTabId
            : tabbed && selectedId
              ? artifactTabIds(selectedId).title
              : 'artifact-preview-title'
        }
        aria-owns={workActive ? work?.id : undefined}
        tabIndex={-1}
        class="artifact-preview-panel flex min-h-0 flex-col bg-surface focus:outline-none"
        onTouchStart={(event) => {
          touch.current = null;
          if (
            tabbed ||
            window.matchMedia('(min-width: 1120px)').matches ||
            event.touches.length !== 1
          )
            return;
          let node = event.target as HTMLElement | null;
          while (node && node !== dialog.current) {
            if (node.scrollTop > 0 || node.closest('input, textarea, select')) return;
            node = node.parentElement;
          }
          touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        }}
        onTouchMove={(event) => {
          const start = touch.current;
          const current = event.touches[0];
          if (
            start &&
            current &&
            current.clientY - start.y > 10 &&
            current.clientY - start.y > Math.abs(current.clientX - start.x) * 1.5
          )
            event.preventDefault();
        }}
        onTouchEnd={(event) => {
          const start = touch.current;
          touch.current = null;
          const end = event.changedTouches[0];
          if (
            start &&
            end &&
            end.clientY - start.y > 80 &&
            end.clientY - start.y > Math.abs(end.clientX - start.x) * 1.5
          )
            closeArtifactPreview();
        }}
        onTouchCancel={() => {
          touch.current = null;
        }}
      >
        <div class="artifact-preview-handle" aria-hidden="true">
          <span />
        </div>
        <button
          type="button"
          aria-label={t('artifact.close')}
          onClick={closeArtifactPreview}
          class="absolute right-1 top-1 z-10 h-11 w-11 rounded-md text-fg-muted hover:bg-fill-soft hover:text-fg"
        >
          ×
        </button>
        {tabbed && expansion && (
          <button
            type="button"
            aria-label={t(expansion.expanded ? 'artifact.restore' : 'artifact.expand')}
            title={t(expansion.expanded ? 'artifact.restore' : 'artifact.expand')}
            aria-pressed={expansion.expanded}
            onClick={expansion.toggle}
            class="absolute right-12 top-1 z-10 flex h-11 w-11 items-center justify-center rounded-full text-fg-muted hover:bg-fill-soft hover:text-fg"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d={
                  expansion.expanded
                    ? 'M3 9h6V3M9 9 3 3m18 12h-6v6m0-6 6 6'
                    : 'M9 3H3v6M3 3l6 6m6 12h6v-6m0 6-6-6'
                }
              />
            </svg>
          </button>
        )}
        {tabbed && (selectedId || workActive || showWork) && (
          <div class={`flex shrink-0 px-3 py-3 ${expansion ? 'pr-24' : 'pr-14'}`}>
            <ArtifactPreviewTabs
              files={selectedId || workActive ? files : []}
              selectedId={selectedId}
              work={
                showWork && work
                  ? { id: work.id, count: work.count, selected: workActive }
                  : undefined
              }
            />
          </div>
        )}
        {tabbed &&
          files.map((file) => (
            <div
              key={file.artifactId}
              id={artifactTabIds(file.artifactId).panel}
              role="tabpanel"
              hidden={file.artifactId !== selectedId}
              aria-labelledby={artifactTabIds(file.artifactId).tab}
              class={file.artifactId === selectedId ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
            >
              <ArtifactPreview
                artifactId={file.artifactId}
                onBack={backArtifactPreview}
                markdownClass={markdownClass}
                titleId={artifactTabIds(file.artifactId).title}
                onMetadata={rememberMetadata}
              />
            </div>
          ))}
        {!tabbed && top?.kind === 'artifact' ? (
          <ArtifactPreview
            key={stack.length}
            artifactId={top.artifactId}
            onBack={backArtifactPreview}
            markdownClass={markdownClass}
          />
        ) : top?.kind === 'reference' ? (
          <ReferenceView
            key={stack.length}
            target={top}
            resolved={resolved.current}
            markdownClass={markdownClass}
          />
        ) : null}
      </div>
    </>
  );
}
