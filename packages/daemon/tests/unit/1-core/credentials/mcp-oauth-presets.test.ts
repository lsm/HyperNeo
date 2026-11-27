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

function serveVendorFrom(server: Fake, vendor: (typeof vendors)[number]) {
  const vendorOrigins = [new URL(vendor.url).origin, new URL(vendor.issuer).origin];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!vendorOrigins.includes(url.origin)) return realFetch(input, init);
    const path = url.pathname.startsWith('/.well-known/oauth-protected-resource')
      ? '/.well-known/oauth-protected-resource/mcp'
      : url.pathname.startsWith('/.well-known/oauth-authorization-server')
        ? '/.well-known/oauth-authorization-server'
        : url.pathname;
    const reply = await realFetch(`${server.base}${path}${url.search}`, init);
    const body = (await reply.text())
      .replaceAll(`"${server.base}/mcp"`, JSON.stringify(vendor.url))
      .replaceAll(server.base, new URL(vendor.issuer).origin);
    return new Response(body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
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
      const store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-encryption-key');
      const { operations } = createMcpOAuthOperations(db, store, () => {});
      const run = (name: string, input: unknown) =>
        operations
          .find((operation) => operation.name === name)!
          .execute(
            input as never,
            {
              caller: { kind: 'local_user' },
            } as never
          ) as Promise<Record<string, unknown>>;

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
});
