import { useState } from 'preact/hooks';
import { Modal } from './ui/Modal.tsx';
import { Collapsible } from './ui/Collapsible.tsx';
import { Button } from './ui/Button.tsx';
import type { StructuredError, ErrorCategory } from '../types/error.ts';
import { cn } from '../lib/utils.ts';

export interface ErrorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  error: StructuredError | null;
  isDev?: boolean;
}

const ERROR_CATEGORY_COLORS: Record<ErrorCategory, string> = {
  authentication: 'bg-danger/10 text-danger-soft border-danger/30',
  connection: 'bg-warning/10 text-warning-soft border-orange-500/30',
  session: 'bg-warning/10 text-warning-soft border-warning/30',
  message: 'bg-accent/10 text-accent-soft border-accent/30',
  model: 'bg-cat-purple/10 text-cat-purple border-cat-purple/30',
  system: 'bg-fg-faint/10 text-fg-muted border-fg-faint/30',
  validation: 'bg-pink-500/10 text-cat-pink border-pink-500/30',
  timeout: 'bg-warning/10 text-warning-soft border-warning/30',
  permission: 'bg-danger/10 text-danger-soft border-danger/30',
  rate_limit: 'bg-warning/10 text-warning-soft border-orange-500/30',
  provider_auth_error: 'bg-danger/10 text-danger-soft border-danger/30',
  provider_unavailable: 'bg-warning/10 text-warning-soft border-orange-500/30',
};

const ERROR_CATEGORY_ICONS: Record<ErrorCategory, string> = {
  authentication: '🔐',
  connection: '🔌',
  session: '📋',
  message: '💬',
  model: '🤖',
  system: '⚙️',
  validation: '✓',
  timeout: '⏱️',
  permission: '🔒',
  rate_limit: '⏸️',
  provider_auth_error: '🔑',
  provider_unavailable: '🔌',
};

