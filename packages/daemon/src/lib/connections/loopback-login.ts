import { randomBytes, createHash } from 'node:crypto';
import { createHttpWsServer } from '../runtime-server/index.ts';

export type LoginOutcome =
  | {
      ok: true;
      accountId: string;
      email: string;
      tokens: { accessToken: string; refreshToken?: string; expiresAt: number; scopes: string[] };
    }
  | { ok: false; reason: string };
type Proof = { state: string; nonce: string; challenge: string };

export async function startLoopbackLogin(options: {
  redirect: (port: number) => string;
  authorize: (redirectUri: string, proof: Proof) => URL;
  exchange: (
    code: string,
    verifier: string,
    redirectUri: string,
    nonce: string,
    signal: AbortSignal
  ) => Promise<LoginOutcome>;
  timeoutMs?: number;
  serve?: typeof createHttpWsServer;
}) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const controller = new AbortController();
  let used = false;
  let settled = false;
  let complete!: (outcome: LoginOutcome) => void;
  const result = new Promise<LoginOutcome>((resolve) => {
    complete = resolve;
  });
  let timer: ReturnType<typeof setTimeout>;
  let redirectUri = '';
  const finish = (outcome: LoginOutcome) => {
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
  const server = await (options.serve ?? createHttpWsServer)({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeoutSeconds: 30,
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
        const outcome = await options.exchange(
          codes[0],
          verifier,
          redirectUri,
          nonce,
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
  redirectUri = options.redirect(server.port);
  timer = setTimeout(() => finish({ ok: false, reason: 'expired' }), options.timeoutMs ?? 300000);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return {
    authorizeUrl: options.authorize(redirectUri, { state, nonce, challenge }).toString(),
    result,
    cancel: () => finish({ ok: false, reason: 'cancelled' }),
  };
}
