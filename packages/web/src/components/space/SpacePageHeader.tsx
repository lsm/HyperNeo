import type { ComponentChildren } from 'preact';
import { MobileMenuButton } from '../ui/MobileMenuButton';

interface SpacePageHeaderProps {
  pageTitle: string;
  subtitle?: string;
  actions?: ComponentChildren;
}

export function SpacePageHeader({ pageTitle, subtitle, actions }: SpacePageHeaderProps) {
  return (
    <div
      data-tauri-drag-region
      class={
        subtitle
          ? 'relative z-10 flex min-h-[68px] flex-shrink-0 items-center bg-transparent px-4 py-3 sm:px-8'
          : 'relative z-10 flex h-[52px] flex-shrink-0 items-center bg-app-content px-4'
      }
    >
      <div class="flex min-w-0 flex-1 items-center gap-3" data-tauri-drag-region>
        <MobileMenuButton />
        <div class="min-w-0 flex-1" data-tauri-drag-region>
          <h2
            class={
              subtitle
                ? 'truncate text-xl font-semibold tracking-tight text-gray-50'
                : 'truncate text-sm font-semibold text-gray-100'
            }
            data-tauri-drag-region
          >
            {pageTitle}
          </h2>
          {subtitle && (
            <p class="mt-0.5 truncate text-sm text-gray-400" data-tauri-drag-region>
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div class="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
