import type { SDKRateLimitEvent as SDKRateLimitEventType } from '@hyperneo/shared/sdk/sdk.d.ts';

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
          ? 'bg-danger/10 border-danger/40 text-danger-soft'
          : 'bg-warning/10 border-warning/40 text-warning-soft'
      }`}
    >
      <svg
        class={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isRejected ? 'text-danger' : 'text-warning'}`}
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
          <span class={isRejected ? 'text-danger-soft' : 'text-warning'}>Rate limit</span>{' '}
          <span class="font-medium">{formatRateLimitType(info.rateLimitType)}</span>
          {' — '}
          <span class={`${isRejected ? 'text-danger-soft' : 'text-warning'} font-medium`}>
            {isRejected ? 'rejected' : 'allowed'}
          </span>
        </span>
        {info.resetsAt !== undefined && (
          <span class={isRejected ? 'text-danger-soft/80' : 'text-warning/80'}>
            Resets at {formatResetTime(info.resetsAt)}
          </span>
        )}
        {overageRejected && info.overageDisabledReason && (
          <span class={isRejected ? 'text-danger-soft/80' : 'text-warning/80'}>
            Overage disabled ({info.overageDisabledReason.replace(/_/g, ' ')})
          </span>
        )}
      </div>
    </div>
  );
}
