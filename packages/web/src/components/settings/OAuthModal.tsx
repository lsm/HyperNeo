import { useEffect, useState } from 'preact/hooks';
import { Button } from '../ui/Button.tsx';

export interface OAuthFlowState {
  providerId: string;
  providerName: string;
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
}

interface OAuthModalProps {
  providerName: string;
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  onCancel: () => void;
  onComplete: () => void;
}

export function OAuthModal({
  providerName,
  authUrl,
  userCode,
  verificationUri,
  onCancel,
  onComplete: _onComplete,
}: OAuthModalProps) {
  const [copied, setCopied] = useState(false);
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
                  A browser window has been opened for you to authenticate with {providerName}.
                  Complete the authentication in that window.
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
