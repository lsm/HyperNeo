import { useCallback, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState, reconnectAttemptCount } from '../lib/state.ts';

export type BannerLevel = 'hidden' | 'reconnecting' | 'lost' | 'failed';

export function getBannerLevel(state: typeof connectionState.value, attempts: number): BannerLevel {
  if (state === 'connected') return 'hidden';
  if (state === 'connecting' && attempts === 0) return 'hidden';
  if (state === 'reconnecting' || state === 'connecting')
    return attempts <= 2 ? 'reconnecting' : 'lost';
  if (state === 'disconnected' || state === 'error') return 'lost';
  if (state === 'failed') return 'failed';
  return 'hidden';
}

export function ConnectionOverlay() {
  const state = connectionState.value;
  const attempts = reconnectAttemptCount.value;
  const [retrying, setRetrying] = useState(false);

  const level = getBannerLevel(state, attempts);

  const handleReconnect = useCallback(async () => {
    setRetrying(true);
    try {
      await connectionManager.reconnect();
    } catch {
    } finally {
      setRetrying(false);
    }
  }, []);

  if (level === 'hidden') return null;

  if (level === 'reconnecting') {
    return (
      <div class="fixed top-0 left-0 right-0 z-[9999] flex justify-center pointer-events-none">
        <div class="mt-2 px-4 py-2 rounded-lg bg-warning/90 text-black text-sm font-medium flex items-center gap-2 shadow-lg">
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Reconnecting…
        </div>
      </div>
    );
  }

  if (level === 'lost') {
    return (
      <div class="fixed top-0 left-0 right-0 z-[9999] flex justify-center pointer-events-none">
        <div class="mt-2 px-4 py-2 rounded-lg bg-warning/90 text-black text-sm font-medium flex items-center gap-2 shadow-lg">
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Connection lost. Retrying…
        </div>
      </div>
    );
  }

  return (
    <div class="fixed top-0 left-0 right-0 z-[9999] flex justify-center pointer-events-auto">
      <div class="mt-2 px-4 py-2 rounded-lg bg-danger/90 text-on-danger text-sm font-medium flex items-center gap-3 shadow-lg">
        <span>Unable to reconnect.</span>
        <button
          onClick={handleReconnect}
          disabled={retrying}
          class="px-3 py-1 rounded bg-white/20 hover:bg-white/30 text-accent-fg text-xs font-semibold transition-colors disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    </div>
  );
}
