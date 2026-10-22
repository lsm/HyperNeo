import type { GitHubTokenStatus } from './space-external-event-types.ts';
import { useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { FORM_CONTROL_CLASS, FORM_CHECKBOX_CLASS } from '../ui/FormField';
import { Button } from '../ui/Button.tsx';

interface GitHubConnectionCardProps {
  tokenStatus: GitHubTokenStatus | null;
  tokenStatusError: string | null;
  tokenStatusUnknown: boolean;
  tokenInput: string;
  onTokenInputChange: (value: string) => void;
  busy: boolean;
  disabled: boolean;
  pollingEnabled: boolean;
  pollingCapabilityDisabled: boolean;
  onSaveToken: () => Promise<void>;
  onClearToken: () => Promise<void>;
  onTogglePolling: (enabled: boolean) => Promise<void>;
}

export function GitHubConnectionCard({
  tokenStatus,
  tokenStatusError,
  tokenStatusUnknown,
  tokenInput,
  onTokenInputChange,
  busy,
  disabled,
  pollingEnabled,
  pollingCapabilityDisabled,
  onSaveToken,
  onClearToken,
  onTogglePolling,
}: GitHubConnectionCardProps) {
  const tokenInvalid = tokenStatus?.configured === true && Boolean(tokenStatus.error);
  const connected = tokenStatus?.configured === true && !tokenInvalid;
  const tokenWriteDisabled = busy || disabled || tokenStatusUnknown;
  const pollingDisabled = busy || disabled;
  const externalToken = tokenStatus?.source === 'env' || tokenStatus?.source === 'gh';
  const [replaceMode, setReplaceMode] = useState(false);
  const showInput = !connected || tokenInvalid || replaceMode;
  return (
    <div class="st-group" data-testid="github-connection-card">
      <div class="st-row">
        <div class="st-row-desc">
          Store a daemon-wide personal access token in the keychain for webhook auto-configure and
          authenticated polling. The token is shared by every space using the GitHub extension.
          Recommended scopes: <code class="text-fg-soft">repo</code>,{' '}
          <code class="text-fg-soft">admin:repo_hook</code>. Supported prefixes:{' '}
          <code class="text-fg-soft">ghp_</code>, <code class="text-fg-soft">github_pat_</code>,{' '}
          <code class="text-fg-soft">gho_</code>.
        </div>
      </div>

      {(connected || tokenInvalid) && (
        <div class="st-row" data-testid="github-token-status-row">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span
              class={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
                connected ? 'bg-success/10 text-success-soft' : 'bg-danger/10 text-danger-soft'
              )}
            >
              {connected ? 'Connected' : 'Token invalid'}
            </span>
            {tokenStatus?.login && (
              <span class="text-fg-soft">
                as <span class="font-mono">{tokenStatus.login}</span>
              </span>
            )}
            {tokenStatus?.source === 'env' && (
              <span class="text-fg-faint">(token from GH_TOKEN / GITHUB_TOKEN env)</span>
            )}
            {tokenStatus?.source === 'gh' && (
              <span class="text-fg-faint">(authenticated gh CLI)</span>
            )}
            {tokenInvalid && (
              <span class="text-danger-soft" data-testid="github-token-invalid-error">
                {tokenStatus?.error}
              </span>
            )}
          </div>
          <div class="st-trow-acts">
            {(connected || tokenInvalid) && !replaceMode && (
              <button
                type="button"
                onClick={() => setReplaceMode(true)}
                disabled={tokenWriteDisabled}
                class="st-act disabled:cursor-not-allowed disabled:opacity-50"
              >
                {connected
                  ? externalToken
                    ? 'Replace with keychain token'
                    : 'Replace token'
                  : 'Replace invalid token'}
              </button>
            )}
            <button
              type="button"
              onClick={onClearToken}
              disabled={tokenWriteDisabled || externalToken}
              class="st-act st-act-danger disabled:cursor-not-allowed disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {showInput && (
        <div class="st-row-stacked st-row space-y-2">
          <input
            type="password"
            value={tokenInput}
            onInput={(event) => onTokenInputChange((event.target as HTMLInputElement).value)}
            placeholder="ghp_…"
            disabled={tokenWriteDisabled}
            class={FORM_CONTROL_CLASS}
            aria-label="GitHub personal access token"
          />
          <div class="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={onSaveToken}
              disabled={tokenWriteDisabled || !tokenInput}
            >
              {connected ? 'Replace token' : 'Save token'}
            </Button>
            {(connected || tokenInvalid) && replaceMode && (
              <button
                type="button"
                onClick={() => setReplaceMode(false)}
                disabled={tokenWriteDisabled}
                class="text-xs text-fg-muted hover:text-fg-soft"
              >
                Cancel
              </button>
            )}
          </div>
          {!tokenStatus && !tokenStatusError && (
            <p class="text-xs text-fg-faint">Checking token status…</p>
          )}
          {tokenStatusError && (
            <p class="text-xs text-danger-soft" data-testid="github-token-status-error">
              Could not load token status: {tokenStatusError}
            </p>
          )}
        </div>
      )}

      <label class="st-trow cursor-pointer text-xs text-fg-soft">
        <span class="st-trow-body">
          <span class="st-trow-name text-xs font-medium">
            Polling for this space (daemon-wide capability)
          </span>
          {pollingCapabilityDisabled && (
            <span class="st-trow-desc">
              Polling capability is currently off daemon-wide — toggle to enable it.
            </span>
          )}
        </span>
        <input
          type="checkbox"
          checked={pollingEnabled}
          disabled={pollingDisabled}
          onChange={() => onTogglePolling(!pollingEnabled)}
          class={FORM_CHECKBOX_CLASS}
          aria-label="Enable GitHub polling for this space"
        />
      </label>
    </div>
  );
}