export function ErrorDialog({ isOpen, onClose, error, isDev: _isDev = false }: ErrorDialogProps) {
  const [copied, setCopied] = useState(false);

  if (!error) return null;

  const handleCopyReport = async () => {
    const report = formatErrorReport(error);
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const categoryColor =
    ERROR_CATEGORY_COLORS[error.category as ErrorCategory] || ERROR_CATEGORY_COLORS.system;
  const categoryIcon =
    ERROR_CATEGORY_ICONS[error.category as ErrorCategory] || ERROR_CATEGORY_ICONS.system;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Error Details" size="lg">
      <div class="space-y-4">
        <div class="flex items-center gap-3">
          <span class="text-2xl">{categoryIcon}</span>
          <div class="flex-1">
            <div
              class={cn(
                'inline-block px-3 py-1 rounded-full text-xs font-medium border',
                categoryColor
              )}
            >
              {error.category.toUpperCase()} ERROR
            </div>
            {error.code !== 'UNKNOWN' && (
              <span class="ml-2 text-xs text-fg-faint">Code: {error.code}</span>
            )}
          </div>
          <span class="text-xs text-fg-faint">
            {new Date(error.timestamp).toLocaleTimeString()}
          </span>
        </div>

        <div class="p-4 rounded-lg bg-surface-raised border border-line">
          <p class="text-fg">{error.userMessage}</p>
        </div>

        {error.recoverySuggestions && error.recoverySuggestions.length > 0 && (
          <div class={`p-4 rounded-lg bg-accent/5 border border-accent/20`}>
            <h3 class="text-sm font-semibold text-accent mb-2">💡 What you can try:</h3>
            <ul class="space-y-1.5">
              {error.recoverySuggestions.map((suggestion, idx) => (
                <li key={idx} class="text-sm text-fg-soft flex items-start gap-2">
                  <span class="text-accent mt-0.5">•</span>
                  <span>{suggestion}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Collapsible
          trigger={
            <div class="flex items-center gap-2 py-2 text-fg-muted hover:text-fg-soft">
              <span class="text-sm font-medium">Technical Details</span>
            </div>
          }
          class="border border-line rounded-lg px-4"
        >
          <div class="space-y-3 text-sm">
            <div>
              <dt class="font-medium text-fg-muted mb-1">Error Message:</dt>
              <dd class="text-fg-soft font-mono text-xs bg-surface p-2 rounded break-all">
                {error.message}
              </dd>
            </div>

            {error.sessionContext && (
              <div>
                <dt class="font-medium text-fg-muted mb-1">Session Context:</dt>
                <dd class="text-fg-soft space-y-1">
                  <div>
                    <span class="text-fg-faint">Session ID:</span>{' '}
                    <span class="font-mono text-xs">{error.sessionContext.sessionId}</span>
                  </div>
                  {error.sessionContext.processingState && (
                    <div>
                      <span class="text-fg-faint">Processing State:</span>{' '}
                      <span class="font-mono text-xs">
                        {error.sessionContext.processingState.status}
                        {error.sessionContext.processingState.phase && (
                          <> ({error.sessionContext.processingState.phase})</>
                        )}
                      </span>
                    </div>
                  )}
                </dd>
              </div>
            )}

            {error.metadata && Object.keys(error.metadata).length > 0 && (
              <div>
                <dt class="font-medium text-fg-muted mb-1">Additional Info:</dt>
                <dd class="text-fg-soft">
                  <pre class="text-xs bg-surface p-2 rounded overflow-x-auto">
                    {JSON.stringify(error.metadata, null, 2)}
                  </pre>
                </dd>
              </div>
            )}

            <div>
              <dt class="font-medium text-fg-muted mb-1">Recoverable:</dt>
              <dd class="text-fg-soft">
                {error.recoverable ? (
                  <span class="text-success">✓ Yes - you can retry</span>
                ) : (
                  <span class="text-danger">✗ No - requires manual fix</span>
                )}
              </dd>
            </div>

            {error.stack && (
              <div>
                <dt class="font-medium text-fg-muted mb-1">Stack Trace:</dt>
                <dd class="text-fg-soft">
                  <pre class="text-xs bg-surface p-3 rounded overflow-x-auto max-h-64 whitespace-pre-wrap break-words">
                    {error.stack}
                  </pre>
                </dd>
              </div>
            )}
          </div>
        </Collapsible>

        <div class="flex items-center justify-between pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCopyReport}
            class="flex items-center gap-2"
          >
            {copied ? (
              <>
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                Copy Error Report
              </>
            )}
          </Button>

          <Button variant="primary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function formatErrorReport(error: StructuredError): string {
  const lines = [
    '=== ERROR REPORT ===',
    '',
    `Category: ${error.category}`,
    `Code: ${error.code}`,
    `Timestamp: ${error.timestamp}`,
    `Recoverable: ${error.recoverable}`,
    '',
    'User Message:',
    error.userMessage,
    '',
    'Technical Message:',
    error.message,
    '',
  ];

  if (error.recoverySuggestions && error.recoverySuggestions.length > 0) {
    lines.push('Recovery Suggestions:');
    error.recoverySuggestions.forEach((suggestion) => {
      lines.push(`- ${suggestion}`);
    });
    lines.push('');
  }

  if (error.sessionContext) {
    lines.push('Session Context:');
    lines.push(`  Session ID: ${error.sessionContext.sessionId}`);
    if (error.sessionContext.processingState) {
      lines.push(`  Processing State: ${error.sessionContext.processingState.status}`);
      if (error.sessionContext.processingState.phase) {
        lines.push(`  Phase: ${error.sessionContext.processingState.phase}`);
      }
      if (error.sessionContext.processingState.messageId) {
        lines.push(`  Message ID: ${error.sessionContext.processingState.messageId}`);
      }
    }
    lines.push('');
  }

  if (error.metadata && Object.keys(error.metadata).length > 0) {
    lines.push('Metadata:');
    lines.push(JSON.stringify(error.metadata, null, 2));
    lines.push('');
  }

  if (error.stack) {
    lines.push('Stack Trace:');
    lines.push(error.stack);
    lines.push('');
  }

  return lines.join('\n');
}
