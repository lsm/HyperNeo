import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { DatabaseCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../packages/daemon/src/lib/connections/vault.ts';
import { artifactIdentityWrites } from '../../../packages/daemon/src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionWrites } from '../../../packages/daemon/src/storage/repositories/google-connections-worker.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
const graph = 'https://graph.microsoft.com';
const rows = [
  { id: 'outlook-one', provider: 'microsoft' as const, accountId: '11111111-2222-4333-8444-555555555555.synthetic-object', email: 'one@example.test', scopes: ['openid', 'profile', 'email', 'offline_access', 'Mail.ReadWrite', 'Calendars.Read'], health: 'healthy' as const },
  { id: 'gmail-one', provider: 'google' as const, accountId: 'synthetic-subject', email: 'g@example.test', scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'], health: 'healthy' as const },
];
const utc = (dateTime: string) => ({ dateTime, timeZone: 'UTC' });
const events = [
  { id: 'all-day', subject: 'Day off', isAllDay: true, isCancelled: false, start: utc('2026-11-01T00:00:00.0000000'), end: utc('2026-11-02T00:00:00.0000000'), originalStartTimeZone: 'Eastern Standard Time', originalEndTimeZone: 'Eastern Standard Time', location: { displayName: '' }, body: { content: 'synthetic-private-body' } },
  { id: 'dst-gap', subject: 'Across the clock change', isAllDay: false, isCancelled: false, start: utc('2026-11-01T05:30:00.0000000'), end: utc('2026-11-01T06:45:00.0000000'), originalStartTimeZone: 'America/New_York', originalEndTimeZone: 'America/New_York', location: { displayName: 'Room 1' } },
  { id: 'two-zones', subject: 'Flight', isAllDay: false, isCancelled: false, start: utc('2026-11-02T14:00:00.0000000'), end: utc('2026-11-02T21:00:00.0000000'), originalStartTimeZone: 'America/New_York', originalEndTimeZone: 'Europe/London', location: { displayName: 'JFK' } },
];
const requests: { method: string; path: string; query: string }[] = [];
const observations: unknown[] = [];
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  assert.equal(request.headers.get('authorization'), 'Bearer synthetic-access-token');
  requests.push({ method: request.method, path: url.pathname, query: url.search });
  if (request.method !== 'GET') return new Response('refused', { status: 405 });
  const skip = Number(url.searchParams.get('$skip') ?? 0);
  const top = Number(url.searchParams.get('$top'));
  if (url.pathname === '/v1.0/me/calendars')
    return Response.json({ value: [{ id: 'calendar-one', name: 'Calendar', isDefaultCalendar: true, owner: { address: 'synthetic-owner@example.test' } }] });
  if (url.pathname !== '/v1.0/me/calendarView') return new Response('missing', { status: 404 });
  const page = events.slice(skip, skip + top);
  const more = skip + top < events.length;
  return Response.json({ value: page, ...(more ? { '@odata.nextLink': `${graph}/v1.0/me/calendarView?startDateTime=${url.searchParams.get('startDateTime')}&endDateTime=${url.searchParams.get('endDateTime')}&$skip=${skip + top}` } : {}) });
} });
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  assert.equal(target.origin, graph, 'external network refused');
  assert.equal(init?.redirect, 'error');
  return fetch(`http://127.0.0.1:${fake.port}${target.pathname}${target.search}`, init);
}) as typeof fetch;
const createStore = (db: ConstructorParameters<typeof DatabaseCredentialStore>[0]) => new DatabaseCredentialStore(db, 'synthetic-proof-key');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false, googleConnections: { createStore, fetchImpl, apiTimeoutMs: 500, schedule: () => () => {} } });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const identity = await app.db.gateway.call(artifactIdentityWrites, 'ensure', crypto.randomUUID());
  const vault = new ConnectionVault(createStore(app.db.getDatabase()), identity);
  for (const row of rows) {
    await app.db.gateway.call(googleConnectionWrites, 'put', row);
    await vault.replace(row, { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', expiresAt: Date.now() + 3600000, scopes: row.scopes, client: { clientId: 'synthetic-client' } });
  }
  const mcp = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-worker', role: 'neo' as const }));
  const list = async (input: Record<string, unknown>) => {
    const full = { connectionId: 'outlook-one', ...input };
    const value = JSON.parse((await mcp({ name: 'outlook.calendar_list', input: full })).content[0].text);
    observations.push({ input: full, value });
    for (const forbidden of ['synthetic-access-token', 'synthetic-refresh-token', 'synthetic-proof-key', 'graph.microsoft.com', 'synthetic-private-body', 'synthetic-owner']) assert(!JSON.stringify(value).includes(forbidden), `leaked: ${forbidden}`);
    return value;
  };
  const window = { kind: 'events', timeMin: '2026-11-01T00:00:00-04:00', timeMax: '2026-11-03T00:00:00-05:00' };

  const calendars = await list({});
  assert.deepEqual(calendars.items, [{ id: 'calendar-one', name: 'Calendar', isDefaultCalendar: true, truncated: false }]);
  const first = await list({ ...window, limit: 2 });
  assert.equal(first.ok, true);
  assert.deepEqual(first.items.map((item: { id: string }) => item.id), ['all-day', 'dst-gap']);
  assert.deepEqual([first.items[0].start, first.items[0].end, first.items[0].isAllDay], [{ date: '2026-11-01' }, { date: '2026-11-02' }, true]);
  assert.deepEqual([first.items[1].start, first.items[1].startTimeZone], [utc('2026-11-01T05:30:00.0000000'), 'America/New_York']);
  assert.equal(typeof first.nextCursor, 'string');
  const second = await list({ ...window, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item: { id: string; startTimeZone: string; endTimeZone: string }) => [item.id, item.startTimeZone, item.endTimeZone]), [['two-zones', 'America/New_York', 'Europe/London']]);
  assert.equal(second.nextCursor, undefined);
  const paged = requests.at(-1)!;
  assert.equal(new URLSearchParams(paged.query).get('startDateTime'), window.timeMin, 'the page keeps the caller window');
  const before = requests.length;
  assert.deepEqual(await list({ ...window, timeMax: '2026-11-04T00:00:00-05:00', cursor: first.nextCursor }), { ok: false, reason: 'invalid_cursor' });
  assert.deepEqual(await list({ connectionId: 'gmail-one', ...window }), { ok: false, reason: 'unknown_connection' });
  assert.equal((await list({ ...window, timeMax: '2026-12-15T00:00:00Z' })).code, 'invalid_input');
  assert.equal(requests.length, before, 'refusals sent no Graph request');
  assert.deepEqual(requests.filter((row) => row.method !== 'GET'), [], 'zero writes');
  for (const row of requests) assert(!new URLSearchParams(row.query).get('$select')?.split(',').includes('body'), 'no body selected');
} finally {
  await app?.cleanup();
  fake.stop(true);
  writeFileSync(join(run, 'evidence/outlook-calendar.json'), JSON.stringify({ runtime: process.versions, requests, observations }, null, 2));
}
process.stdout.write('PASS: Outlook calendars and events through the real daemon operations MCP: windows, all-day dates, each event’s own time zones, signed cursors, zero writes; resources closed\n');
