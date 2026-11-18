import { exchangeGoogleCode } from './google-token-exchange.ts';
import { startLoopbackLogin } from './loopback-login.ts';

const SCOPES = [
  'openid',
  'email',
  ...[
    'gmail.readonly',
    'gmail.compose',
    'calendar.calendarlist.readonly',
    'calendar.events.readonly',
  ].map((scope) => `https://www.googleapis.com/auth/${scope}`),
];
type Client = Parameters<typeof exchangeGoogleCode>[4];

export async function startGoogleLogin(
  client: Client,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
) {
  if (!client.clientId.trim()) throw new Error('Google Desktop client ID is required');
  return startLoopbackLogin({
    timeoutMs: options.timeoutMs,
    redirect: (port) => `http://127.0.0.1:${port}/oauth/google/callback`,
    exchange: (code, verifier, redirectUri, nonce, signal) =>
      exchangeGoogleCode(
        code,
        verifier,
        redirectUri,
        nonce,
        client,
        options.fetchImpl ?? fetch,
        signal
      ),
    authorize: (redirectUri, { state, nonce, challenge }) => {
      const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [name, value] of Object.entries({
        client_id: client.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      }))
        authorize.searchParams.set(name, value);
      return authorize;
    },
  });
}
