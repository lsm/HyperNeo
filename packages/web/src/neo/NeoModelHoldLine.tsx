import type { ModelHold } from '@hyperneo/shared/types/model-hold';
import { useState } from 'preact/hooks';
import { ModelHoldLine } from '../components/ModelHoldLine.tsx';
import { OAuthModal, type OAuthFlowState } from '../components/settings/OAuthModal.tsx';
import { loginProvider, submitProviderCallback } from '../lib/api-helpers.ts';

export function NeoModelHoldLine({ hold, class: className }: { hold: ModelHold; class?: string }) {
  const [flow, setFlow] = useState<OAuthFlowState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await loginProvider(hold.provider);
      if (!response.success) throw new Error(response.error || 'Failed to start login');
      setFlow({
        ...response,
        providerId: hold.provider,
        providerName: hold.provider === 'anthropic' ? 'Claude' : hold.provider,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <ModelHoldLine
        hold={hold}
        class={className}
        onSignIn={() => void signIn()}
        signingIn={pending}
      />
      {error && (
        <p role="alert" class="pointer-events-auto text-center text-xs text-danger-soft">
          {error}
        </p>
      )}
      {flow && (
        <OAuthModal
          providerName={flow.providerName}
          authUrl={flow.authUrl}
          userCode={flow.userCode}
          verificationUri={flow.verificationUri}
          onCancel={() => setFlow(null)}
          onComplete={() => setFlow(null)}
          onSubmitCallback={
            flow.providerId === 'anthropic'
              ? (input) => submitProviderCallback(flow.providerId, input)
              : undefined
          }
        />
      )}
    </>
  );
}
