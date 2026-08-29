import { connectionState } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager.ts';

export function DaemonStatusIndicator({ showLabel = false }: { showLabel?: boolean }) {
  const state = connectionState.value;

  let dotColor: string;
  let statusLabel: string;
  let displayLabel: string;
  let showPulse = false;

  switch (state) {
    case 'connected':
      dotColor = 'bg-success';
      statusLabel = 'Connection ready';
      displayLabel = '';
      showPulse = true;
      break;
    case 'connecting':
      dotColor = 'bg-warning';
      statusLabel = 'Connecting';
      displayLabel = 'Connecting';
      showPulse = true;
      break;
    case 'reconnecting':
      dotColor = 'bg-warning';
      statusLabel = 'Reconnecting';
      displayLabel = 'Reconnecting';
      showPulse = true;
      break;
    case 'disconnected':
      dotColor = 'bg-fg-faint';
      statusLabel = 'Connection offline';
      displayLabel = 'Offline';
      break;
    case 'error':
    case 'failed':
    default:
      dotColor = 'bg-danger';
      statusLabel = 'Connection error';
      displayLabel = 'Error';
      break;
  }

  const isConnected = state === 'connected';
  const canReconnect = state === 'disconnected' || state === 'error' || state === 'failed';
  const shouldShowLabel = showLabel && displayLabel !== '';

  const handleClick = () => {
    if (canReconnect) {
      connectionManager.reconnect();
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={!canReconnect}
      aria-label={statusLabel}
      aria-pressed={isConnected}
      class={`
					${shouldShowLabel ? 'h-9 px-2.5 gap-2' : 'h-9 w-9'}
					flex items-center justify-center rounded-lg text-sm text-fg-muted transition-colors
					${canReconnect ? 'cursor-pointer hover:bg-surface-raised' : 'cursor-default'}
			`}
      title={statusLabel}
    >
      <div class="relative flex items-center justify-center">
        <span class={`w-3 h-3 ${dotColor} rounded-full block`} />
        {showPulse && (
          <span
            class={`absolute inset-0 w-3 h-3 ${dotColor} rounded-full ${isConnected ? 'animate-ping opacity-75' : 'animate-pulse'}`}
          />
        )}
      </div>
      {shouldShowLabel && (
        <span class="hidden min-w-0 truncate text-xs sm:inline">{displayLabel}</span>
      )}
    </button>
  );
}
