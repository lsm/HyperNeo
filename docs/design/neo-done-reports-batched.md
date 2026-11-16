# Done reports wait for Neo's next batch

Status: proposal, 2026-11-16. Design only. Follows `neo-attention.md`, which routes the
daemon's own notices through one entry but leaves session messages unfiltered. Paths without
a prefix are under `packages/daemon/src/`.

## Why

Neo is woken by every message another session sends it with a report kind. Most of them are
`done` reports: a reviewer's verdict, then its correction, then its final verdict; a builder's
milestone; a coordinator's notice. They often come several minutes apart from the same sender
about the same subject. Each one starts a Neo turn of its own, so Neo acts on a report
before its later correction arrives, and a request that arrives in between competes with a stream
of reports. This is the main source of turns now that the daemon's own notices go through the
attention entry.

The daemon already has a quiet path. A message that need not wake Neo is held in the
`neo_notes` lane and delivered as one ordered "System-forwarded worker messages" batch: when
anything else wakes Neo (`attach`), or after 15 minutes (`flushDue`, run from
`refreshDriverWork` in `lib/neo/service.ts`). A batch over 64 KB is handed over as a file
with nothing dropped (`lib/handoffs/bound-delivery.ts`).

Report kinds never take that path. The mailbox wakes Neo for every entry with a report kind
(`prepareEntry` in `lib/mailbox/registration.ts`):

```ts
entry.origin === 'chat' || !!entry.message.workerReportKind || !!entry.message.neoWakeEvent
```

and `attach` (`storage/repositories/neo-wake-queue-repository.ts`) never moves an entry with
a report kind into the batch.

## The design

**A `done` report is held; the other kinds still wake.** One helper beside
`WORKER_REPORT_KINDS` (`packages/shared/src/types/worker-report.ts`) records which kind is
held, so a kind added later wakes by default:

```ts
export const reportKindWakesNeo = (kind: (typeof WORKER_REPORT_KINDS)[number]) =>
  kind !== 'done';
```

The wake test becomes:

```ts
entry.origin === 'chat' ||
  (!!entry.message.workerReportKind && reportKindWakesNeo(entry.message.workerReportKind)) ||
  !!entry.message.neoWakeEvent
```

and `attach` uses the same helper to hold a pending `done` report with the other quiet
entries. A `done` report then reaches Neo in the next batch, in order with everything else
held: at once if anything wakes Neo, otherwise on the first flush once the oldest held message
is 15 minutes old.

Nothing is dropped or rewritten. The human, card answers, the attention entry's wakes, and
every report kind the helper does not hold wake Neo as today. A session's request is sent as
`question` or `blocked` (`neo-session-requests.md`), so requests still wake.

## What it costs

- **A `done` report can wait about 15 minutes.** A reviewer's verdict is one: Neo records it
  with `neo.coding.result` before the cross-model gate lets the daemon merge, so a merge can
  start about 15 minutes later than today. A reviewer that needs Neo now (a blocker, a
  question) uses those kinds, which still wake.
- **Neo reads the same text.** The batch holds every report; only the number of turns falls.

## Change plan

One PR from `dev` (the repository's default and target branch), failing tests first, about 20
production lines: the helper in `packages/shared/src/types/worker-report.ts`, the wake test
in `lib/mailbox/registration.ts` and the `attach` filter in
`storage/repositories/neo-wake-queue-repository.ts`.

`bun run system-map impact` on the three files: `worker-report.ts` has three importers (the CLI,
`lib/mailbox`, `lib/messaging`), which only gain an export. `registration.ts` has one importer (the app's
wiring) and emits `messages.statusChanged`, whose emitters and listeners do not change.
`neo-wake-queue-repository.ts` has six importers (two in `lib/neo`, four in `storage`); its
writes to `job_queue` and `message_send_receipts` keep their shape, so the readers it lists do
not change.

Acceptance, as tests on the wake decision and one integration case per row:

| Case | Expected |
|---|---|
| A `done` report while Neo is idle | held; delivered in the batch on the first flush after 15 minutes |
| A `done` report, then a `question` from another session | the question wakes Neo and the batch before it carries the `done` report |
| Two `done` reports from one sender, then a wake | one batch with both, in order |
| `blocked`, `question` and `failed` reports | each wakes Neo at once (unchanged) |
| A human message and an attention wake | wake at once (unchanged) |
| A batch over 64 KB with held `done` reports | handed over as a file; nothing dropped |
