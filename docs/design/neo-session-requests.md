# A session's request to Neo stays tracked until its work is done

Status: proposal, 2026-11-16. Design only. Builds on `neo-attention.md` and on the request
todo added in #10756 and #10766. Paths without a prefix are under
`packages/daemon/src/lib/neo/`.

## Why

When another session sends Neo a request, parts of it can get lost. For example, a
session asks Neo to label a pull request, review another and plan a follow-up. Neo
replies, starts the first item and closes the request, and the other two are never
tracked anywhere.

A stronger model would miss less often, but nothing in the system stops a miss or
shows it. Three facts in the code allow it:

1. **Done means "replied".** `recordNeoRequestTodo` (`request-todo.ts`) records one todo
   per request with `doneWhen: "Neo replied to session … and closed this todo"` and no
   check, and `neo.todo.done` refuses nothing (its tool text says so). Neo can close the
   whole request after its first reply.
2. **One request is one todo.** A message with four items still gets a single todo.
   Splitting it is left to Neo, and nothing compares the split with the message.
3. **The work is not on the request's ask.** Neo is never told the request's ask id: the
   `<session-message>` envelope carries only the sender (`packages/daemon/src/lib/messaging/session-envelope.ts`).
   `neo.todo.add` needs `input` (a `<human-message>` id) or `askId`, so Neo files the work
   under some other ask or a new one. The request's ask then settles while its work is
   still running elsewhere, or missing.

## The design

Three small changes, all in the daemon. No new table, state or operation.

**1. The request names its ask.** When the daemon records a request, it delivers the
`<session-message>` with one more attribute, `ask="<id>"`: the request ask's id, which is
already derived from the incident before delivery (`neoDerivedId('neo-request-ask:…')`).
`neo.todo.add` and `neo.question.ask` already accept `askId` and route to it
(`resolveNeoInputAsk` in `input-ask.ts`). Their `askId` description gains one sentence:
for a request from a session, pass the `ask` on its `<session-message>` tag. The work and its
cards then sit on the request's ask, and the existing settle rule
(`requireNeoAskTurnedSettle` in `packages/daemon/src/storage/repositories/neo-ask-settlement.ts`) keeps that ask
open until every todo on it has finished.

**2. The sender sees the split.** When Neo closes the request todo, the reply the daemon
already queues (`queueNeoRequestReply`) lists every other todo on the ask by id and title,
or says that no todo was added. Nothing else checks the split, because only the
sender knows what it asked. A message with four items and a reply listing three makes the
missing one visible at once, whichever model Neo runs.

**3. The sender hears the end.** When a request's ask settles with todos besides the request
todo, the daemon queues one more reply on the same `neo.request.reply` queue: each todo's
final state and reason. It uses its own idempotency key (`neo-request-settled:<askId>`), so
the close reply and the end reply are both delivered once. An ask whose only todo is the
request todo sends nothing more: the close reply already said nothing was added.

## What stays

- `neo.todo.done` still refuses nothing. The request todo still wakes Neo through the
  attention ladder until it is closed.
- Human requests, worker reports and worker questions keep their paths: a sender that works
  an open todo records no request todo, as today.
- Only a session message of kind `question` or `blocked` is a request
  (`handleWorkerQuestion` in `service.ts`). Other kinds stay notices without a request todo,
  so a session that wants something done sends it as `question`.
- The sender may still ask again; a closed request is refused as today
  (`request_closed`).

## Change plan

Each slice is one PR from `dev` (the repository's default and target branch), failing tests
first. `bun run system-map impact` on the touched files: `session-envelope.ts` has 6
importers, and the attribute is optional, so no importer is forced to change. `request-todo.ts` has 4
importers: `service.ts` and `packages/daemon/src/lib/rpc-handlers/index.ts` deliver the reply, and
`neo-ask-todo-repository.ts` and `neo-todo-mutation-commit.ts` (in `packages/daemon/src/storage/repositories/`) queue it with the todo and the
database. No importer is forced to change; the planned `service.ts` edits are in the slices below. The settle reply is added where the ask is settled.

1. **The ask on the envelope.** `service.ts` passes the request ask id to the envelope for a
   recorded request; `session-envelope.ts` writes the optional attribute; the `askId` text in
   `todo-operations.ts` and `question-operations.ts`. About 40 production lines.
2. **The two replies.** The close reply lists the ask's todos (`request-todo.ts`); the
   settle reply on the same queue with its own key (`packages/daemon/src/storage/repositories/neo-ask-settlement.ts`,
   `service.ts` `deliverRequestReply`). About 80 production lines. Checkpoints: cover both
   settle paths in `packages/daemon/src/storage/repositories/neo-ask-settlement.ts`, the explicit settle and the automatic turned
   settle. Keep the settle reply distinct from the close reply through enqueue dedup
   (`queueNeoRequestReply` matches on `todoId`), the send's idempotency key and the
   deferred re-enqueue in `deliverRequestReply`.

Acceptance, as tests on the pure functions and one integration case per row:

| Case | Expected |
|---|---|
| A session sends a request | the delivered `<session-message>` carries `ask` equal to the recorded request ask |
| A worker of an open todo reports | no `ask` attribute and no request todo (unchanged) |
| Neo adds two todos with that `askId`, then closes the request todo | the sender gets one reply naming both todos; the ask stays open |
| Both todos finish | the ask settles and the sender gets one reply with both final states |
| Neo closes the request todo with nothing added | the reply says no todo was added; no settle reply follows |
| The settle sweep runs again | no second settle reply |

## Risks

- **Neo ignores the attribute.** Its work lands elsewhere and the close reply says no todo was
  added, so the sender sees it and asks again. That miss is visible instead of silent.
- **More messages to senders.** At most two replies per request: one when it is split, one
  when it ends.
