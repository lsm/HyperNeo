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
      class="relative z-10 flex h-[52px] flex-shrink-0 items-center bg-app-content px-4"
    >
      <div class="flex-1 flex items-center gap-3" data-tauri-drag-region>
        <MobileMenuButton />
        <h2
          class="min-w-0 flex-1 truncate text-sm font-semibold text-gray-100"
          data-tauri-drag-region
        >
          {pageTitle}
        </h2>
      </div>
      {actions && <div class="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
}
