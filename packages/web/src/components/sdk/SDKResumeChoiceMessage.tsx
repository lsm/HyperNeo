import { useState } from 'preact/hooks';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import { connectionManager } from '../../lib/connection-manager.ts';

interface Props {
  message: HyperNeoActionMessage;
  sessionId: string;
}

export function SDKResumeChoiceMessage({ message, sessionId }: Props) {
  const [loading, setLoading] = useState<'start_fresh' | 'leave_as_is' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (message.resolved && message.chosenOption) {
    const label = message.chosenOption === 'start_fresh' ? 'Start Fresh Session' : 'Leave as Is';
    return (
      <div class="flex items-start gap-2 px-3 py-2 mb-4 rounded border border-line bg-surface-raised opacity-60">
        <svg
          class="w-3.5 h-3.5 mt-0.5 shrink-0 text-fg-faint"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M5 13l4 4L19 7"
          />
        </svg>
        <p class="text-xs text-fg-muted">
          Session choice resolved: <span class="font-medium">{label}</span>
        </p>
      </div>
    );
  }

  async function handleChoice(choice: 'start_fresh' | 'leave_as_is') {
    setLoading(choice);
    setError(null);
    try {
      const hub = await connectionManager.getHub();
      await hub.request('session.sdkResumeChoice', {
        sessionId,
        choice,
        messageUuid: message.uuid,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(null);
    }
  }

  return (
    <div class="flex flex-col gap-3 px-3 py-3 mb-4 rounded border border-warning/40 bg-warning/10">
      <div class="flex items-start gap-2">
        <svg
          class="w-3.5 h-3.5 mt-0.5 shrink-0 text-warning"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <div class="flex-1 text-xs text-warning-soft space-y-1">
          <p class="font-semibold">Session transcript not found</p>
          <p class="text-warning-soft">
            The conversation history for this session could not be located. How would you like to
            proceed?
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2 ml-5">
        <button
          onClick={() => handleChoice('start_fresh')}
          disabled={loading !== null}
          class={`
						px-3 py-1.5 text-xs font-medium rounded border transition-colors
						${
              loading === 'start_fresh'
                ? 'opacity-50 cursor-not-allowed bg-warning border-warning text-on-warning'
                : 'bg-warning hover:bg-warning border-warning hover:border-warning text-on-warning cursor-pointer'
            }
					`}
        >
          {loading === 'start_fresh' ? 'Starting fresh…' : 'Start Fresh Session'}
        </button>
        <button
          onClick={() => handleChoice('leave_as_is')}
          disabled={loading !== null}
          class={`
						px-3 py-1.5 text-xs font-medium rounded border transition-colors
						${
              loading === 'leave_as_is'
                ? 'opacity-50 cursor-not-allowed border-line-strong text-fg-faint'
                : 'border-warning-soft text-warning-soft hover:bg-warning/15 dark:hover:bg-amber-900/30 cursor-pointer'
            }
					`}
        >
          {loading === 'leave_as_is' ? 'Leaving as is…' : 'Leave as Is'}
        </button>
      </div>

      {error && <p class="ml-5 text-xs text-danger">{error}</p>}
    </div>
  );
}
