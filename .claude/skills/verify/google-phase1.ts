import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import type { CredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'];
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-phase1', alg: 'RS256', use: 'sig' };
const codes = new Map<string, URLSearchParams>();
const grants: { index: number; access: string; refresh: string; rotation: number }[] = [];
const secrets = new Map<string, string>();
const store: CredentialStore = {
  get: async (service, account) => secrets.get(JSON.stringify([service, account])) ?? null,
  set: async (service, account, value) => { secrets.set(JSON.stringify([service, account]), value); },
  delete: async (service, account) => { secrets.delete(JSON.stringify([service, account])); },
  listServices: async (prefix) => [...new Set([...secrets.keys()].map((key) => JSON.parse(key)[0] as string).filter((service) => service.startsWith(prefix)))],
  getStatus: () => ({ backend: 'keychain', keychainAvailable: true }),
};
let now = Date.now(), refreshes = 0, starts = 0, stops = 0, writes = 0, forbidden = 0, closed = false;
const requests: { path: string; method: string; grant?: number }[] = [];
const observations: unknown[] = [];
const ticks = new Map<string, () => Promise<void>>();
const draftIds = new Set<string>();
const window = { kind: 'events', timeMin: '2026-11-01T00:00:00-04:00', timeMax: '2026-11-03T00:00:00-05:00' };
const events = [
  { id: 'day', summary: 'Day off', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } },
  { id: 'dst', summary: 'Meeting', start: { dateTime: '2026-11-01T01:30:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-01T01:45:00-05:00', timeZone: 'America/New_York' } },
  { id: 'local', summary: 'Zoned local time', start: { dateTime: '2026-11-02T09:00:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-02T10:00:00', timeZone: 'America/New_York' } },
];
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  requests.push({ path: url.pathname, method: request.method });
  if (url.pathname === '/certs') return Response.json({ keys: [jwk] });
  if (url.pathname === '/authorize') {
    assert.equal(request.method, 'GET'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.deepEqual(url.searchParams.get('scope')!.split(' ').sort(), [...scopes].sort());
    const code = `synthetic-code-${codes.size}-${crypto.randomUUID()}`;
    codes.set(code, url.searchParams);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    assert.equal(callback.hostname, '127.0.0.1'); assert.notEqual(callback.port, '8399');
    callback.search = new URLSearchParams({ code, state: url.searchParams.get('state')! }).toString();
    return Response.redirect(callback.href);
  }
  if (url.pathname === '/token') {
    assert.equal(request.method, 'POST');
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get('client_id'), 'synthetic-client'); assert.equal(form.get('client_secret'), 'synthetic-client-secret');
    if (form.get('grant_type') === 'refresh_token') {
      const grant = grants.find((grant) => grant.refresh === form.get('refresh_token'));
      assert(grant, 'rotated refresh token must survive restart'); refreshes++; grant.rotation++;
      grant.access = `synthetic-access-${grant.index}-${grant.rotation}`; grant.refresh = `synthetic-refresh-${grant.index}-${grant.rotation}`;
      return Response.json({ access_token: grant.access, refresh_token: grant.refresh, expires_in: 3600, token_type: 'Bearer' });
    }
    assert.equal(form.get('grant_type'), 'authorization_code');
    const authorization = codes.get(form.get('code')!); assert(authorization); codes.delete(form.get('code')!);
    assert.equal(form.get('redirect_uri'), authorization.get('redirect_uri'));
    assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorization.get('code_challenge'));
    const grant = { index: grants.length + 1, access: `synthetic-access-${grants.length + 1}-0`, refresh: `synthetic-refresh-${grants.length + 1}-0`, rotation: 0 };
    grants.push(grant);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'synthetic-client', sub: 'synthetic-same-subject', email: 'one@example.test', email_verified: true, nonce: authorization.get('nonce'), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const signed = `${header}.${claims}`;
    return Response.json({ access_token: grant.access, refresh_token: grant.refresh, expires_in: 3600, token_type: 'Bearer', scope: scopes.join(' '), id_token: `${signed}.${sign('RSA-SHA256', Buffer.from(signed), keys.privateKey).toString('base64url')}` });
  }
  const grant = grants.find((grant) => request.headers.get('authorization') === `Bearer ${grant.access}`);
  assert(grant); requests.at(-1)!.grant = grant.index;
  if (url.pathname.startsWith('/calendar/v3/')) {
    if (request.method !== 'GET') { forbidden++; return new Response(null, { status: 405 }); }
    assert(Number(url.searchParams.get('maxResults')) <= 25);
    if (url.pathname.endsWith('/calendarList')) return Response.json({ items: [{ id: url.searchParams.has('pageToken') ? 'shared@group.calendar.google.com' : 'one@example.test', summary: 'Calendar', timeZone: 'America/New_York', primary: !url.searchParams.has('pageToken') }], ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'calendar-next' }) });
    assert.equal(url.pathname, '/calendar/v3/calendars/primary/events'); assert.equal(url.searchParams.get('timeMin'), window.timeMin); assert.equal(url.searchParams.get('timeMax'), window.timeMax); assert.equal(url.searchParams.get('singleEvents'), 'true'); assert.equal(url.searchParams.get('showDeleted'), 'false');
    return Response.json({ timeZone: 'America/New_York', items: events });
  }
  if (request.method !== 'GET') {
    const permitted = request.method === 'POST' && url.pathname === '/gmail/v1/users/me/drafts' || request.method === 'PUT' && /^\/gmail\/v1\/users\/me\/drafts\/draft-\d+$/.test(url.pathname);
    if (!permitted) { forbidden++; return new Response(null, { status: 405 }); }
    const body = await request.json() as { message: { raw: string } };
    const mime = Buffer.from(body.message.raw, 'base64url').toString('utf8'); assert(mime.includes('From: one@example.test\r\n')); assert(mime.includes('Content-Transfer-Encoding: base64'));
    const id = request.method === 'POST' ? `draft-${draftIds.size + 1}` : url.pathname.split('/').at(-1)!;
    if (request.method === 'PUT') assert(draftIds.has(id));
    draftIds.add(id); writes++;
    return Response.json({ id, message: { id: `draft-message-${writes}`, threadId: 'thread-one' } });
  }
  if (url.pathname.endsWith('/threads/thread-one')) return Response.json({ id: 'thread-one', historyId: 'revision-one', messages: [{ id: 'mail-one' }] });
  if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'mail-one', threadId: 'thread-one' }] });
  assert.equal(url.pathname, '/gmail/v1/users/me/messages/mail-one');
  return Response.json({ id: 'mail-one', threadId: 'thread-one', snippet: 'Preview', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Fixture mail' }, { name: 'From', value: 'sender@example.test' }, { name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: { size: 12, data: Buffer.from('Hello 你好').toString('base64url') } } });
} });
assert.notEqual(fake.port, 8399);
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  assert(['https://oauth2.googleapis.com', 'https://www.googleapis.com', 'https://gmail.googleapis.com'].includes(target.origin), 'external network refused');
  const path = target.pathname === '/oauth2/v3/certs' ? '/certs' : target.pathname;
  return fetch(`http://127.0.0.1:${fake.port}${path}${target.search}`, init);
}) as typeof fetch;
type App = Awaited<ReturnType<typeof createDaemonApp>>;
const active = new Set<App>();
async function boot(name: string) {
  const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data', name, 'daemon.db') }), verbose: false, googleConnections: { createStore: () => store, fetchImpl, now: () => now, schedule: (tick) => { starts++; ticks.set(name, tick); return () => { stops++; ticks.delete(name); }; } } });
  assert.notEqual(app.server.port, 8399); active.add(app); await app.jobProcessor.stop(); await ticks.get(name)?.(); return app;
}
function observe(name: string, value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of ['synthetic-access-', 'synthetic-refresh-', 'synthetic-client-secret', '"id_token"', '"accessToken"', '"refreshToken"']) assert(!text.includes(secret), `credential disclosure in ${name}`);
  observations.push({ name, value });
}
async function rpc(app: App, name: string, input: unknown = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  try {
    await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('Isolated RPC unavailable')); });
    const value = await new Promise<ReturnType<typeof JSON.parse>>((done, fail) => {
      const id = crypto.randomUUID(), timeout = setTimeout(() => fail(new Error('Management RPC timed out')), 10000);
      ws.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timeout); reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data); };
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    observe(name, value); return value;
  } finally { ws.close(); }
}
function actor(app: App) {
  const registry = app.sessionManager.getOperationRegistry();
  for (const name of ['gmail.send_draft', 'calendar.create', 'calendar.update', 'google.http']) assert.equal(registry.get(name), undefined);
  const mcp = createOperationMcpHandler(() => registry, () => ({ sessionId: 'synthetic-worker', role: 'neo' }));
  return async (name: string, input: unknown = {}) => { const value = JSON.parse((await mcp({ name, input })).content[0].text); observe(name, value); return value; };
}
async function connect(app: App) {
  const flow = await rpc(app, 'connections.google.connect', { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret' });
  assert.equal(flow.state, 'pending'); const authorization = new URL(flow.authorizeUrl); assert.equal(authorization.origin, 'https://accounts.google.com');
  const consent = await fetch(`http://127.0.0.1:${fake.port}/authorize?${authorization.searchParams}`, { redirect: 'manual' });
  const callback = await fetch(consent.headers.get('location')!); assert.equal(callback.status, 200);
  const deadline = Date.now() + 10000;
  for (;;) {
    const result = await rpc(app, 'connections.google.login', { loginId: flow.loginId });
    if (result.state === 'complete') { assert.equal(typeof result.connectionId, 'string'); return result.connectionId as string; }
    assert.equal(result.state, 'pending'); assert(Date.now() < deadline, 'login did not complete'); await new Promise((done) => setTimeout(done, 10));
  }
}
async function close(app: App) { await app.cleanup(); active.delete(app); }
try {
  let a = await boot('a'); const b = await boot('b');
  let am = actor(a); const bm = actor(b);
  assert.deepEqual((await bm('google.accounts')).connections, []); assert.equal(secrets.size, 0);
  const first = await connect(a); assert.equal(secrets.size, 1);
  const before = requests.length; assert.equal((await bm('gmail.search', { connectionId: first })).reason, 'unknown_connection'); assert.equal(requests.length, before);
  assert.equal((await am('gmail.search', { connectionId: first })).items[0].subject, 'Fixture mail');
  assert.equal((await am('gmail.read_thread', { connectionId: first, threadId: 'thread-one', body: true })).items[0].bodyParts[0].text, 'Hello 你好');
  const draft = await am('gmail.draft', { connectionId: first, to: ['recipient@example.test'], subject: 'RC draft', text: 'First body' }); assert.equal(draft.ok, true);
  assert.equal((await am('gmail.draft', { connectionId: first, draftId: draft.draftId, to: ['recipient@example.test'], subject: 'RC draft', text: 'Updated body' })).draftId, draft.draftId); assert.equal(writes, 2);
  const calendars = await am('calendar.list', { connectionId: first }); assert.equal(calendars.kind, 'calendars'); assert.equal(calendars.items[0].id, 'one@example.test'); assert.equal(calendars.truncated, true);
  assert.equal((await am('calendar.list', { connectionId: first, cursor: calendars.nextCursor })).items[0].id, 'shared@group.calendar.google.com');
  const listed = await am('calendar.list', { connectionId: first, ...window }); assert.equal(listed.timeZone, 'America/New_York'); assert.deepEqual(listed.items.map((item: { start: unknown; end: unknown }) => ({ start: item.start, end: item.end })), events.map(({ start, end }) => ({ start, end })));
  const second = await connect(b); assert.notEqual(first, second); assert.equal(secrets.size, 2);
  assert.equal((await bm('google.accounts')).connections.length, 1);
  now += 3540000; let prior = refreshes; await ticks.get('a')!(); assert.equal(refreshes, prior + 1);
  assert.equal((await am('gmail.search', { connectionId: first })).ok, true);
  await close(a); now += 3540000; prior = refreshes; a = await boot('a'); am = actor(a); assert.equal(refreshes, prior + 1);
  assert.equal((await am('google.accounts')).connections[0].id, first); assert.equal((await am('calendar.list', { connectionId: first, ...window })).ok, true);
  assert.equal((await rpc(a, 'connections.google.disconnect', { connectionId: first })).ok, true); assert.equal(secrets.size, 1);
  prior = requests.length; assert.equal((await am('gmail.search', { connectionId: first })).reason, 'disconnected'); assert.equal(requests.length, prior);
  assert.equal((await bm('gmail.search', { connectionId: second })).ok, true); assert.equal(secrets.size, 1);
  assert.equal(forbidden, 0); assert.equal(writes, 2); assert.equal(grants.length, 2); assert.equal(refreshes, 3);
} finally {
  try { for (const app of active) await app.cleanup(); active.clear(); } finally { fake.stop(true); closed = true; writeFileSync(join(run, 'evidence/google-phase1.json'), JSON.stringify({ runtime: process.versions, observations, requests, grants: grants.map(({ index, rotation }) => ({ index, rotation })), refreshes, starts, stops, writes, forbidden, remainingCredentialNamespaces: secrets.size, closed }, null, 2)); }
}
assert.equal(starts, stops);
process.stdout.write('PASS: complete fake-Google phase1 RPC/MCP flow, Calendar semantics, refresh/restart and two-instance credential isolation; zero sends/event writes; resources closed\n');
