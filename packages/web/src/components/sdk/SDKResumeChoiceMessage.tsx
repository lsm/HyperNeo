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
      <div class="flex items-start gap-2 px-3 py-2 mb-4 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 opacity-60">
        <svg
          class="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400 dark:text-gray-500"
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
        <p class="text-xs text-gray-500 dark:text-gray-400">
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
    <div class="flex flex-col gap-3 px-3 py-3 mb-4 rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10">
      <div class="flex items-start gap-2">
        <svg
          class="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
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
        <div class="flex-1 text-xs text-amber-900 dark:text-amber-100 space-y-1">
          <p class="font-semibold">Session transcript not found</p>
          <p class="text-amber-800 dark:text-amber-200">
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
                ? 'opacity-50 cursor-not-allowed bg-amber-600 border-amber-600 text-white'
                : 'bg-amber-600 hover:bg-amber-700 border-amber-600 hover:border-amber-700 text-white cursor-pointer'
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
                ? 'opacity-50 cursor-not-allowed border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500'
                : 'border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30 cursor-pointer'
            }
					`}
        >
          {loading === 'leave_as_is' ? 'Leaving as is…' : 'Leave as Is'}
        </button>
      </div>

      {error && <p class="ml-5 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
