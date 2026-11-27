import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMcpOAuthOperations } from '../../../../src/lib/connections/mcp-oauth-operations.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import type { Database } from '../../../../src/storage/database';
import { createTestDb } from '../../../helpers/database';
import { startFakeMcpOAuthServer } from '../../../helpers/fake-mcp-oauth-server.ts';

type Fake = Awaited<ReturnType<typeof startFakeMcpOAuthServer>>;

const vendors = [
  {
    preset: 'jira',
    url: 'https://mcp.atlassian.com/v2/mcp',
    issuer: 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3',
    authorize: 'https://auth.atlassian.com/authorize',
    scope: 'read:jira:agent-interface search:jira:agent-interface offline_access',
  },
  {
    preset: 'basecamp',
    url: 'https://mcp.basecamp.com/mcp',
    issuer: 'https://app.basecamp.com',
    authorize: 'https://app.basecamp.com/oauth/authorizations/new',
    scope: 'read',
  },
] as const;

let db: Database;
let fake: Fake | undefined;
const realFetch = globalThis.fetch;

type Vendor = { url: string; issuer: string; authorize: string };

function serveVendorFrom(server: Fake, vendor: Vendor, rootResource = false) {
  const vendorOrigins = [vendor.url, vendor.issuer, vendor.authorize].map(
    (url) => new URL(url).origin
  );
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!vendorOrigins.includes(url.origin)) return realFetch(input, init);
    const path =
      url.origin + url.pathname === vendor.authorize
        ? '/authorize'
        : url.pathname.startsWith('/.well-known/oauth-protected-resource') && !rootResource
          ? '/.well-known/oauth-protected-resource/mcp'
          : url.pathname.startsWith('/.well-known/oauth-authorization-server')
            ? '/.well-known/oauth-authorization-server'
            : url.pathname;
    const reply = await realFetch(`${server.base}${path}${url.search}`, {
      ...init,
      redirect: 'manual',
    });
    const body = (await reply.text())
      .replaceAll(`"${server.base}/mcp"`, JSON.stringify(vendor.url))
      .replaceAll(server.base, new URL(vendor.issuer).origin);
    return new Response(reply.status === 302 ? null : body, {
      status: reply.status,
      headers: reply.headers,
    });
  }) as typeof fetch;
}

function operationsFor(store: DatabaseCredentialStore) {
  const { operations } = createMcpOAuthOperations(db, store, () => {});
  return (name: string, input: unknown) =>
    operations
      .find((operation) => operation.name === name)!
      .execute(input as never, { caller: { kind: 'local_user' } } as never) as Promise<
      Record<string, unknown>
    >;
}

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fake?.stop();
  fake = undefined;
  db.close();
});

describe('MCP OAuth vendor presets', () => {
  for (const vendor of vendors)
    test(`${vendor.preset} offers Connect and opens the vendor consent with read-only scopes`, async () => {
      fake = await startFakeMcpOAuthServer({
        metadataIssuer: vendor.issuer,
        authorizationServer: vendor.issuer,
        authorizationEndpoint: vendor.authorize,
      });
      serveVendorFrom(fake, vendor);
      const row = db.appMcpServers.create({
        name: vendor.preset,
        sourceType: 'http',
        url: vendor.url,
      });
      const run = operationsFor(
        new DatabaseCredentialStore(db.getDatabase(), 'synthetic-encryption-key')
      );

      expect(await run('mcp.registry.status', { id: row.id })).toEqual({
        health: 'disconnected',
        scopes: [],
        preset: vendor.preset,
      });
      const receipt = await run('mcp.registry.connect', { id: row.id, preset: vendor.preset });
      const consent = new URL(String(receipt.authorizeUrl));
      expect(consent.origin + consent.pathname).toBe(vendor.authorize);
      expect(consent.searchParams.get('scope')).toBe(vendor.scope);
      expect(consent.searchParams.get('resource')).toBe(vendor.url);
      expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
      expect(consent.searchParams.get('client_id')).toStartWith('client-');
      expect(fake.requests.some((request) => request.path === '/register')).toBe(true);
      await run('mcp.registry.disconnect', { id: row.id });
    });

  test('slack connects with the client the human enters, keeping its secret out of the row', async () => {
    const slack = {
      url: 'https://mcp.slack.com/mcp',
      issuer: 'https://mcp.slack.com',
      authorize: 'https://slack.com/oauth/v2_user/authorize',
    };
    const client = { clientId: 'slack-client', clientSecret: 'synthetic-slack-secret' };
    fake = await startFakeMcpOAuthServer({
      slack: true,
      rootResource: true,
      preRegistered: client,
      metadataIssuer: slack.issuer,
      authorizationServer: slack.issuer,
      authorizationEndpoint: slack.authorize,
    });
    serveVendorFrom(fake, slack, true);
    const row = db.appMcpServers.create({ name: 'slack', sourceType: 'http', url: slack.url });
    const run = operationsFor(
      new DatabaseCredentialStore(db.getDatabase(), 'synthetic-encryption-key')
    );

    expect(await run('mcp.registry.status', { id: row.id })).toEqual({
      health: 'disconnected',
      scopes: [],
      preset: 'slack',
      needsClient: true,
    });
    expect(await run('mcp.registry.connect', { id: row.id, preset: 'slack' })).toEqual({
      reason: 'client_required',
    });
    const receipt = await run('mcp.registry.connect', { id: row.id, preset: 'slack', ...client });
    const consent = new URL(String(receipt.authorizeUrl));
    expect(consent.origin + consent.pathname).toBe(slack.authorize);
    expect(consent.searchParams.get('client_id')).toBe(client.clientId);
    expect(consent.searchParams.get('resource')).toBe('https://mcp.slack.com');
    const scopes = consent.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('search:read.public');
    expect(scopes.every((scope) => /(:read|:history|^search:read\.)/.test(scope))).toBe(true);
    expect(fake.requests.some((request) => request.path === '/register')).toBe(false);

    const callback = (await globalThis.fetch(consent, { redirect: 'manual' })).headers.get(
      'location'
    );
    expect((await realFetch(callback!)).status).toBe(200);
    for (let i = 0; i < 50; i++) {
      if ((await run('mcp.registry.status', { id: row.id })).health === 'healthy') break;
      await Bun.sleep(20);
    }
    const connected = await run('mcp.registry.status', { id: row.id });
    expect(connected).toMatchObject({ health: 'healthy', scopes });
    const token = fake.requests.find((request) => request.path === '/token')!;
    expect(token.params.get('client_secret')).toBe(client.clientSecret);
    expect(token.auth).toBe('');
    expect(db.appMcpServers.get(row.id)?.auth?.clientId).toBe(client.clientId);
    expect(JSON.stringify([connected, db.appMcpServers.get(row.id)])).not.toContain(
      client.clientSecret
    );
    const again = new URL(
      String((await run('mcp.registry.reconnect', { id: row.id })).authorizeUrl)
    );
    expect(again.searchParams.get('client_id')).toBe(client.clientId);
    await run('mcp.registry.disconnect', { id: row.id });
    expect(await run('mcp.registry.reconnect', { id: row.id })).toEqual({
      reason: 'client_required',
    });
  });
});
