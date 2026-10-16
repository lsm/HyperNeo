import type { GitHubWatchedRepo } from './space-external-event-types.ts';
import { cn } from '../../lib/utils.ts';
import { formatTimestamp } from './space-external-event-values.ts';
import { FORM_CHECKBOX_CLASS } from '../ui/FormField';
import { Button } from '../ui/Button.tsx';

interface GitHubRepoRowProps {
  repo: GitHubWatchedRepo;
  disabled: boolean;
  webhookBusy: boolean;
  webhooksEnabled: boolean;
  pollingEnabled: boolean;
  onUpdate: (patch: Partial<GitHubWatchedRepo>) => Promise<void>;
  onAutoConfigureWebhook: () => Promise<void>;
  onCheckWebhook: () => Promise<void>;
  onRemove: () => Promise<void>;
}

export function GitHubRepoRow({
  repo,
  disabled,
  webhookBusy,
  webhooksEnabled,
  pollingEnabled,
  onUpdate,
  onAutoConfigureWebhook,
  onCheckWebhook,
  onRemove,
}: GitHubRepoRowProps) {
  return (
    <div class={cn('st-trow items-start', disabled && 'opacity-60')}>
      <div class="st-trow-body">
        <div class="truncate font-mono text-[13px] font-medium text-fg-soft">
          {repo.owner}/{repo.repo}
        </div>
        <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-muted">
          <span>secret {repo.webhookSecret ? 'configured' : 'missing'}</span>
          <WebhookStatus repo={repo} />
          <span>last webhook {formatTimestamp(repo.lastWebhookAt)}</span>
          <span>last poll {formatTimestamp(repo.lastPollAt)}</span>
        </div>
        <div class="mt-2 flex flex-wrap gap-4">
          <label class="flex items-center gap-2 text-xs text-fg-soft">
            <input
              type="checkbox"
              checked={repo.enabled}
              disabled={disabled}
              onChange={() => onUpdate({ enabled: !repo.enabled })}
              class={FORM_CHECKBOX_CLASS}
            />
            Enabled
          </label>
          <label class="flex items-center gap-2 text-xs text-fg-soft">
            <input
              type="checkbox"
              checked={repo.webhookEnabled}
              disabled={disabled}
              onChange={() => onUpdate({ webhookEnabled: !repo.webhookEnabled })}
              class={FORM_CHECKBOX_CLASS}
            />
            Webhooks
          </label>
          <label class="flex items-center gap-2 text-xs text-fg-soft">
            <input
              type="checkbox"
              checked={repo.pollingEnabled}
              disabled={disabled || !pollingEnabled}
              onChange={() => onUpdate({ pollingEnabled: !repo.pollingEnabled })}
              class={FORM_CHECKBOX_CLASS}
            />
            Polling
          </label>
        </div>
      </div>
      <span class="st-trow-acts">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={webhookBusy}
          disabled={disabled || webhookBusy || !webhooksEnabled}
          onClick={onAutoConfigureWebhook}
        >
          Auto-configure webhook
        </Button>
        {repo.webhookRemoteId && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={false}
            disabled={disabled || webhookBusy || !webhooksEnabled}
            onClick={onCheckWebhook}
          >
            Check webhook
          </Button>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          class="st-act st-act-danger disabled:cursor-not-allowed disabled:opacity-50"
        >
          Remove
        </button>
      </span>
    </div>
  );
}

function WebhookStatus({ repo }: { repo: GitHubWatchedRepo }) {
  if (!repo.webhookRemoteId) {
    return <span>webhook manual</span>;
  }
  if (repo.webhookActive === true) {
    return <span class="text-success-soft">webhook active</span>;
  }
  if (repo.webhookActive === false) {
    return <span class="text-danger-soft">webhook inactive</span>;
  }
  return <span>webhook status unknown</span>;
}
