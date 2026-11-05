import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import { createGoogleConnectionOperations } from '../../../../src/lib/connections/operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { artifactIdentityWrites } from '../../../../src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionWrites } from '../../../../src/storage/repositories/google-connections-worker.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let invoke: (input?: unknown) => Promise<ReturnType<typeof JSON.parse>>;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let vault: ConnectionVault;
let mode: string;
let caller: { sessionId?: string; role?: 'neo' | 'universal_read' };
const scopes = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];
const rows = ['one', 'two'].map((id) => ({
  id,
  provider: 'google' as const,
  accountId: `subject-${id}`,
  email: `${id}@example.test`,
  scopes,
  health: 'healthy' as const,
}));
const times = {
  kind: 'events',
  timeMin: '2026-11-01T00:00:00-04:00',
  timeMax: '2026-11-03T00:00:00-05:00',
};
const allDay = {
  id: 'all-day',
  summary: 'Day off',
  start: { date: '2026-11-01' },
  end: { date: '2026-11-02' },
};
const timed = {
  id: 'timed',
  summary: 'Meeting',
  start: { dateTime: '2026-11-01T01:30:00-04:00', timeZone: 'America/New_York' },
  end: { dateTime: '2026-11-01T01:45:00-05:00', timeZone: 'America/New_York' },
};

beforeEach(async () => {
  db = await createTestDb();
  mode = 'normal';
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  const store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key');
  vault = new ConnectionVault(
    store,
    await db.gateway.call(artifactIdentityWrites, 'ensure', 'synthetic-instance')
  );
  for (const row of rows) {
    await db.gateway.call(googleConnectionWrites, 'put', row);
    await vault.replace(row, {
      accessToken: `synthetic-access-${row.id}`,
      expiresAt: Date.now() + 3600000,
      scopes,
    });
  }
  fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('error');
    if (mode === 'rate') return new Response('synthetic-access-one', { status: 429 });
    if (url.pathname.endsWith('/calendarList'))
      return Response.json({
        items: [
          {
            id: 'one@example.test',
            summary: 'Default',
            summaryOverride: mode === 'long' ? 'x'.repeat(1000) : 'My calendar',
            timeZone: 'America/New_York',
            primary: true,
            accessRole: 'owner',
            description: 'must-not-leak',
          },
        ],
        ...(mode === 'long' || url.searchParams.has('pageToken')
          ? {}
          : { nextPageToken: 'opaque-next' }),
      });
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('orderBy')).toBe('startTime');
    expect(url.searchParams.get('showDeleted')).toBe('false');
    expect(url.searchParams.get('timeMin')).toBe(times.timeMin);
    expect(url.searchParams.get('timeMax')).toBe(times.timeMax);
    return Response.json({
      timeZone: 'America/New_York',
      items: mode === 'too-many' ? [allDay, timed, allDay] : [allDay, timed],
      nextPageToken: 'events-next',
      defaultReminders: [{ method: 'email', minutes: 10 }],
    });
  });
  const registry = createOperationRegistry(
    createGoogleConnectionOperations(() => db.getDatabase(), {
      createStore: () => store,
      fetchImpl,
    })
  );
  const mcp = createOperationMcpHandler(registry, () => caller);
  invoke = async (input = { connectionId: 'one' }) =>
    JSON.parse((await mcp({ name: 'calendar.list', input })).content[0].text);
});
afterEach(() => db.close());

test('calendar list uses a bounded projected page and the user’s display name', async () => {
  const result = await invoke();
  expect(result).toMatchObject({
    ok: true,
    kind: 'calendars',
    untrusted: true,
    items: [
      {
        id: 'one@example.test',
        summary: 'My calendar',
        timeZone: 'America/New_York',
        primary: true,
      },
    ],
    nextCursor: 'opaque-next',
    truncated: true,
  });
  expect(JSON.stringify(result)).not.toContain('must-not-leak');
  expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('maxResults')).toBe('10');
});

test('event dates remain dates and DST offsets/timezones are preserved exactly', async () => {
  const result = await invoke({ connectionId: 'one', ...times, limit: 2 });
  expect(result).toMatchObject({
    ok: true,
    kind: 'events',
    timeZone: 'America/New_York',
    items: [allDay, timed],
  });
  expect(result.items[0].end).toEqual({ date: '2026-11-02' });
  expect(JSON.stringify(result)).not.toContain('defaultReminders');
});

test('opaque provider cursors and the named account are passed without fallback', async () => {
  const result = await invoke({ connectionId: 'two', cursor: 'opaque-next' });
  expect(result.ok).toBe(true);
  expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('authorization')).toBe(
    'Bearer synthetic-access-two'
  );
  expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('pageToken')).toBe(
    'opaque-next'
  );
  fetchImpl.mockClear();
  expect((await invoke({ connectionId: 'foreign' })).reason).toBe('unknown_connection');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('scope and session admission prevent API calls', async () => {
  caller = {};
  expect((await invoke()).reason).toBe('session_required');
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  await vault.replace(rows[0], {
    accessToken: 'synthetic-access-one',
    expiresAt: Date.now() + 3600000,
    scopes: [scopes[0]],
  });
  expect((await invoke({ connectionId: 'one', ...times })).reason).toBe('missing_scope');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect((await invoke()).ok).toBe(true);
});

test('clipped calendar names are marked on the item and result without a next page', async () => {
  mode = 'long';
  const result = await invoke();
  expect(result.items[0].summary.length).toBe(128);
  expect(result.items[0].truncated).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.nextCursor).toBeUndefined();
});

test.each([
  { ...times, timeMax: times.timeMin },
  { ...times, timeMax: '2027-01-01T00:00:00Z' },
  { kind: 'events' },
  { limit: 26 },
  { cursor: 'x'.repeat(2049) },
  { method: 'POST' },
  { kind: 'calendars', calendarId: 'primary' },
])('invalid windows/bounds/write arguments fail before requests: %j', async (extra) => {
  expect((await invoke({ connectionId: 'one', ...extra })).code).toBe('invalid_input');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('oversized provider pages and 429s fail boundedly without credential details', async () => {
  mode = 'too-many';
  expect((await invoke({ connectionId: 'one', ...times, limit: 2 })).reason).toBe(
    'invalid_response'
  );
  mode = 'rate';
  const result = await invoke();
  expect(result).toMatchObject({ ok: false, reason: 'rate_limited' });
  expect(JSON.stringify(result)).not.toContain('synthetic-access');
});
