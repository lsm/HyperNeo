import { borderColors } from '../lib/design-tokens';

export interface ErrorBannerAction {
  label: string;
  onClick: () => void;
}

export interface ErrorBannerProps {
  error: string;
  hasDetails?: boolean;
  onViewDetails?: () => void;
  onDismiss: () => void;
  actions?: ErrorBannerAction[];
}

export function ErrorBanner({
  error,
  hasDetails = false,
  onViewDetails,
  onDismiss,
  actions,
}: ErrorBannerProps) {
  return (
    <div
      data-testid="error-banner"
      class={`flex-shrink-0 bg-dark-900 border-t ${borderColors.special.toast.error} px-4 py-3`}
    >
      <div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center justify-between gap-4">
        <p class="text-sm text-red-400 flex-1">{error}</p>
        <div class="flex items-center gap-2">
          {actions?.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              class="text-xs px-3 py-1 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-300 hover:text-red-200 transition-colors border border-red-500/30"
            >
              {action.label}
            </button>
          ))}
          {hasDetails && onViewDetails && (
            <button
              onClick={onViewDetails}
              class="text-xs px-3 py-1 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-300 hover:text-red-200 transition-colors border border-red-500/30"
            >
              View Details
            </button>
          )}
          <button
            onClick={onDismiss}
            class="text-red-400 hover:text-red-300 transition-colors"
            aria-label="Dismiss error"
          >
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path
                fill-rule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
