import { useState } from 'preact/hooks';
import { Modal } from './ui/Modal.tsx';
import { Collapsible } from './ui/Collapsible.tsx';
import { Button } from './ui/Button.tsx';
import type { StructuredError, ErrorCategory } from '../types/error.ts';
import { cn } from '../lib/utils.ts';
import { borderColors } from '../lib/design-tokens.ts';

export interface ErrorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  error: StructuredError | null;
  isDev?: boolean;
}

const ERROR_CATEGORY_COLORS: Record<ErrorCategory, string> = {
  authentication: 'bg-red-500/10 text-red-400 border-red-500/30',
  connection: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  session: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  message: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  model: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  system: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
  validation: 'bg-pink-500/10 text-pink-400 border-pink-500/30',
  timeout: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  permission: 'bg-red-500/10 text-red-400 border-red-500/30',
  rate_limit: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  provider_auth_error: 'bg-red-500/10 text-red-400 border-red-500/30',
  provider_unavailable: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
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
    } catch {
      // Clipboard copy failed - user can still copy manually
    }
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
              <span class="ml-2 text-xs text-gray-500">Code: {error.code}</span>
            )}
          </div>
          <span class="text-xs text-gray-500">
            {new Date(error.timestamp).toLocaleTimeString()}
          </span>
        </div>

        <div class={`p-4 rounded-lg bg-dark-800 border ${borderColors.ui.default}`}>
          <p class="text-gray-100">{error.userMessage}</p>
        </div>

        {error.recoverySuggestions && error.recoverySuggestions.length > 0 && (
          <div class={`p-4 rounded-lg bg-blue-500/5 border border-blue-500/20`}>
            <h3 class="text-sm font-semibold text-blue-400 mb-2">💡 What you can try:</h3>
            <ul class="space-y-1.5">
              {error.recoverySuggestions.map((suggestion, idx) => (
                <li key={idx} class="text-sm text-gray-300 flex items-start gap-2">
                  <span class="text-blue-400 mt-0.5">•</span>
                  <span>{suggestion}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Collapsible
          trigger={
            <div class="flex items-center gap-2 py-2 text-gray-400 hover:text-gray-300">
              <span class="text-sm font-medium">Technical Details</span>
            </div>
          }
          class={`border ${borderColors.ui.default} rounded-lg px-4`}
        >
          <div class="space-y-3 text-sm">
            <div>
              <dt class="font-medium text-gray-400 mb-1">Error Message:</dt>
              <dd class="text-gray-300 font-mono text-xs bg-dark-900 p-2 rounded break-all">
                {error.message}
              </dd>
            </div>

            {error.sessionContext && (
              <div>
                <dt class="font-medium text-gray-400 mb-1">Session Context:</dt>
                <dd class="text-gray-300 space-y-1">
                  <div>
                    <span class="text-gray-500">Session ID:</span>{' '}
                    <span class="font-mono text-xs">{error.sessionContext.sessionId}</span>
                  </div>
                  {error.sessionContext.processingState && (
                    <div>
                      <span class="text-gray-500">Processing State:</span>{' '}
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
                <dt class="font-medium text-gray-400 mb-1">Additional Info:</dt>
                <dd class="text-gray-300">
                  <pre class="text-xs bg-dark-900 p-2 rounded overflow-x-auto">
                    {JSON.stringify(error.metadata, null, 2)}
                  </pre>
                </dd>
              </div>
            )}

            <div>
              <dt class="font-medium text-gray-400 mb-1">Recoverable:</dt>
              <dd class="text-gray-300">
                {error.recoverable ? (
                  <span class="text-green-400">✓ Yes - you can retry</span>
                ) : (
                  <span class="text-red-400">✗ No - requires manual fix</span>
                )}
              </dd>
            </div>

            {error.stack && (
              <div>
                <dt class="font-medium text-gray-400 mb-1">Stack Trace:</dt>
                <dd class="text-gray-300">
                  <pre class="text-xs bg-dark-900 p-3 rounded overflow-x-auto max-h-64 whitespace-pre-wrap break-words">
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
