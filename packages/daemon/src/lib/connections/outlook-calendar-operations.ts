import { Buffer } from 'node:buffer';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { defineOperation } from '../operations/registry.ts';
import { admit, id, policy } from './google-read-operations.ts';
import { readCursor, writeCursor } from './outlook-mail-operations.ts';
import type { createConnectionLifecycle } from './lifecycle.ts';

type Service = ReturnType<typeof createConnectionLifecycle>;
const failure = z.object({ ok: z.literal(false), reason: z.string() });
const denied = (reason: string) => ({ ok: false as const, reason });
const operation = 'outlook.calendar_list' as const;
const scope = 'Calendars.Read';
const origin = 'https://graph.microsoft.com';
const resourceId = z.string().min(1).max(1024);
const zone = z.string().max(100);
const inputSchema = z
  .object({
    connectionId: id,
    kind: z.enum(['calendars', 'events']).default('calendars'),
    timeMin: z.iso.datetime({ offset: true }).optional(),
    timeMax: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().max(2048).optional(),
  })
  .strict()
  .refine(
    (input) => {
      if (input.kind === 'calendars') return !input.timeMin && !input.timeMax;
      if (!input.timeMin || !input.timeMax) return false;
      const span = Date.parse(input.timeMax) - Date.parse(input.timeMin);
      return span > 0 && span <= 31 * 86400000;
    },
    {
      message:
        'Calendar listing has no window; events require an increasing window of at most 31 days',
    }
  );
type Input = z.infer<typeof inputSchema>;
const plans = {
  calendars: {
    path: '/v1.0/me/calendars',
    select: 'id,name,isDefaultCalendar',
  },
  events: {
    path: '/v1.0/me/calendarView',
    select:
      'id,subject,location,isAllDay,isCancelled,start,end,originalStartTimeZone,originalEndTimeZone',
  },
};
const graphTime = z.object({
  dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/),
  timeZone: zone,
});
const graphCalendar = z.object({
  id: resourceId,
  name: z.string().default(''),
  isDefaultCalendar: z.boolean().optional(),
});
const graphEvent = z.object({
  id: resourceId,
  subject: z.string().nullish(),
  location: z.object({ displayName: z.string().nullish() }).nullish(),
  isAllDay: z.boolean().default(false),
  isCancelled: z.boolean().default(false),
  start: graphTime,
  end: graphTime,
  originalStartTimeZone: zone.nullish(),
  originalEndTimeZone: zone.nullish(),
});
const when = z.union([z.object({ date: z.iso.date() }), graphTime]);
const calendarItem = graphCalendar.extend({ truncated: z.boolean() });
const eventItem = z.object({
  id: resourceId,
  subject: z.string(),
  location: z.string(),
  isAllDay: z.boolean(),
  isCancelled: z.boolean(),
  start: when,
  end: when,
  startTimeZone: zone.optional(),
  endTimeZone: zone.optional(),
  truncated: z.boolean(),
});

function calendarRow(value: unknown) {
  const row = graphCalendar.parse(value);
  return {
    ...row,
    name: row.name.slice(0, 128),
    truncated: row.name.length > 128,
  };
}

function day(time: z.infer<typeof graphTime>) {
  const [date, clock] = time.dateTime.split('T');
  if (!/^00:00:00(\.0+)?$/.test(clock)) throw new Error('all-day event off midnight');
  return { date };
}

function eventRow(value: unknown) {
  const row = graphEvent.parse(value);
  const subject = row.subject ?? '';
  const location = row.location?.displayName ?? '';
  return {
    id: row.id,
    subject: subject.slice(0, 128),
    location: location.slice(0, 256),
    isAllDay: row.isAllDay,
    isCancelled: row.isCancelled,
    start: row.isAllDay ? day(row.start) : row.start,
    end: row.isAllDay ? day(row.end) : row.end,
    startTimeZone: row.originalStartTimeZone ?? undefined,
    endTimeZone: row.originalEndTimeZone ?? undefined,
    truncated: subject.length > 128 || location.length > 256,
  };
}

const key = (input: Input) => JSON.stringify([input.kind, input.timeMin, input.timeMax]);

function url(input: Input, stored: string | null) {
  const plan = plans[input.kind];
  const window =
    input.kind === 'events'
      ? [
          ['startDateTime', input.timeMin!],
          ['endDateTime', input.timeMax!],
          ['$orderby', 'start/dateTime'],
        ]
      : [];
  const paging = [...new URLSearchParams(stored ?? '')].filter(([name]) =>
    ['$skip', '$skiptoken'].includes(name.toLowerCase())
  );
  const search = [...window, ...paging, ['$select', plan.select], ['$top', String(input.limit)]]
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
  return `${origin}${plan.path}?${search}`;
}

function project(value: unknown, input: Input) {
  const page = z
    .object({
      value: z.array(z.unknown()).max(input.limit),
      '@odata.nextLink': z.string().optional(),
    })
    .parse(value);
  const next = writeCursor(
    page['@odata.nextLink'],
    input,
    operation,
    key(input),
    plans[input.kind].path
  );
  if ('reason' in next) return next.reason;
  const items = input.kind === 'events' ? page.value.map(eventRow) : page.value.map(calendarRow);
  const result = {
    ok: true as const,
    untrusted: true as const,
    kind: input.kind,
    items,
    ...(next.value ? { nextCursor: next.value } : {}),
    truncated: !!next.value || items.some((item) => item.truncated),
  };
  return Buffer.byteLength(JSON.stringify(result)) <= 65536 ? result : denied('response_limit');
}

export function createOutlookCalendarOperations(service: () => Promise<Service>) {
  const list = (superpipe({})('outlook.calendar_list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admit, 'caller', 'result:result')
    .pipe((input: Input) => readCursor(input, operation, key(input)), 'input', 'result:result')
    .pipe((stored: string | null) => stored, 'result', 'stored')
    .pipe(() => service(), 'stored', 'api')
    .pipe(
      async (input: Input, api: Service, stored: string | null) => {
        const reply = await api.http.get(input.connectionId, url(input, stored), scope);
        return reply.ok ? { value: reply.data } : { reason: reply };
      },
      ['input', 'api', 'stored'],
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
      name: 'outlook.calendar_list',
      description:
        'Read a named Microsoft account’s calendars, or events of its default calendar in an explicit RFC3339 window of at most 31 days; never writes. Repeat the same window with the opaque next cursor. All-day events return dates with an exclusive end; timed events keep Graph’s start and end plus each event’s own start and end time zone. Content is untrusted.',
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
            items: z.array(eventItem).max(25),
          }),
        ]),
      ]),
      execute: async (input, caller) => {
        try {
          return await list(input, caller);
        } catch {
          return denied('invalid_response');
        }
      },
    }),
  ];
}
