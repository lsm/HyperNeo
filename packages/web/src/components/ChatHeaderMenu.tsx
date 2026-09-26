import type { SessionFeatures } from '@hyperneo/shared';
import { connectionState } from '../lib/state';
import { Dropdown, type DropdownMenuItem } from './ui/Dropdown.tsx';
import { IconButton } from './ui/IconButton.tsx';

export interface ChatHeaderMenuProps {
  features: SessionFeatures;
  readonly: boolean;
  archived: boolean;
  archiving: boolean;
  resettingAgent: boolean;
  onToolsClick: () => void;
  onExportClick: () => void;
  onResetClick: () => void;
  onArchiveClick: () => void;
  onDeleteClick: () => void;
}

export function ChatHeaderMenu({
  features,
  readonly,
  archived,
  archiving,
  resettingAgent,
  onToolsClick,
  onExportClick,
  onResetClick,
  onArchiveClick,
  onDeleteClick,
}: ChatHeaderMenuProps) {
  const isConnected = connectionState.value === 'connected';
  const items: DropdownMenuItem[] = [];
  if (!readonly) {
    items.push({ label: 'Tools', title: 'Tools', onClick: onToolsClick, disabled: !isConnected });
  }
  items.push({
    label: 'Export chat',
    title: 'Export chat',
    onClick: onExportClick,
    disabled: !isConnected,
  });
  items.push({
    label: resettingAgent ? 'Resetting agent…' : 'Reset agent',
    title: 'Reset agent',
    onClick: onResetClick,
    disabled: resettingAgent || !isConnected,
  });
  if (features.archive) {
    items.push({ type: 'divider' });
    items.push({
      label: archiving ? 'Archiving…' : 'Archive chat',
      title: 'Archive chat',
      onClick: onArchiveClick,
      disabled: archiving || archived || !isConnected,
    });
    items.push({
      label: 'Delete chat',
      title: 'Delete chat',
      onClick: onDeleteClick,
      disabled: !isConnected,
      danger: true,
    });
  }

  return (
    <Dropdown
      position="right"
      items={items}
      trigger={
        <IconButton
          title="Chat actions"
          data-testid="chat-menu-btn"
          class="flex-shrink-0 text-fg-muted"
        >
          <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.75" />
            <circle cx="12" cy="12" r="1.75" />
            <circle cx="19" cy="12" r="1.75" />
          </svg>
        </IconButton>
      }
    />
  );
}
