import type { SDKRateLimitEvent as SDKRateLimitEventType } from '@neokai/shared/sdk/sdk.d.ts';

interface Props {
  message: SDKRateLimitEventType;
}

function formatResetTime(resetsAt: number): string {
  const date = new Date(resetsAt * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRateLimitType(type: string | undefined): string {
  if (!type) return 'Rate Limit';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function SDKRateLimitEvent({ message }: Props) {
  const info = message.rate_limit_info;
  const isRejected = info.status === 'rejected';
  const overageRejected = info.overageStatus === 'rejected';

  return (
    <div
      class={`flex items-start gap-2 px-3 py-2 mb-4 rounded border ${
        isRejected
          ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100'
          : 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100'
      }`}
    >
      <svg
        class={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isRejected ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
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
      <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
        <span>
          <span
            class={
              isRejected ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'
            }
          >
            Rate limit
          </span>{' '}
          <span class="font-medium">{formatRateLimitType(info.rateLimitType)}</span>
          {' — '}
          <span
            class={`${isRejected ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'} font-medium`}
          >
            {isRejected ? 'rejected' : 'allowed'}
          </span>
        </span>
        {info.resetsAt !== undefined && (
          <span
            class={
              isRejected
                ? 'text-red-700/80 dark:text-red-300/80'
                : 'text-amber-700/80 dark:text-amber-300/80'
            }
          >
            Resets at {formatResetTime(info.resetsAt)}
          </span>
        )}
        {overageRejected && info.overageDisabledReason && (
          <span
            class={
              isRejected
                ? 'text-red-700/80 dark:text-red-300/80'
                : 'text-amber-700/80 dark:text-amber-300/80'
            }
          >
            Overage disabled ({info.overageDisabledReason.replace(/_/g, ' ')})
          </span>
        )}
      </div>
    </div>
  );
}
