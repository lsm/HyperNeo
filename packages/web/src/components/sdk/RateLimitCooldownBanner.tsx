import { useCallback, useEffect, useState } from 'preact/hooks';
import { useVisibleTick } from '../../hooks/useVisibleTick.ts';
import { cancelRateLimitRetry, retryNowAfterRateLimit } from '../../lib/api-helpers.ts';

interface Props {
  sessionId: string;
  retryCount: number;
  maxRetries: number;
  retryAt: number;
}

export function RateLimitCooldownBanner({ sessionId, retryCount, maxRetries, retryAt }: Props) {
  const [remaining, setRemaining] = useState(Math.max(0, retryAt - Date.now()));
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    setRemaining(Math.max(0, retryAt - Date.now()));
  }, [retryAt]);

  useVisibleTick(1000, remaining > 0, () => setRemaining(Math.max(0, retryAt - Date.now())));

  const formatCountdown = (ms: number): string => {
    if (ms <= 0) return 'now';
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${seconds}s`;
  };

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await cancelRateLimitRetry(sessionId);
    } catch {
    } finally {
      setCancelling(false);
    }
  }, [sessionId]);

  const handleRetryNow = useCallback(async () => {
    setRetrying(true);
    try {
      await retryNowAfterRateLimit(sessionId);
    } catch {
    } finally {
      setRetrying(false);
    }
  }, [sessionId]);

  return (
    <div class="flex items-center gap-2 px-3 py-2 mb-2 rounded border bg-warning/10 border-warning/40 text-warning-soft">
      <svg
        class="w-3.5 h-3.5 shrink-0 text-warning"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <span class="text-xs flex-1">
        <span class="font-medium">Rate limit reached.</span> Auto-retry in{' '}
        <span class="font-mono font-medium">{formatCountdown(remaining)}</span>{' '}
        <span class="text-warning/60">
          (attempt {retryCount}/{maxRetries})
        </span>
      </span>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleRetryNow}
          disabled={retrying}
          class="text-xs font-medium px-2 py-0.5 rounded bg-warning hover:bg-warning text-accent-fg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {retrying ? 'Retrying…' : 'Retry Now'}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={cancelling}
          class="text-xs font-medium px-2 py-0.5 rounded bg-transparent hover:bg-warning/15 dark:hover:bg-amber-900/30 text-warning border border-warning-soft disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
