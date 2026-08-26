import { useEffect, useMemo, useRef } from 'preact/hooks';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { getProviderLabel } from '../../hooks/useModelSwitcher';
import { navigateToSettings } from '../../lib/router';
import { MinimalThreadFeed } from './thread/minimal/MinimalThreadFeed';
import { parseThreadRow } from './thread/space-task-thread-events';
import { RateLimitCooldownBanner } from '../sdk/RateLimitCooldownBanner';

export interface CooldownBannerMember {
  sessionId: string;
  label: string;
  retryCount: number;
  maxRetries: number;
  retryAt: number;
}

export interface AuthErrorBannerMember {
  sessionId: string;
  label: string;
  message: string;
  providerId?: string | null;
}

interface SpaceTaskUnifiedThreadProps {
  taskId: string;
  bottomInsetClass?: string;
  bottomScrollPaddingClass?: string;
  bottomInsetPx?: number;
  topInsetClass?: string;
  activeAgentLabels?: ReadonlySet<string>;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
  cooldownBannerMembers?: CooldownBannerMember[];
  authErrorBannerMembers?: AuthErrorBannerMember[];
  autoScrollEnabled?: boolean;
  onShowScrollButtonChange?: (showScrollButton: boolean) => void;
  onScrollToBottomChange?: (scrollToBottom: ((smooth?: boolean) => void) | null) => void;
  onScrollerChange?: (scroller: HTMLDivElement | null) => void;
}

export function SpaceTaskUnifiedThread({
  taskId,
  bottomInsetClass = 'pb-3',
  bottomScrollPaddingClass = 'scroll-pb-3',
  bottomInsetPx,
  topInsetClass = '',
  activeAgentLabels,
  overlayTaskId,
  overlayTaskReadonly,
  cooldownBannerMembers = [],
  authErrorBannerMembers = [],
  autoScrollEnabled = true,
  onShowScrollButtonChange,
  onScrollToBottomChange,
  onScrollerChange,
}: SpaceTaskUnifiedThreadProps) {
  const { rows, activeTurnSummaries, isLoading, error, isReconnecting } = useSpaceTaskMessages(
    taskId,
    'compact',
    20
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const parsedRows = useMemo(() => rows.map(parseThreadRow), [rows]);

  const newestRowKey = rows.length > 0 ? String(rows[rows.length - 1].id) : '';
  const newestRowRef = useRef<{ key: string; version: number }>({ key: '', version: 0 });
  if (newestRowRef.current.key !== newestRowKey) {
    newestRowRef.current = {
      key: newestRowKey,
      version: newestRowKey === '' ? 0 : newestRowRef.current.version + 1,
    };
  }
  const contentVersion = newestRowRef.current.version;

  const { showScrollButton, scrollToBottom } = useAutoScroll({
    containerRef,
    endRef: messagesEndRef,
    enabled: autoScrollEnabled,
    messageCount: isLoading || isReconnecting ? 0 : contentVersion,
    resetKey: taskId,
  });

  useEffect(() => {
    onShowScrollButtonChange?.(showScrollButton);
  }, [onShowScrollButtonChange, showScrollButton]);

  useEffect(() => {
    onScrollToBottomChange?.(scrollToBottom);
    return () => onScrollToBottomChange?.(null);
  }, [onScrollToBottomChange, scrollToBottom]);

  useEffect(() => {
    onScrollerChange?.(containerRef.current);
    return () => onScrollerChange?.(null);
  }, [onScrollerChange, parsedRows.length, isLoading, isReconnecting]);

  if (isReconnecting) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center text-sm text-gray-400">
          Reconnecting task thread…
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center text-sm text-gray-400">
          Loading task thread…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 text-center">
          <p class="text-sm text-amber-500">{error}</p>
        </div>
      </div>
    );
  }

  if (parsedRows.length === 0) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 text-center">
          <p class="text-sm text-gray-400">No task-agent activity yet.</p>
        </div>
      </div>
    );
  }

  const dynamicBottomInsetStyle =
    bottomInsetPx === undefined
      ? undefined
      : {
          paddingBottom: `${bottomInsetPx}px`,
          scrollPaddingBottom: `${bottomInsetPx}px`,
        };
  const bottomInsetClasses =
    bottomInsetPx === undefined ? `${bottomInsetClass} ${bottomScrollPaddingClass}` : '';

  const hasBanners = cooldownBannerMembers.length > 0 || authErrorBannerMembers.length > 0;

  return (
    <div class="h-full min-h-0 flex flex-col relative" data-testid="space-task-unified-thread">
      {hasBanners && (
        <div class="flex-shrink-0 px-4 pt-3 space-y-2" data-testid="space-task-thread-banner-stack">
          {cooldownBannerMembers.map((m) => (
            <div key={`cooldown-${m.sessionId}`} data-testid="space-thread-cooldown-banner">
              <div class="mb-1 text-[11px] font-medium uppercase tracking-wide text-amber-300/80">
                {m.label}
              </div>
              <RateLimitCooldownBanner
                sessionId={m.sessionId}
                retryCount={m.retryCount}
                maxRetries={m.maxRetries}
                retryAt={m.retryAt}
              />
            </div>
          ))}
          {authErrorBannerMembers.map((m) => (
            <ProviderAuthErrorBanner key={`auth-${m.sessionId}`} member={m} />
          ))}
        </div>
      )}
      <div
        ref={containerRef}
        class={`flex-1 overflow-y-auto ${topInsetClass} ${bottomInsetClasses}`}
        style={dynamicBottomInsetStyle}
      >
        <div class="min-h-[calc(100%+1px)]">
          <MinimalThreadFeed
            parsedRows={parsedRows}
            activeAgentLabels={activeAgentLabels}
            activeTurnSummaries={activeTurnSummaries}
            overlayTaskId={overlayTaskId}
            overlayTaskReadonly={overlayTaskReadonly}
          />
          <div ref={messagesEndRef} />
        </div>
      </div>
    </div>
  );
}

function ProviderAuthErrorBanner({ member }: { member: AuthErrorBannerMember }) {
  const providerLabel = member.providerId ? getProviderLabel(member.providerId) : 'Provider';
  return (
    <div
      class="flex items-center gap-2 px-3 py-2 rounded border bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100"
      data-testid="space-thread-auth-error-banner"
    >
      <svg
        class="w-3.5 h-3.5 shrink-0 text-red-600 dark:text-red-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"
        />
      </svg>
      <span class="text-xs flex-1 min-w-0">
        <span class="font-medium text-red-300/80 uppercase tracking-wide mr-1">{member.label}</span>
        <span class="break-words">
          {member.message || `${providerLabel} authentication failed.`}
        </span>
      </span>
      <button
        type="button"
        onClick={() => navigateToSettings('providers')}
        class="text-xs font-medium px-2 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white transition-colors shrink-0"
      >
        Re-authenticate {providerLabel}
      </button>
    </div>
  );
}
