import { randomBytes, createHash } from 'node:crypto';
import { createHttpWsServer } from '../runtime-server/index.ts';
import { exchangeGoogleCode } from './google-token-exchange.ts';

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
type Success = Awaited<ReturnType<typeof exchangeGoogleCode>>;
type Outcome = Success | { ok: false; reason: 'expired' | 'cancelled' | 'login_failed' };

export async function startGoogleLogin(
  client: Client,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
) {
  if (!client.clientId.trim()) throw new Error('Google Desktop client ID is required');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const controller = new AbortController();
  let used = false;
  let settled = false;
  let complete!: (outcome: Outcome) => void;
  const result = new Promise<Outcome>((resolve) => {
    complete = resolve;
  });
  let timer: ReturnType<typeof setTimeout>;
  let redirectUri = '';
  const finish = (outcome: Outcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    controller.abort();
    server.stop(false);
    complete(outcome);
  };
  const answer = (status: number) =>
    new Response(
      status === 200
        ? 'Authorization received. Return to the app to finish connecting.'
        : 'Connection not completed. Return to the app.',
      {
        status,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'referrer-policy': 'no-referrer',
        },
      }
    );
  const server = await createHttpWsServer({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const expected = new URL(redirectUri);
      if (
        settled ||
        used ||
        request.method !== 'GET' ||
        url.origin !== expected.origin ||
        url.pathname !== expected.pathname ||
        request.headers.get('host') !== expected.host ||
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== state
      )
        return answer(400);
      if (url.searchParams.has('error')) {
        finish({ ok: false, reason: 'login_failed' });
        return answer(400);
      }
      const codes = url.searchParams.getAll('code');
      if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) return answer(400);
      used = true;
      try {
        const outcome = await exchangeGoogleCode(
          codes[0],
          verifier,
          redirectUri,
          nonce,
          client,
          options.fetchImpl ?? fetch,
          controller.signal
        );
        if (settled) return answer(400);
        finish(outcome);
        return answer(200);
      } catch {
        finish({ ok: false, reason: 'login_failed' });
        return answer(400);
      }
    },
  });
  if (server.port === 8399) {
    server.stop(true);
    throw new Error('Reserved callback port');
  }
  redirectUri = `http://127.0.0.1:${server.port}/oauth/google/callback`;
  timer = setTimeout(() => finish({ ok: false, reason: 'expired' }), options.timeoutMs ?? 300000);
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [name, value] of Object.entries({
    client_id: client.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    nonce,
  }))
    authorize.searchParams.set(name, value);
  return {
    authorizeUrl: authorize.toString(),
    result,
    cancel: () => finish({ ok: false, reason: 'cancelled' }),
  };
}
