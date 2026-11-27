import { randomBytes, createHash } from 'node:crypto';
import {
  createHttpWsServer,
  type ServerHandle,
  type ServerOptions,
} from '../runtime-server/index.ts';

type FailedLogin = { ok: false; reason: string };
export type LoginOutcome =
  | {
      ok: true;
      accountId: string;
      email: string;
      tokens: { accessToken: string; refreshToken?: string; expiresAt: number; scopes: string[] };
    }
  | FailedLogin;
type Proof = { state: string; nonce: string; challenge: string };

export async function startLoopbackLogin<Success extends { ok: true }>(options: {
  redirect: (port: number) => string;
  authorize: (redirectUri: string, proof: Proof, signal: AbortSignal) => URL | Promise<URL>;
  exchange: (
    code: string,
    verifier: string,
    redirectUri: string,
    nonce: string,
    signal: AbortSignal
  ) => Promise<Success | FailedLogin>;
  timeoutMs?: number;
  serve?: typeof createHttpWsServer;
  signal?: AbortSignal;
}) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const controller = new AbortController();
  let used = false;
  let settled = false;
  let complete!: (outcome: Success | FailedLogin) => void;
  const result = new Promise<Success | FailedLogin>((resolve) => {
    complete = resolve;
  });
  let timer: ReturnType<typeof setTimeout>;
  let redirectUri = '';
  let ipv6: ServerHandle | undefined;
  const finish = (outcome: Success | FailedLogin) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.abort();
    server.stop(false);
    ipv6?.stop(false);
    complete(outcome);
  };
  const cancel = () => finish({ ok: false, reason: 'cancelled' });
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
  const serve = options.serve ?? createHttpWsServer;
  const serverOptions: ServerOptions = {
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
  };
  const server = await serve(serverOptions);
  if (server.port === 8399) {
    server.stop(true);
    throw new Error('Reserved callback port');
  }
  redirectUri = options.redirect(server.port);
  if (new URL(redirectUri).hostname === 'localhost') {
    try {
      ipv6 = await serve({ ...serverOptions, hostname: '::1', port: server.port });
    } catch (error) {
      server.stop(true);
      throw error;
    }
  }
  timer = setTimeout(() => finish({ ok: false, reason: 'expired' }), options.timeoutMs ?? 300000);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  try {
    options.signal?.throwIfAborted();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const url = await options.authorize(
      redirectUri,
      { state, nonce, challenge },
      controller.signal
    );
    controller.signal.throwIfAborted();
    return { authorizeUrl: url.toString(), result, cancel };
  } catch (error) {
    finish({ ok: false, reason: 'login_failed' });
    throw error;
  }
}
