import type { ComponentChildren } from 'preact';
import { MobileMenuButton } from '../ui/MobileMenuButton';

interface SpacePageHeaderProps {
  pageTitle: string;
  subtitle?: string;
  appearance?: 'default' | 'hero';
  actions?: ComponentChildren;
}

export function SpacePageHeader({
  pageTitle,
  subtitle,
  appearance = 'default',
  actions,
}: SpacePageHeaderProps) {
  const prominent = subtitle || appearance === 'hero';
  return (
    <div
      data-tauri-drag-region
      class={
        prominent
          ? `relative z-10 flex flex-shrink-0 items-center bg-transparent px-4 sm:px-8 ${appearance === 'hero' ? 'min-h-[84px] pt-5 pb-2' : 'min-h-[68px] py-3'}`
          : 'relative z-10 flex h-[52px] flex-shrink-0 items-center bg-app-content px-4'
      }
    >
      <div class="flex min-w-0 flex-1 items-center gap-3" data-tauri-drag-region>
        <MobileMenuButton />
        <div class="min-w-0 flex-1" data-tauri-drag-region>
          <h2
            class={
              prominent
                ? `truncate font-semibold tracking-tight text-fg ${appearance === 'hero' ? 'text-3xl' : 'text-xl'}`
                : 'truncate text-sm font-semibold text-fg'
            }
            data-tauri-drag-region
          >
            {pageTitle}
          </h2>
          {subtitle && (
            <p class="mt-0.5 truncate text-sm text-fg-muted" data-tauri-drag-region>
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div class="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
