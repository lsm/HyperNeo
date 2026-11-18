import { useEffect, useRef, useState } from 'preact/hooks';
import { retryClaudeDownload } from '../lib/api-helpers.ts';
import { t } from '../lib/i18n/index.ts';

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
  downloadFailure?: boolean;
}

export function ErrorBanner({
  error,
  hasDetails = false,
  onViewDetails,
  onDismiss,
  actions,
  downloadFailure = false,
}: ErrorBannerProps) {
  const [downloadError, setDownloadError] = useState(error);
  const [retrying, setRetrying] = useState(false);
  const pending = useRef(false);
  useEffect(() => setDownloadError(error), [error]);

  async function retryDownload() {
    if (pending.current) return;
    pending.current = true;
    setRetrying(true);
    try {
      const result = await retryClaudeDownload();
      if (result.accepted) onDismiss();
      else setDownloadError(result.reason);
    } catch {
      setDownloadError(t('download.retryFailed'));
    } finally {
      pending.current = false;
      setRetrying(false);
    }
  }

  const message = downloadFailure ? downloadMessage(downloadError) : error;
  return (
    <div
      data-testid="error-banner"
      class="flex-shrink-0 bg-surface border-t border-danger/20 px-4 py-3"
    >
      <div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center justify-between gap-4">
        <p class="text-sm text-danger flex-1">{message}</p>
        <div class="flex items-center gap-2">
          {downloadFailure && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => void retryDownload()}
              class="text-xs px-3 py-1 rounded-md bg-danger/20 hover:bg-danger/30 text-danger-soft transition-colors border border-danger/30 disabled:opacity-50"
            >
              {retrying ? t('download.retrying') : t('chat.retry')}
            </button>
          )}
          {actions?.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              class="text-xs px-3 py-1 rounded-md bg-danger/20 hover:bg-danger/30 text-danger-soft hover:text-danger-soft transition-colors border border-danger/30"
            >
              {action.label}
            </button>
          ))}
          {hasDetails && onViewDetails && (
            <button
              onClick={onViewDetails}
              class="text-xs px-3 py-1 rounded-md bg-danger/20 hover:bg-danger/30 text-danger-soft hover:text-danger-soft transition-colors border border-danger/30"
            >
              View Details
            </button>
          )}
          <button
            onClick={onDismiss}
            class="text-danger hover:text-danger-soft transition-colors"
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

function downloadMessage(message: string): string {
  if (message === "Can't download Claude Code: Cannot reach the npm registry.")
    return t('download.registryUnreachable');
  if (
    message ===
    "Can't download Claude Code: registry returned a web page, not package metadata (blocked by the network?)"
  )
    return t('download.registryMetadata');
  if (
    /^Can't download Claude Code: npm could not download the package(?: \(exit \d+\))?; check your npm registry and login$/.test(
      message
    )
  )
    return t('download.npmFailure');
  if (message === 'Claude Code is still downloading. Try again shortly.')
    return t('download.stillDownloading');
  return message;
}
