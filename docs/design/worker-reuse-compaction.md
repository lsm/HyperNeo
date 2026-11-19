# Keep free workers by the reuse setting, compacted while the cache is warm

Status: proposal, 2026-11-19. Design only. Builds on `session-reuse.md`. Paths without a
prefix are under `packages/daemon/src/lib/`.

## Why

- **Release ignores `sessionReuse`.** When a todo finishes, `neo/todo-release.ts` archives
  its worker if it is clean, pushed, owned and not bound to another live todo. It never
  reads `sessionReuse`, so under `long_lived` and `per_ask` a free worker is usually gone
  before the next start can reuse it. Most workers end up serving one ask.
- **A reused worker carries its whole history.** The next ask pays for every earlier turn,
  on every call.
- **Compacting later costs more.** A prompt cache lives minutes to hours after the last
  turn. Compacting while it is warm reads the history at the cached rate; compacting at the
  next start usually pays the full rate.

## The design

One superpipe, `neo.todo.release-worker`, decides what happens to a worker the moment it
becomes free: its last todo is `done` or `removed` and no other live todo is bound to it.
The existing keep rules run first, unchanged: named by the human, bound to a live todo, not
started by us, remote, unknown, dirty or unpushed folder. Then:

| `sessionReuse` | Free worker |
|---|---|
| `per_todo` | released and archived, as today |
| `per_ask` | kept and compacted while its ask is open; released when the ask settles |
| `long_lived` | kept and compacted; at most one kept per folder and harness, older ones released |

The decision is code. No prompt tells Neo or the worker to compact.

**`compact` on the adapter.** `WorkAdapter` gets an optional
`compact(ref, context) => Result<{ compacted: boolean }>`. It runs only when the worker is
idle.

| Harness | How |
|---|---|
| daemon session | the existing internal `/compact` queue (`agent/context-budget-enforcement.ts`) |
| Codex (desktop, app server) | `thread/compact/start { threadId }` |
| Claude Code (desktop, CLI) | send `/compact`, only if a test proves it compacts; otherwise unsupported |

A harness without `compact` keeps today's behaviour: the worker is released.
`work_started_sessions.compacted_at` records the compaction, so a worker is compacted once
per free period.

**Cache window (step 2).** `WorkDetail` gets `cacheUntil`: the end of the last turn plus
the cache lifetime of its last write. The adapter reads it from the harness where it can.

| Harness | Lifetime |
|---|---|
| Claude | `usage.cache_creation`: `ephemeral_1h_input_tokens > 0` → 1 h, else 5 min |
| Codex | 30 min (no TTL is requested, so the API default applies) |
| other providers | 1 h until measured |

One more pipe before `compact`: when `now > cacheUntil`, the worker is released instead,
because compacting a cold history costs about as much as starting fresh.

## Change plan

Five PRs from `dev`, failing tests first.

1. **Release follows `sessionReuse`.** The table above, without compaction.
2. **`compact` on adapters.** Daemon sessions and Codex first; Claude only with the test.
3. **Compact kept workers.** `compacted_at`, and a call to `compact` in the kept branch.
4. **`cacheUntil` on `WorkDetail`.** For Claude, Codex and daemon sessions.
5. **Cache pipe.** A cold worker is released instead of compacted.

## Acceptance

| Case | Expected |
|---|---|
| `per_todo`, todo done, folder clean | archived, as today |
| `long_lived`, todo done, folder clean | kept, compacted once, reused by the next start in the folder |
| `long_lived`, two free workers in one folder and harness | the newer kept, the older released |
| `per_ask`, step done, ask open | kept and compacted; the next step reuses it |
| `per_ask`, ask settled | released |
| a harness without `compact` | released |
| dirty folder or human-named session | kept, as today |
| last turn ended past `cacheUntil` | released, not compacted |
