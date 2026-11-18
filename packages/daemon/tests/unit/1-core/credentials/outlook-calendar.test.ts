import { afterEach, beforeEach, expect, test } from "bun:test";
import { vi } from "vitest";
import { createTestDb } from "../../../helpers/database.ts";
import { DatabaseCredentialStore } from "../../../../src/lib/credentials/credential-store.ts";
import { ConnectionVault } from "../../../../src/lib/connections/vault.ts";
import { createMicrosoftConnectionOperations } from "../../../../src/lib/connections/microsoft-operations.ts";
import { createOperationRegistry } from "../../../../src/lib/operations/registry.ts";
import { createOperationMcpHandler } from "../../../../src/lib/operations/mcp-adapter.ts";
import { artifactIdentityWrites } from "../../../../src/storage/repositories/artifact-file-identity-write.ts";
import { googleConnectionWrites } from "../../../../src/storage/repositories/google-connections-worker.ts";

const graph = "https://graph.microsoft.com";
type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let db: Awaited<ReturnType<typeof createTestDb>>;
let mcp: ReturnType<typeof createOperationMcpHandler>;
let sent: {
  method: string;
  path: string;
  params: URLSearchParams;
  prefer: string | null;
}[];
let mode: string;
let caller: { sessionId?: string; role?: "neo" | "universal_read" };
let vault: ConnectionVault;
const scopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.ReadWrite",
  "Calendars.Read",
];
const microsoft = {
  id: "outlook-one",
  provider: "microsoft" as const,
  accountId: "11111111-2222-4333-8444-555555555555.synthetic-object",
  email: "one@example.test",
  health: "healthy" as const,
  scopes,
};
const google = {
  id: "gmail-one",
  provider: "google" as const,
  accountId: "synthetic-subject",
  email: "g@example.test",
  health: "healthy" as const,
  scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
};
const window = {
  kind: "events",
  timeMin: "2026-11-01T00:00:00-04:00",
  timeMax: "2026-11-03T00:00:00-05:00",
};
const allDay = {
  id: "all-day",
  subject: "Day off",
  isAllDay: true,
  isCancelled: false,
  start: { dateTime: "2026-11-01T00:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-02T00:00:00.0000000", timeZone: "UTC" },
  originalStartTimeZone: "Eastern Standard Time",
  originalEndTimeZone: "Eastern Standard Time",
  location: { displayName: "" },
  body: { content: "must-not-leak" },
};
const timed = {
  id: "timed",
  subject: "Meeting",
  isAllDay: false,
  isCancelled: false,
  start: { dateTime: "2026-11-01T05:30:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-01T06:45:00.0000000", timeZone: "UTC" },
  originalStartTimeZone: "America/New_York",
  originalEndTimeZone: "Europe/London",
  location: { displayName: "Room 1" },
  attendees: [{ emailAddress: { address: "must-not-leak@example.test" } }],
};

beforeEach(async () => {
  db = await createTestDb();
  sent = [];
  mode = "normal";
  caller = { sessionId: "synthetic-worker", role: "neo" };
  const store = new DatabaseCredentialStore(db.getDatabase(), "synthetic-key");
  vault = new ConnectionVault(
    store,
    await db.gateway.call(
      artifactIdentityWrites,
      "ensure",
      "synthetic-instance",
    ),
  );
  for (const row of [microsoft, google]) {
    await db.gateway.call(googleConnectionWrites, "put", row);
    await vault.replace(row, {
      accessToken: "synthetic-access-token",
      refreshToken: "synthetic-refresh-token",
      expiresAt: Date.now() + 3600000,
      scopes: row.scopes,
      client: { clientId: "synthetic-client" },
    });
  }
  const fetchImpl = vi.fn<Fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(graph);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-access-token");
    sent.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      params: url.searchParams,
      prefer: headers.get("prefer"),
    });
    if (mode === "rate")
      return new Response("synthetic-access-token", { status: 429 });
    const skip = url.searchParams.get("$skip");
    if (url.pathname === "/v1.0/me/calendars")
      return Response.json({
        value: [
          {
            id: "calendar-one",
            name: mode === "long" ? "x".repeat(1000) : "Calendar",
            isDefaultCalendar: true,
            owner: { address: "must-not-leak@example.test" },
          },
        ],
        ...(skip || mode === "long"
          ? {}
          : { "@odata.nextLink": `${graph}/v1.0/me/calendars?$skip=1` }),
      });
    const next =
      mode === "foreign"
        ? "https://evil.example/v1.0/me/calendarView?$skip=2"
        : `${graph}/v1.0/me/calendarView?startDateTime=2026-11-01T04%3A00%3A00.0000000&endDateTime=2026-11-03T05%3A00%3A00.0000000&$skip=2`;
    return Response.json({
      value: skip ? [] : [allDay, timed],
      ...(skip ? {} : { "@odata.nextLink": next }),
    });
  });
  mcp = createOperationMcpHandler(
    createOperationRegistry(
      createMicrosoftConnectionOperations(() => db.getDatabase(), {
        createStore: () => store,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ),
    () => caller,
  );
});
afterEach(() => db.close());

const list = async (extra: Record<string, unknown> = {}) =>
  JSON.parse(
    (
      await mcp({
        name: "outlook.calendar_list",
        input: { connectionId: microsoft.id, ...extra },
      })
    ).content[0].text,
  );

