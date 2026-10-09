import type { ComponentChildren } from 'preact';
import { MobileMenuButton } from '../ui/MobileMenuButton';

interface SpacePageHeaderProps {
  pageTitle: string;
  actions?: ComponentChildren;
}

export function SpacePageHeader({ pageTitle, actions }: SpacePageHeaderProps) {
  return (
    <div
      data-tauri-drag-region
      data-testid="space-page-header"
      class="relative z-10 flex h-[52px] flex-shrink-0 items-center bg-app-content px-4"
    >
      <div class="flex min-w-0 flex-1 items-center gap-3" data-tauri-drag-region>
        <MobileMenuButton />
        <div class="min-w-0 flex-1" data-tauri-drag-region>
          <h2 class="truncate text-sm font-semibold text-fg" data-tauri-drag-region>
            {pageTitle}
          </h2>
        </div>
      </div>
      {actions && <div class="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
