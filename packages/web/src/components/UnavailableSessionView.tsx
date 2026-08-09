/**
 * UnavailableSessionView — the single, explicit state shown when a session
 * cannot be shown as a live chat (task #873).
 *
 * Replaces the legacy collapsed "Failed to load session" screen with an
 * accurate, per-cause view. Used full-screen for cases where there is no
 * transcript to display:
 *  - `not-found` / `unauthorized`  → the session is confirmed gone/inaccessible
 *  - `disconnected` / `timeout` / `unknown` → transient/retryable load failure
 *
 * `archived` / `terminated` are NOT rendered here: those keep the transcript
 * readable with an inline banner (the session loaded, it is just no longer
 * active). See ChatContainer.
 *
 * Actions are supplied by the caller (ChatContainer) and are context-aware —
 * e.g. a long-horizon agent detail offers "Refresh agent record", an overlay
 * offers "Go back", every case offers "Try again".
 */

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
  /**
   * When true, the primary action is a retry that may succeed shortly (a
   * transient disconnected/timeout), so the view leans toward "Try again".
   * Hard-unavailable kinds lean toward "Go back" / contextual actions.
   */
  actions: UnavailableAction[];
  /** Optional extra detail line (e.g. the underlying error message in dev). */
  detail?: string;
}

// Icon per kind — a small visual cue that's distinct from the generic warning.
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
  return (
    <div
      class="flex-1 flex items-center justify-center bg-app-content overflow-auto"
      data-testid="session-unavailable-view"
      data-unavailable-kind={kind}
      // The whole view is the active surface — announce it so assistive tech
      // lands on the explanation + actions rather than silence.
      role="alertdialog"
      aria-labelledby="session-unavailable-heading"
      aria-describedby="session-unavailable-detail"
    >
      <div class="max-w-sm text-center px-6 py-8">
        <div class="text-5xl mb-4" aria-hidden="true">
          {iconFor(kind)}
        </div>
        <h3 id="session-unavailable-heading" class="text-lg font-semibold text-gray-100 mb-2">
          {heading}
        </h3>
        <p id="session-unavailable-detail" class="text-sm text-gray-400 mb-5">
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
