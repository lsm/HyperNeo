import { expect, test } from 'bun:test';
import { request } from 'node:http';
import { createNodeServer } from '../../../../src/lib/runtime-server/node-backend.ts';
import { startLoopbackLogin } from '../../../../src/lib/connections/loopback-login.ts';

const success = {
  ok: true as const,
  accountId: 'synthetic-account',
  email: 'one@example.test',
  tokens: { accessToken: 'synthetic-access', expiresAt: Date.now() + 3600000, scopes: [] },
};

function get(url: string, host: string, address = '127.0.0.1') {
  return new Promise<number>((done, fail) => {
    const target = new URL(url);
    const call = request(
      {
        hostname: address,
        port: target.port,
        path: target.pathname + target.search,
        headers: { host },
      },
      (response) => {
        response.resume();
        response.on('end', () => done(response.statusCode ?? 0));
      }
    );
    call.on('error', fail);
    call.end();
  });
}

async function localhostLogin() {
  let state = '';
  const codes: string[] = [];
  const login = await startLoopbackLogin({
    serve: createNodeServer,
    redirect: (port) => `http://localhost:${port}/oauth/microsoft/callback`,
    authorize: (redirectUri, proof) => {
      state = proof.state;
      const url = new URL('https://login.example.test/authorize');
      url.searchParams.set('redirect_uri', redirectUri);
      return url;
    },
    exchange: async (code) => {
      codes.push(code);
      return success;
    },
  });
  const redirect = new URL(new URL(login.authorizeUrl).searchParams.get('redirect_uri') ?? '');
  const query = new URLSearchParams({ code: 'synthetic-code', state });
  const callback = (host: string, address?: string) =>
    get(`http://127.0.0.1:${redirect.port}${redirect.pathname}?${query}`, host, address);
  return { login, redirect, callback, codes };
}

test('the Node server backend accepts a localhost callback and completes the login', async () => {
  const { login, redirect, callback, codes } = await localhostLogin();
  expect(await callback(redirect.host)).toBe(200);
  expect(await login.result).toEqual(success);
  expect(codes).toEqual(['synthetic-code']);
});

test('the Node server backend accepts a localhost callback over IPv6', async () => {
  const { login, redirect, callback, codes } = await localhostLogin();
  try {
    expect(await callback(redirect.host, '::1')).toBe(200);
    expect(await login.result).toEqual(success);
    expect(codes).toEqual(['synthetic-code']);
  } finally {
    login.cancel();
  }
});

test('the Node server backend refuses a callback for another host without exchanging', async () => {
  const { login, redirect, callback, codes } = await localhostLogin();
  expect(await callback(`127.0.0.1:${redirect.port}`)).toBe(400);
  expect(codes).toEqual([]);
  login.cancel();
  expect(await login.result).toEqual({ ok: false, reason: 'cancelled' });
});
