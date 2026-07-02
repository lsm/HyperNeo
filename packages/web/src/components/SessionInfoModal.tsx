import type { Session } from '@hyperneo/shared';
import { normalizeThinkingLevel } from '@hyperneo/shared';
import { Modal } from './ui/Modal.tsx';
import { CopyButton } from './ui/CopyButton.tsx';
import { borderColors } from '../lib/design-tokens.ts';

interface SessionInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
}

interface InfoRowProps {
  label: string;
  value: string | undefined;
  copyLabel?: string;
}

function InfoRow({ label, value, copyLabel }: InfoRowProps) {
  if (!value) return null;

  return (
    <div class={`flex items-start gap-3 py-2 border-b ${borderColors.ui.default} last:border-b-0`}>
      <span class="text-gray-400 text-sm w-32 flex-shrink-0">{label}</span>
      <span class="flex-1 font-mono text-sm text-gray-200 break-all">{value}</span>
      <CopyButton text={value} label={copyLabel || `Copy ${label.toLowerCase()}`} />
    </div>
  );
}

interface InfoSectionProps {
  title: string;
  children: preact.ComponentChildren;
}

function InfoSection({ title, children }: InfoSectionProps) {
  return (
    <div class="mb-4">
      <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{title}</h3>
      <div class="space-y-1">{children}</div>
    </div>
  );
}

/**
 * Compute SDK project directory path from workspace path
 * SDK replaces both / and . with - (e.g., /.hyperneo/ -> --hyperneo-)
 */
function getSDKProjectDir(workspacePath: string | null): string | undefined {
  if (!workspacePath) return undefined;
  const projectKey = workspacePath.replace(/[/.]/g, '-');
  return `~/.claude/projects/${projectKey}`;
}

/**
 * Format a date string for display
 */
function formatDate(dateString: string | undefined): string | undefined {
  if (!dateString) return undefined;
  try {
    return new Date(dateString).toLocaleString();
  } catch {
    return dateString;
  }
}

/**
 * Format cost as USD
 */
function formatCost(cost: number | undefined): string | undefined {
  if (cost === undefined || cost === 0) return undefined;
  return `$${cost.toFixed(4)}`;
}

/**
 * Format token count with commas
 */
function formatTokens(tokens: number | undefined): string | undefined {
  if (tokens === undefined || tokens === 0) return undefined;
  return tokens.toLocaleString();
}

export function SessionInfoModal({ isOpen, onClose, session }: SessionInfoModalProps) {
  if (!session) return null;

  const sdkProjectDir = getSDKProjectDir(session.workspacePath);
  const { metadata, worktree, config } = session;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Session Info" size="lg">
      <div class="max-h-[70vh] overflow-y-auto">
        {/* Basic Info */}
        <InfoSection title="Basic">
          <InfoRow label="Session ID" value={session.id} />
          <InfoRow label="Title" value={session.title} />
          <InfoRow label="Status" value={session.status} />
          <InfoRow label="Created" value={formatDate(session.createdAt)} />
          <InfoRow label="Last Active" value={formatDate(session.lastActiveAt)} />
          {session.archivedAt && (
            <InfoRow label="Archived" value={formatDate(session.archivedAt)} />
          )}
        </InfoSection>

        {/* Workspace Info */}
        <InfoSection title="Workspace">
          <InfoRow label="Workspace Path" value={session.workspacePath ?? undefined} />
          <InfoRow label="SDK Folder" value={sdkProjectDir} />
          <InfoRow label="SDK Session ID" value={session.sdkSessionId} />
          {session.gitBranch && <InfoRow label="Git Branch" value={session.gitBranch} />}
        </InfoSection>

        {/* Worktree Info (if applicable) */}
        {worktree && (
          <InfoSection title="Worktree">
            <InfoRow label="Worktree Path" value={worktree.worktreePath} />
            <InfoRow label="Main Repo" value={worktree.mainRepoPath} />
            <InfoRow label="Branch" value={worktree.branch} />
          </InfoSection>
        )}

        {/* Model & Config */}
        <InfoSection title="Configuration">
          <InfoRow label="Model" value={config?.model} />
          <InfoRow label="Provider" value={config?.provider || 'anthropic'} />
          <InfoRow
            label="Thinking Level"
            value={normalizeThinkingLevel(config?.thinkingLevel) || 'off'}
          />
          <InfoRow label="Query Mode" value={config?.queryMode || 'immediate'} />
          <InfoRow label="Permission Mode" value={config?.permissionMode || 'default'} />
        </InfoSection>

        {/* Usage Statistics */}
        <InfoSection title="Usage">
          <InfoRow label="Messages" value={metadata?.messageCount?.toString()} />
          <InfoRow label="Total Tokens" value={formatTokens(metadata?.totalTokens)} />
          <InfoRow label="Input Tokens" value={formatTokens(metadata?.inputTokens)} />
          <InfoRow label="Output Tokens" value={formatTokens(metadata?.outputTokens)} />
          <InfoRow label="Tool Calls" value={metadata?.toolCallCount?.toString()} />
          <InfoRow label="Total Cost" value={formatCost(metadata?.totalCost)} />
        </InfoSection>

        {/* Internal Flags */}
        <InfoSection title="Internal">
          <InfoRow label="Title Generated" value={metadata?.titleGenerated ? 'Yes' : 'No'} />
          <InfoRow
            label="Workspace Initialized"
            value={metadata?.workspaceInitialized ? 'Yes' : 'No'}
          />
          {session.availableCommands && session.availableCommands.length > 0 && (
            <InfoRow label="Available Commands" value={session.availableCommands.join(', ')} />
          )}
        </InfoSection>
      </div>
    </Modal>
  );
}
