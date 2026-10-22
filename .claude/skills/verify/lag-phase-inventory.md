# Lag diagnostic phase inventory

Inventory from dev bd7878933e (2026-10-20). Queue names strip any colon-delimited session suffix; logger names retain only
the daemon module prefix, never per-session suffixes. Queue phases are captured centrally
around the existing handler, including asynchronous completion. Those elapsed
times include awaits; they are context, not proof of CPU or blocking time.
A normal 250 ms monitor tick drains the ring. Starts from an older tick do not
survive; a completion during the delayed tick can still name a long operation.
The ring retains at most 512 records per tick; larger bursts discard the oldest
records and disclose `droppedActivities`. A retained asynchronous phase includes
awaited time and cannot by itself attribute an event-loop block.

| Scheduled work | Actual default period | Recorded phase | Owning code |
|---|---|---|---|
| Stranded delivery reconciliation | 60 s per provisioned session | `timer:stranded_deliveries` | `lib/agent/agent-session.ts`, `SESSION_RECONCILE_INTERVAL_MS` |
| Workspace file refresh | 60 s, configurable | `timer:file_index_refresh` | `lib/file-index.ts`, `pollInterval` |
| Codex transcript feed | durable job, 60 s | `job:work.feed.codex` | `lib/drivers/codex-feed.ts`, `scheduleCodexFeed` |
| Claude transcript feed | durable job, 60 s | `job:work.feed.claude` | `lib/drivers/claude-feed.ts`, `scheduleClaudeFeed` |
| Neo session/work status refresh | durable job, 60 s | `job:neo.work.driver.refresh` | `lib/neo/driver-refresh.ts` |
| Codex Desktop scan | on demand, including status refresh | `scanner:codex_desktop` | `lib/drivers/codex-desktop-adapter.ts`, `loadCodexSnapshot` |
| Codex external SQLite | each state read | `scanner:codex_desktop:open/configure/query/close`; snapshot `roots/folders/threads` | `lib/drivers/codex-desktop-adapter.ts`, `readCodexStateOnce`, `readCodexSnapshot`; synchronous spans |
| Codex worktree resolution and grouping | each discovery | `scanner:codex_desktop:worktrees/groups` | `lib/drivers/codex-desktop-adapter.ts`; worktrees includes async I/O, groups is synchronous |
| Worktree pointer metadata/content | lookup when needed | `scanner:worktree:metadata/read` | `lib/drivers/acp-agent-adapter.ts`, `gitWorktreeProject`; async spans, cache validated by metadata |
| Per-adapter local discovery | each work.find | `work:find:<adapter id>` | `lib/drivers/find-operation.ts`, `findLocally`; includes async waits and failures |
| Claude Desktop scan | on demand, including status refresh | `scanner:claude_desktop` | `lib/drivers/claude-desktop-adapter.ts`, `loadClaudeDesktopRecords` |
| Claude Code scan | on demand, including status refresh | `scanner:claude_code` | `lib/drivers/claude-code-adapter.ts`, `scan` |
| Model provider retry | recursive 60 s timeout while pending | `timer:model_provider_retry` | `lib/model-service.ts`, `armProviderRetryTimer` |
| Rate-limit startup retry | 60 s one-shot retry; other cooldowns vary | `timer:rate_limit_retry` | `lib/agent/rate-limit-watchdog.ts`, `scheduleStartupFailureRetry` |
| Copilot stale conversation cleanup | 10 min timeout, reset by activity | `timer:copilot_conversation_expiry` | `lib/providers/anthropic-copilot/conversation.ts`, `scheduleCleanup` |
| Coding pack sweep/reconciliation | durable job, **5 min** | `job:neo.pack.sweep` | `lib/neo/pack-sweep.ts` |
| Coding PR recheck | **10 min cache gate**, no independent timer | enclosing `job:neo.work.driver.refresh` / `job:neo.pack.sweep` | `lib/neo/session-ask-links.ts`, `NEO_SESSION_PR_RECHECK_MS` |
| Coding workspace rules refresh | **10 min cache**, no independent timer | enclosing work/pack job or RPC | `lib/neo/packs/coding/work-prs.ts`, `RULES_MS` |
| Search index flush | **2 s**, not 60 s | `search:index_flush` | `storage/index.ts` |
| Search FTS merge dispatch | **30 s**, worker owns merge | `timer:search_merge_worker_start` | `storage/database-core.ts` |
| GitHub event poll | recursive **120 s** default, configurable/rate limited | `timer:github_event_poll` | `lib/external-events/github/github-event-extension.ts`, `scheduleNextPollAfter` |
| Session schedules and all other durable jobs | per queued run time | `job:<queue>` | `storage/job-queue-processor.ts`, `processJob` |
| SDK settings read/merge/write | each query preparation | `sdk:settings_prepare` | `lib/settings-manager.ts`, `prepareSDKOptions` |
| SDK option assembly | each query attempt | `sdk:options_build` | `lib/agent/query-runner.ts`, `runQuery` |
| SDK flag settings file | each query attempt | `sdk:flag_settings` | `lib/agent/query-runner.ts`, `runQuery` |
| SDK query construction | each query attempt | `sdk:query_create` | `lib/agent/query-runner.ts`, `runQuery` |
| SDK child spawn | each SDK spawn | `sdk:spawn` | `lib/agent/query-runner.ts`, `spawnClaudeCodeProcess` |

SDK settings and option assembly phases include asynchronous waits. A long
settings phase with a responsive loop is expected for slow storage; its duration
alone does not prove blocking. Query construction and child spawn phases isolate
synchronous SDK entry. Names contain no session IDs, settings contents or command
arguments. These phases do not establish the cause of the historical 17:48:36Z
stall; a delayed synthetic settings FIFO reproduces a separate concrete hazard.

Other 10 minute constants are deadlines, not repeating work: event-loop watchdog
startup grace (only arms detection), ACP request timeout and native folder-picker
timeout. TTLs, suppression windows and retry caps do not establish a periodic
loop. The older GitHubPollingService has a 60 s configuration value but owns no
timer; its registered durable job is covered by `job:<queue>`.

The GC observer records native start time, duration and kind on runtimes that
advertise `gc`. Bun 1.4.3 does not advertise it, even though `observe(gc)` accepts
without throwing. Its diagnostics say `gcObservation: unsupported`; absence of
GC entries is not evidence that GC did not happen. `heapBeforeBytes`,
`heapAfterBytes`, `heapDeltaBytes` and `heapBeforeAgeMs` provide a cheap proxy.
A drop supports collection as a hypothesis, not proof of cause. Heap samples
that take over 1 ms disable normal-tick sampling for that monitor instance;
block reports still sample and disclose `blocks_only` and the old sample's age.

FTS worker completion emits `sqlite.worker.lifecycle` only after its SQLite
connection closes: `mergeMs`, `closeMs`, `openedAt`, `closedAt`, and parent
`receivedAt`. The Bun compatibility connection force-finalizes retained statements
before returning from close; worker termination must not defer that owned handle.
The Darwin-only opt-in `HYPERNEO_NATIVE_LAG_PROFILE=1` adds a 100 ms watchdog
heartbeat/check and samples native stacks in the watchdog worker after 1 s of
missed heartbeats. Its trigger timestamp is part of the stack filename; normal
60 s stall actions and startup arming remain separate. See the SQLite worker
closure journey for the isolated delayed-checkpoint proof and capture limits.
