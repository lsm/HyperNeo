import { useEffect, useState } from 'preact/hooks';
import { Button } from '../ui/Button.tsx';

export interface OAuthFlowState {
  providerId: string;
  providerName: string;
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  authSignature?: string;
}

interface OAuthModalProps {
  providerName: string;
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  onCancel: () => void;
  onComplete: () => void;
  onSubmitCallback?: (input: string) => Promise<{ success: boolean; error?: string }>;
}

export function OAuthModal({
  providerName,
  authUrl,
  userCode,
  verificationUri,
  onCancel,
  onComplete: _onComplete,
  onSubmitCallback,
}: OAuthModalProps) {
  const [copied, setCopied] = useState(false);
  const [callbackInput, setCallbackInput] = useState('');
  const [callbackSubmitting, setCallbackSubmitting] = useState(false);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const isDeviceFlow = !!userCode && !!verificationUri;
  const isRedirectFlow = !!authUrl;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const copyUserCode = async () => {
    if (userCode) {
      try {
        await navigator.clipboard.writeText(userCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {}
    }
  };

  const openVerificationUrl = () => {
    if (verificationUri) {
      window.open(verificationUri, '_blank');
    }
  };

  const openAuthUrl = () => {
    if (authUrl) {
      window.open(authUrl, '_blank');
    }
  };

  const submitCallback = async () => {
    if (!onSubmitCallback || !callbackInput.trim() || callbackSubmitting) return;
    setCallbackSubmitting(true);
    setCallbackError(null);
    try {
      const response = await onSubmitCallback(callbackInput.trim());
      if (!response.success) {
        setCallbackError(response.error || 'Callback relay failed');
      }
    } catch (err) {
      setCallbackError(err instanceof Error ? err.message : 'Callback relay failed');
    } finally {
      setCallbackSubmitting(false);
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-scrim backdrop-blur-sm cursor-pointer" onClick={onCancel} />

      <div class="relative bg-surface border border-line rounded-xl shadow-2xl max-w-md w-full mx-4 p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-fg">Authenticate with {providerName}</h3>
          <button onClick={onCancel} class="text-fg-muted hover:text-fg-soft transition-colors">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div class="space-y-4">
          {isDeviceFlow && (
            <>
              <div class="text-sm text-fg-soft">
                <p class="mb-3">Enter this code when prompted at the verification URL:</p>

                <div class="bg-surface-raised border border-line rounded-lg p-4 text-center mb-4">
                  <code class="text-2xl font-mono text-accent tracking-wider">{userCode}</code>
                </div>

                <div class="flex justify-center mb-4">
                  <Button variant="secondary" size="sm" onClick={copyUserCode}>
                    {copied ? (
                      <>
                        <svg
                          class="w-4 h-4 mr-1.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
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
                        <svg
                          class="w-4 h-4 mr-1.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width={2}
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                          />
                        </svg>
                        Copy Code
                      </>
                    )}
                  </Button>
                </div>

                <div class="text-center">
                  <p class="text-fg-muted text-sm mb-2">Verification URL:</p>
                  <a
                    href={verificationUri}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-accent hover:text-accent-soft underline break-all text-sm"
                  >
                    {verificationUri}
                  </a>
                </div>

                <div class="flex justify-center mt-4">
                  <Button variant="primary" size="sm" onClick={openVerificationUrl}>
                    <svg
                      class="w-4 h-4 mr-1.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                    Open Verification URL
                  </Button>
                </div>
              </div>
            </>
          )}

          {isRedirectFlow && !isDeviceFlow && (
            <>
              <div class="text-sm text-fg-soft">
                <p class="mb-4">
                  Authorize with {providerName} in the browser tab that opened. When the page shows
                  your authorization code, paste it below to finish.
                </p>

                <div class="flex justify-center">
                  <Button variant="primary" size="sm" onClick={openAuthUrl}>
                    <svg
                      class="w-4 h-4 mr-1.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                    Open Auth URL
                  </Button>
                </div>
              </div>

              {onSubmitCallback && (
                <div class="border-t border-line pt-3">
                  <label
                    for={`oauth-callback-${providerName}`}
                    class="block text-xs uppercase tracking-wider text-fg-muted mb-2"
                  >
                    Authorization code
                  </label>
                  <div class="flex gap-2">
                    <input
                      id={`oauth-callback-${providerName}`}
                      type="text"
                      placeholder="Paste the code shown after authorizing"
                      value={callbackInput}
                      disabled={callbackSubmitting}
                      onInput={(e) => setCallbackInput(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void submitCallback();
                        }
                      }}
                      class="flex-1 min-w-0 bg-bg border border-line rounded px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-accent font-mono"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void submitCallback()}
                      loading={callbackSubmitting}
                      disabled={callbackSubmitting || !callbackInput.trim()}
                    >
                      Submit
                    </Button>
                  </div>
                  {callbackError && (
                    <p class="text-xs text-danger-soft mt-2 break-words">{callbackError}</p>
                  )}
                </div>
              )}
            </>
          )}

          <div class="flex items-center justify-center py-4">
            <div class="animate-spin rounded-full h-5 w-5 border-b-2 border-accent mr-3" />
            <span class="text-sm text-fg-muted">Waiting for authentication...</span>
          </div>
        </div>

        <div class="mt-6 pt-4 border-t border-line flex justify-end">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
