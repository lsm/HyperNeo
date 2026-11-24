import { useEffect, useRef, useState } from 'preact/hooks';
import { retryClaudeDownload } from '../lib/api-helpers.ts';
import { t } from '../lib/i18n/index.ts';
import { ChatErrorMessage, type ChatErrorDetails } from './ChatErrorMessage.tsx';

const DOWNLOAD_STILL_RUNNING = 'Claude Code is still downloading. Try again shortly.';

export interface ChatErrorRowAction {
  label: string;
  onClick: () => void;
}

export interface ChatErrorRowProps {
  error: string;
  hasDetails?: boolean;
  details?: ChatErrorDetails;
  onViewDetails?: () => void;
  onDismiss: () => void;
  actions?: ChatErrorRowAction[];
  downloadFailure?: boolean;
  alignEnd?: boolean;
}

export function ChatErrorRow({
  error,
  hasDetails = false,
  details,
  onViewDetails,
  onDismiss,
  actions,
  downloadFailure = false,
  alignEnd = false,
}: ChatErrorRowProps) {
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
    } catch (error) {
      setDownloadError(
        error instanceof Error &&
          /^Request timeout: operation\.invoke \(\d+ms\)$/.test(error.message)
          ? DOWNLOAD_STILL_RUNNING
          : t('download.retryFailed')
      );
    } finally {
      pending.current = false;
      setRetrying(false);
    }
  }

  const message = downloadFailure ? downloadMessage(downloadError) : error;
  return (
    <div
      data-testid="chat-error-row"
      class={`my-3 mr-4 w-fit max-w-[calc(100%-2rem)] rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 ${alignEnd ? 'ml-auto' : 'ml-4'}`}
    >
      <div role="alert" class="text-sm text-danger">
        <ChatErrorMessage message={message} details={downloadFailure ? undefined : details} />
      </div>
      <div class="mt-2 flex flex-wrap gap-2">
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
            type="button"
            onClick={action.onClick}
            class="text-xs px-3 py-1 rounded-md bg-danger/20 hover:bg-danger/30 text-danger-soft hover:text-danger-soft transition-colors border border-danger/30"
          >
            {action.label}
          </button>
        ))}
        {hasDetails && onViewDetails && (
          <button
            type="button"
            onClick={onViewDetails}
            class="text-xs px-3 py-1 rounded-md bg-danger/20 hover:bg-danger/30 text-danger-soft hover:text-danger-soft transition-colors border border-danger/30"
          >
            Details
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          class="rounded-md px-3 py-1 text-xs text-danger hover:bg-danger/10"
          aria-label="Dismiss error"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function downloadMessage(message: string): string {
  const registry = /^Can't download Claude Code: Cannot reach npm registry at (.+)\.$/.exec(
    message
  );
  if (registry) return t('download.registryUnreachable', { host: registry[1] });
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
  if (message === DOWNLOAD_STILL_RUNNING) return t('download.stillDownloading');
  return message;
}