test("lists calendars as a bounded projected page with an opaque cursor", async () => {
  const first = await list();
  expect(first).toMatchObject({
    ok: true,
    untrusted: true,
    kind: "calendars",
    items: [
      {
        id: "calendar-one",
        name: "Calendar",
        isDefaultCalendar: true,
        truncated: false,
      },
    ],
    truncated: true,
  });
  expect(JSON.stringify(first)).not.toContain("must-not-leak");
  expect(first.nextCursor).not.toContain("graph.microsoft.com");
  expect(sent[0].path).toBe("/v1.0/me/calendars");
  expect(sent[0].params.get("$top")).toBe("10");
  const second = await list({ cursor: first.nextCursor });
  expect(second).toMatchObject({
    ok: true,
    kind: "calendars",
    truncated: false,
  });
  expect(sent[1].path).toBe("/v1.0/me/calendars");
  expect(sent[1].params.get("$skip")).toBe("1");
});

test("events keep their all-day dates and each event’s own time zone", async () => {
  const result = await list(window);
  expect(result).toMatchObject({
    ok: true,
    untrusted: true,
    kind: "events",
    items: [
      {
        id: "all-day",
        subject: "Day off",
        location: "",
        isAllDay: true,
        isCancelled: false,
        start: { date: "2026-11-01" },
        end: { date: "2026-11-02" },
        startTimeZone: "Eastern Standard Time",
        endTimeZone: "Eastern Standard Time",
        truncated: false,
      },
      {
        id: "timed",
        subject: "Meeting",
        location: "Room 1",
        isAllDay: false,
        start: { dateTime: "2026-11-01T05:30:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-11-01T06:45:00.0000000", timeZone: "UTC" },
        startTimeZone: "America/New_York",
        endTimeZone: "Europe/London",
        truncated: false,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
  const [request] = sent;
  expect(request.path).toBe("/v1.0/me/calendarView");
  expect(request.params.get("startDateTime")).toBe(window.timeMin);
  expect(request.params.get("endDateTime")).toBe(window.timeMax);
  expect(request.params.get("$select")?.split(",")).not.toContain("body");
  expect(request.params.get("$select")?.split(",")).not.toContain("attendees");
});

test("an event cursor pages the same window on the calendar view only", async () => {
  const first = await list(window);
  expect(first.nextCursor).not.toContain("graph.microsoft.com");
  const second = await list({ ...window, cursor: first.nextCursor });
  expect(second).toMatchObject({
    ok: true,
    kind: "events",
    items: [],
    truncated: false,
  });
  expect(sent[1].path).toBe("/v1.0/me/calendarView");
  expect(sent[1].params.get("$skip")).toBe("2");
  expect(sent[1].params.get("$select")).toBe(sent[0].params.get("$select"));
});

test("a cursor for another window, kind or connection, or a forged one, sends no request", async () => {
  const { nextCursor } = await list(window);
  sent = [];
  for (const input of [
    { ...window, timeMax: "2026-11-04T00:00:00-05:00", cursor: nextCursor },
    { cursor: nextCursor },
    { ...window, cursor: "forged" },
  ])
    expect(await list(input)).toEqual({ ok: false, reason: "invalid_cursor" });
  const other = await mcp({
    name: "outlook.calendar_list",
    input: { connectionId: google.id, ...window, cursor: nextCursor },
  });
  expect(JSON.parse(other.content[0].text).ok).toBe(false);
  expect(sent).toEqual([]);
});

test("a next link on another origin is refused instead of becoming a cursor", async () => {
  mode = "foreign";
  expect(await list(window)).toEqual({ ok: false, reason: "invalid_response" });
});

test("a Google connection, a caller without a session or a missing scope sends nothing", async () => {
  expect(await list({ connectionId: google.id })).toEqual({
    ok: false,
    reason: "unknown_connection",
  });
  caller = { sessionId: "", role: "universal_read" };
  expect((await list()).reason).toBe("session_required");
  caller = { sessionId: "synthetic-worker", role: "neo" };
  await vault.replace(microsoft, {
    accessToken: "synthetic-access-token",
    refreshToken: "synthetic-refresh-token",
    expiresAt: Date.now() + 3600000,
    scopes: ["openid", "Mail.ReadWrite"],
    client: { clientId: "synthetic-client" },
  });
  expect(await list(window)).toEqual({ ok: false, reason: "missing_scope" });
  expect(sent).toEqual([]);
});

test("a grant stored with fully qualified Graph scopes can list events", async () => {
  await vault.replace(microsoft, {
    accessToken: "synthetic-access-token",
    refreshToken: "synthetic-refresh-token",
    expiresAt: Date.now() + 3600000,
    scopes: ["openid", "https://graph.microsoft.com/Calendars.Read"],
    client: { clientId: "synthetic-client" },
  });
  expect((await list(window)).ok).toBe(true);
});

test("long calendar names are clipped and marked truncated", async () => {
  mode = "long";
  const result = await list();
  expect(result.items[0].name.length).toBe(128);
  expect(result.items[0].truncated).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.nextCursor).toBeUndefined();
});

test("a 429 reports rate_limited without Graph text", async () => {
  mode = "rate";
  expect(await list(window)).toEqual({ ok: false, reason: "rate_limited" });
});

test.each([
  { ...window, timeMax: window.timeMin },
  { ...window, timeMax: "2027-01-01T00:00:00Z" },
  { kind: "events" },
  { kind: "calendars", timeMin: window.timeMin, timeMax: window.timeMax },
  { limit: 26 },
  { cursor: "x".repeat(2049) },
  { method: "POST" },
])(
  "invalid windows, bounds or write arguments fail before any request: %j",
  async (extra) => {
    expect((await list(extra)).code).toBe("invalid_input");
    expect(sent).toEqual([]);
  },
);

test("every Graph request is a read", async () => {
  await list();
  await list(window);
  expect(sent.length).toBe(2);
  expect(sent.every((request) => request.method === "GET")).toBe(true);
});
