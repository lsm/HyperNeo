# Neo simplify

Status: the human's decision of 2026-10-18. Details such as tables, operation names and acceptance checks belong in each implementation PR, not here.

## The core

Neo is one session that holds the whole conversation. It listens to the human, decides, and hands work to an executor. Each item it hands off is in one of four states:

- **doing**: the executor is working on it;
- **done**;
- **failed**: an error the executor can't recover from;
- **blocked**: stuck, or waiting for a question to be confirmed.

Only a change to done, failed or blocked wakes Neo. Neo then tells the human or plans the next step; it ignores the progress in between.

All state lives in the database, so a restart or a compaction loses nothing. Everything Neo receives is visible in its own session: nothing is injected at send time, and anything the daemon adds is written into the stored message.

## What a pack provides

The core knows nothing about any one kind of work. A pack supplies the four things the core needs:

- **Done.** How to judge that an item is done.
- **Progress.** How the pack's own progress events are handled. For example, they can go straight to the executor and never reach Neo.
- **Failed and blocked.** What counts as each, including a no-progress timeout that turns an item blocked.
- **Status line.** The line each item's card shows, so the human sees the current state without asking Neo.

## The coding pack, the first example

- **Done** is a merged pull request.
- **Progress** is CI and review events. They go straight to the working session.
- **Failed** is a pull request closed without merging.
- **Blocked** is a CI check that keeps failing, or no progress past a deadline.
- **Status line.** The card shows the pull request's current state.

The pack keeps its own PR ledger: one row per pull request, kept current from GitHub. It also runs its own deadline sweep, which re-tells the working session before anything turns blocked.

## Deletions

These go. Most existed only because there were several Neo sessions; the send-time injections break the core rule that nothing is added at send time.

- the router and the route classifier;
- the per-project holder sessions and their bindings;
- ask ownership by session;
- forwarding and consultations between sessions;
- the send-time injections:
  - the catch-up view;
  - the project snapshot;
  - the hook that adds the human's local time as each message is sent (the `UserPromptSubmit` hook in `restrictNeoQuery`, `session-policy.ts`). The local time is written into the stored message when the message arrives, next to the quoted-message fact.

## Build order

1. Make Neo one session, and add a restart control that keeps the database state.
2. Remove the send-time injections, and write the local time into the stored message on arrival.
3. Add the four states, the core's wake rule, and the pack interface.
4. Port the coding pack onto it: the ledger, then progress sent to the working session, then the sweep and the status line.
5. Delete the router, holders, ownership, forwarding and consultations.
