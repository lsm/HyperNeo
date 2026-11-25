import type { ChatDisplayMode, SessionFeatures } from '@hyperneo/shared';
import { connectionState } from '../lib/state';
import { toast } from '../lib/toast';
import { copyToClipboard } from '../lib/utils.ts';
import { Dropdown, type DropdownMenuItem } from './ui/Dropdown.tsx';
import { IconButton } from './ui/IconButton.tsx';
import { GitBranchIcon } from './icons/GitBranchIcon.tsx';
import { ChatMenuGlyph, type ChatMenuGlyphName } from './icons/ChatMenuIcons.tsx';

const DISPLAY_MODES: Array<{ mode: ChatDisplayMode; label: string; icon: ChatMenuGlyphName }> = [
  { mode: 'full', label: 'Full view', icon: 'full' },
  { mode: 'compact', label: 'Compact view', icon: 'compact' },
  { mode: 'minimal', label: 'Minimal view', icon: 'minimal' },
];

const COPY_ICONS: Record<string, ChatMenuGlyphName> = {
  'Session ID': 'id',
  'Workspace path': 'folder',
};

export interface ChatHeaderCopyItem {
  label: string;
  value: string;
}

export interface ChatHeaderMenuProps {
  features: SessionFeatures;
  readonly: boolean;
  showTools?: boolean;
  archived: boolean;
  archiving: boolean;
  resettingAgent: boolean;
  onToolsClick: () => void;
  onExportClick: () => void;
  onResetClick: () => void;
  onArchiveClick: () => void;
  onDeleteClick: () => void;
  onMoveUnderClick?: () => void;
  onMoveToTopClick?: () => void;
  onRenameClick?: () => void;
  onSchedulesClick?: () => void;
  schedulesOpen?: boolean;
  copyItems?: ChatHeaderCopyItem[];
  displayMode?: ChatDisplayMode;
  onDisplayModeChange?: (mode: ChatDisplayMode) => void;
}

function copyValue(label: string, value: string) {
  void copyToClipboard(value).then((ok) => {
    if (ok) toast.success(`${label} copied`);
    else toast.error(`Failed to copy ${label.toLowerCase()}`);
  });
}

export function ChatHeaderMenu({
  features,
  readonly,
  showTools = true,
  archived,
  archiving,
  resettingAgent,
  onToolsClick,
  onExportClick,
  onResetClick,
  onArchiveClick,
  onDeleteClick,
  onMoveUnderClick,
  onMoveToTopClick,
  onRenameClick,
  onSchedulesClick,
  schedulesOpen = false,
  copyItems = [],
  displayMode,
  onDisplayModeChange,
}: ChatHeaderMenuProps) {
  const isConnected = connectionState.value === 'connected';

  const viewItems: DropdownMenuItem[] =
    displayMode && onDisplayModeChange
      ? DISPLAY_MODES.map(({ mode, label, icon }) => ({
          label,
          title: label,
          icon: <ChatMenuGlyph name={icon} />,
          trailing: mode === displayMode ? <ChatMenuGlyph name="check" /> : undefined,
          onClick: () => onDisplayModeChange(mode),
        }))
      : [];

  const schedulesItems: DropdownMenuItem[] = onSchedulesClick
    ? [
        {
          label: 'Schedules',
          title: 'Schedules',
          icon: <ChatMenuGlyph name="schedules" />,
          trailing: schedulesOpen ? <ChatMenuGlyph name="check" /> : undefined,
          onClick: onSchedulesClick,
        },
      ]
    : [];

  const editItems: DropdownMenuItem[] = [];
  if (onRenameClick)
    editItems.push({
      label: 'Rename',
      title: 'Rename conversation',
      icon: <ChatMenuGlyph name="rename" />,
      onClick: onRenameClick,
      disabled: !isConnected,
    });
  if (onMoveUnderClick)
    editItems.push({
      label: 'Move under…',
      title: 'Move under another chat',
      icon: <ChatMenuGlyph name="moveUnder" />,
      onClick: onMoveUnderClick,
      disabled: !isConnected,
    });
  if (onMoveToTopClick)
    editItems.push({
      label: 'Move to top level',
      title: 'Move to top level',
      icon: <ChatMenuGlyph name="moveTop" />,
      onClick: onMoveToTopClick,
      disabled: !isConnected,
    });
  editItems.push({
    label: 'Export chat',
    title: 'Export chat',
    icon: <ChatMenuGlyph name="export" />,
    onClick: onExportClick,
    disabled: !isConnected,
  });

  const copyMenuItems: DropdownMenuItem[] = copyItems.map(({ label, value }) => ({
    label,
    title: `Copy ${label.toLowerCase()}`,
    icon: COPY_ICONS[label] ? (
      <ChatMenuGlyph name={COPY_ICONS[label]} />
    ) : (
      <GitBranchIcon className="h-4 w-4" />
    ),
    trailing: <ChatMenuGlyph name="copy" />,
    onClick: () => copyValue(label, value),
  }));

  const toolItems: DropdownMenuItem[] =
    !readonly && showTools
      ? [
          {
            label: 'Tools',
            title: 'Tools',
            icon: <ChatMenuGlyph name="tools" />,
            onClick: onToolsClick,
            disabled: !isConnected,
          },
        ]
      : [];

  const dangerItems: DropdownMenuItem[] = [
    {
      label: resettingAgent ? 'Resetting agent…' : 'Reset agent',
      title: 'Reset agent',
      icon: <ChatMenuGlyph name="reset" />,
      onClick: onResetClick,
      disabled: resettingAgent || !isConnected,
    },
  ];
  if (features.archive) {
    dangerItems.push({
      label: archiving ? 'Archiving…' : 'Archive chat',
      title: 'Archive chat',
      icon: <ChatMenuGlyph name="archive" />,
      onClick: onArchiveClick,
      disabled: archiving || archived || !isConnected,
    });
    dangerItems.push({
      label: 'Delete chat',
      title: 'Delete chat',
      icon: <ChatMenuGlyph name="trash" />,
      onClick: onDeleteClick,
      disabled: !isConnected,
      danger: true,
    });
  }

  const items: DropdownMenuItem[] = [];
  for (const group of [
    viewItems,
    schedulesItems,
    editItems,
    copyMenuItems,
    toolItems,
    dangerItems,
  ]) {
    if (group.length === 0) continue;
    if (items.length > 0) items.push({ type: 'divider' });
    items.push(...group);
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
