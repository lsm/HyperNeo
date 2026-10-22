# Current worker identity on every read

The additive descriptor is `worker: {id, adapter, name, label, daemon?}`. `name` is
current or null when unavailable; `label` is always `<engine> · <name ?? id>`.
Only an unbound todo has `worker: null`. Notices always retain a descriptor from
their ref. Older daemons may omit the field; explicit null never means use an old
name. IDs/refs address workers; display names never identify them. Current dev removes
the old restart/compaction seed path; this change preserves that removal.

`workerEngine` in `packages/shared/src/types/worker-identity.ts:22` is the sole
mapping: codex-desktop → Codex; claude-code/claude-desktop → Claude;
copilot-cli/copilot → Copilot; opencode → OpenCode; hyperneo → HyperNeo; space →
Space. Unknown adapters retain their raw adapter string, including object keys.

## Inventory

These are source locations in this change, not proof of native iOS rendering.

| Surface | Projection and rendering |
| --- | --- |
| Work cards / todo worker rows | `neo/ask-entries.ts:114` joins todo links; `neo/operations.ts:397` resolves current worker records; web `NeoAskTodos.tsx:162` renders the label separately from the task title. |
| Open session pane | web `NeoLive.tsx:50` stores only the ID; `NeoSessionPane.tsx:177` reads the latest `state.session.worker.label`. |
| Neo snapshot | `neo/operations.ts:431` adds `session`; `neo/working.ts:20` adds `working[].worker` from the session row, preserving project titles. |
| Session state | `state-projection-service.ts:383` and `:466` project `worker`, including fallback broadcasts, from current session storage. |
| Todo/ask receipts and done pages | `neo/todo-operations.ts:273`, `neo/ask-record-operations.ts:122`, and `neo/ask-entries.ts:228` use `NeoService.todoWorkers` (`neo/service.ts:423`). |
| Notices | `neo/session-watch.ts:142` captures event titles; `neo/session-watcher.ts:314` stores historical groups. `neo/operations.ts:403` replaces titles, workers and group lines at snapshot read; web `NeoPublicConversation.tsx:317` renders the descriptor. |
| Work discovery, near matches and status/start receipts | `drivers/find-operation.ts:184` / `:289` and `drivers/work-operations.ts:405` add descriptors from current adapter/work records. Claude CLI history keeps its search titles; current names are refreshed from live owner metadata or marked unavailable. Concurrent reads share only the in-flight owner lookup, never a completed-name cache. |
| Daemon inventory / inspection | `inventory/snapshot-operation.ts:79` adds session-entry workers; `inventory/session-inspection.ts:117` adds `resource.worker`; both read current rows. |
| “From another session” context header | `messaging/message-send.ts:345` awaits only the display-name callback; `operations/database-catalog.ts:96` reads the current record. `messaging/session-envelope.ts:24` escapes that label; routing, body and authority note remain unchanged. |
| Recorded from/to names | `neo/session-messages.ts:20` stores historical values; `neo/service.ts:436` replaces both names for snapshot and `neo.conversation.read` rendering. |

All daemon paths above are under `packages/daemon/src/lib/`; web paths are under
`packages/web/src/neo/`. Shared types are in `types/worker-identity.ts`,
`types/neo-ask.ts`, `types/neo-snapshot.ts`, `state-types.ts` and
`types/daemon-snapshot.ts` under `packages/shared/src/`.

The sanctioned socket's `message.send` still rejects an external Codex target as
`Unknown session` at `messaging/message-send.ts:285`: it looks for a native
session row. This task changes sender display only and does not fix delivery.

## Repeatable proof

Build web with `cd packages/web && bun run build`. Back at the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-worker-identity-XXXXXX)
NODE_PATH=<directory-containing-playwright> \
  VERIFY_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  bash .claude/skills/verify/worker-identity.sh 9392 "$RUN"
```

This uses the shared metadata-only daemon setup. It seeds only a synthetic
Codex DB/rollout, native Neo, todo and two notices. Actual WebSocket RPC reads
`neo.snapshot`, `work.find`, `work.status`, `state.session` and `daemon.snapshot`.
It renames only the fixture records and proves the next read changes the name
without changing ID or engine. A missing worker keeps its ID and a null name.
Finally it checks the actual queued session-message headers, including a missing native `neo:` sender retaining its full ID. Ten synthetic Claude history records use a fixture `claude agents --json` executable on the daemon’s PATH. Actual RPC search retains historical titles, returns null current names, preserves exact/near matching, and logs one CLI process per batch with a fresh read on the next batch. No model is called.
The helper stops and waits for its daemon even on failure. Retain the run.

Headless Chrome drives real `/neo` at 1280×900 and 390×900, opens the mobile work
sheet, waits for finite animations and viewport bounds, then captures the card.
Inspect `evidence/worker-{verify,renamed}-{1280,390}.png` and `web-*.json`.
`rpc-*.json` contains the real replies. Browser layout/labels, not a DOM assertion
alone, must be readable with no horizontal overflow.

For the baseline commit, use the same updated fixture/check/browser helpers and
pass `reproduce` as the shell helper's third argument. It asserts the missing
worker field and missing card label, retaining RPC and before screenshots. The
fixture schema includes Codex `projects.updated_at_ms`, which discovery needs.
No real application renames, credentials, provider API, live daemon, external
Codex-target delivery, native iOS UI or model behavior are verified here.
