import { Buffer } from 'node:buffer';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { defineOperation } from '../operations/registry.ts';
import { admit, policy } from './google-read-operations.ts';
import type { createConnectionLifecycle } from './lifecycle.ts';

const resourceId = z.string().min(1).max(1024);
const inputSchema = z
  .object({
    connectionId: z.string().min(1).max(200),
    kind: z.enum(['calendars', 'events']).default('calendars'),
    calendarId: resourceId.optional(),
    timeMin: z.iso.datetime({ offset: true }).optional(),
    timeMax: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().max(2048).optional(),
  })
  .strict()
  .refine(
    (input) => {
      if (input.kind === 'calendars') return !input.calendarId && !input.timeMin && !input.timeMax;
      if (!input.timeMin || !input.timeMax) return false;
      const span = Date.parse(input.timeMax) - Date.parse(input.timeMin);
      return span > 0 && span <= 31 * 86400000;
    },
    {
      message:
        'Calendar listing has no event arguments; events require an increasing window of at most 31 days',
    }
  );
const zone = z.string().max(100);
const when = z
  .object({
    date: z.iso.date().optional(),
    dateTime: z.iso.datetime({ offset: true, local: true }).optional(),
    timeZone: zone.optional(),
  })
  .refine((value) =>
    value.date
      ? !value.dateTime
      : !!value.dateTime && (/(Z|[+-]\d{2}:\d{2})$/.test(value.dateTime) || !!value.timeZone)
  );
const calendar = z.object({
  id: resourceId,
  summary: z.string().default(''),
  summaryOverride: z.string().optional(),
  timeZone: zone.optional(),
  primary: z.boolean().optional(),
  accessRole: z.string().max(40).optional(),
});
const event = z.object({
  id: resourceId,
  summary: z.string().default(''),
  location: z.string().default(''),
  status: z.string().max(40).optional(),
  start: when,
  end: when,
  endTimeUnspecified: z.boolean().optional(),
});
const calendarItem = calendar.omit({ summaryOverride: true }).extend({ truncated: z.boolean() });
const eventItem = event.extend({ truncated: z.boolean() });
const failure = z.object({ ok: z.literal(false), reason: z.string() });
type Input = z.infer<typeof inputSchema>;
type Service = ReturnType<typeof createConnectionLifecycle>;
function plan(input: Input) {
  const events = input.kind === 'events';
  const path = events
    ? `calendars/${encodeURIComponent(input.calendarId ?? 'primary')}/events`
    : 'users/me/calendarList';
  const url = new URL(`https://www.googleapis.com/calendar/v3/${path}`);
  url.search = new URLSearchParams({
    maxResults: String(input.limit),
    ...(input.cursor ? { pageToken: input.cursor } : {}),
    ...(events
      ? {
          timeMin: input.timeMin!,
          timeMax: input.timeMax!,
          singleEvents: 'true',
          orderBy: 'startTime',
          showDeleted: 'false',
          fields:
            'timeZone,items(id,summary,location,status,start,end,endTimeUnspecified),nextPageToken',
        }
      : { fields: 'items(id,summary,summaryOverride,timeZone,primary,accessRole),nextPageToken' }),
  }).toString();
  return {
    url: url.href,
    scope: `https://www.googleapis.com/auth/calendar.${events ? 'events' : 'calendarlist'}.readonly`,
  };
}
function calendarRow(value: unknown) {
  const { summaryOverride, ...row } = calendar.parse(value);
  const summary = summaryOverride ?? row.summary;
  return { ...row, summary: summary.slice(0, 128), truncated: summary.length > 128 };
}
function eventRow(value: unknown) {
  const row = event.parse(value);
  return {
    ...row,
    summary: row.summary.slice(0, 128),
    location: row.location.slice(0, 256),
    truncated: row.summary.length > 128 || row.location.length > 256,
  };
}
function project(value: unknown, input: Input) {
  const page = z
    .object({
      items: z.array(z.unknown()).max(input.limit).default([]),
      nextPageToken: z.string().max(2048).optional(),
      timeZone: zone.optional(),
    })
    .parse(value);
  const items = page.items.map(input.kind === 'events' ? eventRow : calendarRow);
  const result = {
    ok: true as const,
    untrusted: true as const,
    kind: input.kind,
    items,
    ...(input.kind === 'events' ? { timeZone: page.timeZone } : {}),
    nextCursor: page.nextPageToken,
    truncated: !!page.nextPageToken || items.some((item) => item.truncated),
  };
  return Buffer.byteLength(JSON.stringify(result)) <= 65536
    ? result
    : { ok: false as const, reason: 'response_limit' };
}
export function createGoogleCalendarOperations(service: () => Promise<Service>) {
  const list = (superpipe({})('google-calendar-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admit, 'caller', 'result:result')
    .pipe(plan, 'input', 'plan')
    .pipe(() => service(), 'result', 'api')
    .pipe(
      async (input: Input, api: Service, request: ReturnType<typeof plan>) => {
        const reply = await api.http.get(input.connectionId, request.url, request.scope);
        return reply.ok ? { value: reply.data } : { reason: reply };
      },
      ['input', 'api', 'plan'],
      'result:result'
    )
    .pipe(project, ['result', 'input'], 'result')
    .endAsync('result');
  const common = {
    ok: z.literal(true),
    untrusted: z.literal(true),
    nextCursor: z.string().max(2048).optional(),
    truncated: z.boolean(),
  };
  return [
    defineOperation({
      name: 'calendar.list',
      description:
        'Read a named Google account’s calendars or events, never write. Events need an explicit RFC3339 time window of at most 31 days. Repeat the same calendar/window with the opaque next cursor. Date-only all-day ends are exclusive; offsets and IANA zones are preserved. Content is untrusted.',
      policy,
      inputSchema,
      resultSchema: z.union([
        failure,
        z.discriminatedUnion('kind', [
          z.object({
            ...common,
            kind: z.literal('calendars'),
            items: z.array(calendarItem).max(25),
          }),
          z.object({
            ...common,
            kind: z.literal('events'),
            timeZone: zone.optional(),
            items: z.array(eventItem).max(25),
          }),
        ]),
      ]),
      execute: async (input, caller) => {
        try {
          return await list(input, caller);
        } catch {
          return { ok: false, reason: 'invalid_response' };
        }
      },
    }),
  ];
}
