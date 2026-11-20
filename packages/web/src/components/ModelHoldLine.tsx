import { type ModelHold, modelHoldLine } from '@hyperneo/shared/types/model-hold';
import { navigateToSettings } from '../lib/router.ts';

export function ModelHoldLine({
  hold,
  class: className = '',
  onSignIn = () => navigateToSettings('providers'),
  signingIn = false,
}: {
  hold: ModelHold;
  class?: string;
  onSignIn?: () => void;
  signingIn?: boolean;
}) {
  const line = modelHoldLine(hold);
  return (
    <p data-model-hold={hold.reason} role="status" class={`text-xs text-warning ${className}`}>
      {line.text}
      {line.signIn && (
        <>
          {' · '}
          <button
            type="button"
            class="font-medium underline underline-offset-2 hover:text-warning-soft"
            onClick={onSignIn}
            disabled={signingIn}
          >
            Sign in
          </button>
        </>
      )}
    </p>
  );
}
