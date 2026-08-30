import { useId } from 'preact/hooks';
import type { SessionUnavailableKind } from '../lib/session-load-error';
import { describeUnavailable } from '../lib/session-load-error';
import { Button } from './ui/Button';

export interface UnavailableAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
  testId?: string;
  loading?: boolean;
}

interface UnavailableSessionViewProps {
  kind: SessionUnavailableKind;
  actions: UnavailableAction[];
  detail?: string;
}

function iconFor(kind: SessionUnavailableKind): string {
  switch (kind) {
    case 'archived':
      return '🗄️';
    case 'terminated':
      return '📭';
    case 'unauthorized':
      return '🔒';
    case 'disconnected':
    case 'timeout':
      return '🔌';
    default:
      return '🔍';
  }
}

export function UnavailableSessionView({ kind, actions, detail }: UnavailableSessionViewProps) {
  const { heading, detail: defaultDetail } = describeUnavailable(kind);
  const headingId = useId();
  const detailId = useId();
  return (
    <div
      class="flex-1 flex items-center justify-center bg-app-content overflow-auto"
      data-testid="session-unavailable-view"
      data-unavailable-kind={kind}
      role="alertdialog"
      aria-labelledby={headingId}
      aria-describedby={detailId}
    >
      <div class="max-w-sm text-center px-6 py-8">
        <div class="text-5xl mb-4" aria-hidden="true">
          {iconFor(kind)}
        </div>
        <h3 id={headingId} class="text-lg font-semibold text-fg mb-2">
          {heading}
        </h3>
        <p id={detailId} class="text-sm text-fg-muted mb-5">
          {detail ?? defaultDetail}
        </p>
        {actions.length > 0 && (
          <div class="flex flex-wrap items-center justify-center gap-2">
            {actions.map((action) => (
              <Button
                key={action.label}
                variant={action.variant ?? 'secondary'}
                onClick={action.onClick}
                loading={action.loading}
                data-testid={action.testId}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
