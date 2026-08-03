# #2338 — Conversation-turn compaction for `spaceTaskMessages.byTask.compact`

Status: **chosen / in progress** · Issue: [#2338](https://github.com/lsm/HyperNeo/issues/2338) · Blocked-on: #2330 (resolved, PR #2346)

## TL;DR

Opening a heavy task thread (~42k messages) costs ~633 ms warm, CPU-bound. The
compact feed runs **6 window-function passes** over every message to compute a
**result-bounded** turn model that (a) is far more expensive than needed and
(b) **swallows user messages sent mid-turn**. We replace it with a single,
**conversation-bounded** turn model (turns delimited by user messages), backed
by a materialized `conversation_turn_index` column, plus a recent-turn cap.
Measured: **~44 ms** for recent-100-turns on a 46k-message task (was ~1.3 s).

## Why the current design is wrong (two problems)

### 1. Performance

`SPACE_TASK_MESSAGES_BASE_CTE` + the compact/active-turn variants run 6 window
passes (ROW_NUMBER, MAX forward-fill, SUM ×3, ROW_NUMBER ×2) over **every**
task message, recomputed on every 250 ms-debounced re-evaluation. The base CTE
alone (the `full` query) is ~650 ms — matching the issue's reported 633 ms.

A base-table index does **not** help (verified): SQLite `MATERIALIZE`s the CTEs
and re-sorts for each window pass; indexes can't speed derived row sets. The
issue author's "no index helps" was correct.

### 2. Correctness / UX — mid-turn user messages are swallowed

The compact query pins only the **first** renderable user message per
result-turn (`isInitialUserVisible = userRowRankAsc = 1`). A *second* user
message in the same result-turn survives only if it falls in the last-5
non-terminal tail — otherwise it is dropped from the payload entirely.

Because user messages are timestamped when **sent** (not when the agent
processes them), a human interjecting while the agent is mid-execution produces
multiple user messages that all land **before** the next result — i.e. inside
one result-bounded turn. Only the first survives; the rest vanish from the main
view (reachable only by drilling into the agent session). In a Slack-like
multi-agent conversation view, silently dropping a human's own words is a
serious UX bug, and it is **pre-existing** (today's result-bounded compaction
already does it).

## The new model: conversation turns

The unit of a "turn" in a conversation view is a **user message**, not an agent
result.

### Definition

A **conversation turn** for a session is the run of rows starting at a
renderable user message and extending up to (but not including) the next
renderable user message.

```
anchor = message_type = 'user' AND is_renderable = 1
```

This predicate already encodes the agreed anchor set with **no special-casing**:

| Message kind                            | type   | is_renderable | Anchor?                  |
| --------------------------------------- | ------ | ------------- | ------------------------ |
| Human input                             | user   | 1             | ✅ breaks turn            |
| Agent→agent handoff (`isSynthetic`)     | user   | 1             | ✅ breaks turn (human-eq) |
| `tool_result`                           | user   | 0             | ❌                        |
| events / compaction / hooks / nagging   | system | —             | ❌ (different type)       |

Verified: handoffs are saved as `type:'user'` + `isSynthetic:true`
(`task-agent-manager.ts:3766`, `space-runtime-service.ts:580`); system
categories are `message_type='system'`. `is_renderable` already excludes
tool_result-only user rows (`computeIsRenderable`).

`isSynthetic` is only a **rendering** distinction (handoffs shown with a
distinct style so they read as agent posts, not human typing) — never enters the
turn/compaction logic.

### Result-bounded turns are retired

`turnIndex` (result-bounded) and the dead `turnUserMessageId` forward-fill are
**removed entirely**. This also eliminates the latent `id`-vs-`rowid` tiebreak
inconsistency (`sdk_rows_numbered` ordered by UUID; `turnIndex` by rowid) and
the forward-fill-over-tool_result bug — both moot once the concepts are gone.

## Feed compaction

### Completed / middle segments (not the running turn)

Detail belongs to the *present*; history gets a summary. Each non-running
conversation segment renders as:

```
👤 <user anchor>
   <agent> · <summary>
```

**Summary line — first non-empty wins:**

1. last assistant **text** row → render as a normal assistant reply;
2. else last **thinking** block → render as reasoning (truncated preview);
3. else **last 3 `tool_use`** blocks → render as a compact tool list.

Rendering uses each row's own type as the discriminator (the frontend already
renders `text` / `thinking` / `tool_use` distinctly), so users can tell a
summary line is reasoning or tool activity, not a plain reply. Thinking/tool
previews are truncated (reuse the roster's preview helper). `last 3 tool calls`
is a constant.

**Result row:** appended **only when the segment actually has one** (truly
completed turns). Middle/in-flight segments (bounded only by the next user
message, no result yet) get none. So:

- truly-completed segment → `[anchor] + [summary] + [result]`
- middle segment → `[anchor] + [summary]`

### Running segment → live roster

The single running conversation segment keeps full granularity (tool_use / text
/ thinking) as the live roster — unchanged from today's active roster UX.

## Active roster definition (was result-bounded, now conversation-bounded)

Without result-bounding, "active/running" is redefined cleanly per session:

> **The active roster turn = the conversation turn containing the session's most
> recent *agent* (non-user) row. It is *running* if that row is not a result.**

"Where the agent's last bit of work is" = where the agent currently is. This
single rule covers every case:

| Situation                                              | Most recent agent row      | Roster                         |
| ------------------------------------------------------ | -------------------------- | ------------------------------ |
| 5 msgs queued, agent still on msg 1                    | in turn 1                  | turn 1, running; 2–5 queued    |
| Agent did result₁, autonomously continues (one user msg) | in that same turn        | that turn, running             |
| Agent finished, idle                                   | a result                   | not running → no live roster   |

The 5-user-message scenario that broke result-bounding now reads correctly: the
run is sliced into 5 segments by the user messages; the last is the live
roster, the rest are timelined feed turns.

## Materialization

One stored column on `sdk_messages`:

- **`conversation_turn_index INTEGER`** — the **global, per-task** conversation
  turn number (monotonic across all the task's sessions; increments at each
  anchor). Global-per-task (not per-session) so "recent M turns" is one clean
  window across every session and the recent-cap is a simple
  `turn_index >= max - (M-1)`.

No `is_synthetic` column: the hot query never branches on it (human and
synthetic are both anchors via `is_renderable`), the frontend reads
`isSynthetic` from message content during its existing parse, and the roster's
bounded row set can `json_extract` it cheaply. Adding it would be speculative.

### Maintenance — insert-time, rewind-safe

Maintained at insert in `SDKMessageRepository.saveSDKMessage` /
`saveUserMessage`. For a new row on task T (append-only):

- **anchor** (`user` + renderable) →
  `conversation_turn_index = 1 + MAX(conversation_turn_index) WHERE task_id = T`;
- **non-anchor** →
  `conversation_turn_index = COALESCE(MAX(conversation_turn_index) WHERE task_id = T, 0)`.

Both are a cheap indexed `MAX` seek on `(task_id, conversation_turn_index)`;
the daemon is the single writer so there is no race.

**Rewind safety:** rewind does `DELETE FROM sdk_messages WHERE session_id=? AND
timestamp>?` (delete-the-future) then appends. Inserts therefore stay
**append-only relative to survivors**, so the "current max" rule is
self-correcting after a rewind — no special handling, no recompute. (Rewind
references: `sdk-message-repository.ts:1303/1325`.)

### Backfill

Existing rows get `conversation_turn_index` via a one-time global pass: per
task, walk rows in `(timestamp, rowid)` order, running-count of anchors
(`message_type='user' AND is_renderable=1`). Done with a temp table +
`UPDATE … FROM` (SQLite ≥ 3.33; bun:sqlite ships 3.51). This is a real
write-every-row migration (unlike #2330's VIRTUAL column) — one-time, gated by
the standard pre-migration backup.

## Performance: recent-turn cap

The compact feed returns only the **recent M conversation turns** by default
(`conversation_turn_index >= max - (M-1)`). There is intentionally no load-more
param on the compact feed: row-count reduction is what hits the <100 ms target,
and older history is reachable via the unbounded `spaceTaskMessages.byTask`
(full) feed, which serves a separate drill-in surface. (A future load-more
affordance on the compact feed itself is possible but out of scope here.) GitHub
activity rows sit outside the turn model (no `turnIndex`) and are surfaced
unconditionally — they are sparse (state-filtered) and legacy compact showed
them. Both the feed and the roster seek read `conversation_turn_index` directly
— no window passes for turn identity.

### Benchmark (synthetic 46.2k-message task, 4200 turns, terminal/tool-heavy)

Reproduces the issue's cost (baseline `full`/base-CTE = 651 ms ≈ 633 ms).

| Design                                                  | min     | < 100 ms? |
| ------------------------------------------------------- | ------- | ---------- |
| current compact                                         | 1256 ms | ❌          |
| materialize turn_index + turn_user_msg only             | 626 ms  | ❌          |
| + replace SUM windows with GROUP-BY joins               | 444 ms  | ❌          |
| **+ recent-100-turns cap (chosen)**                     | **43 ms** | ✅          |

Returning all ~29k compacted rows has a ~440 ms floor (2 ROW_NUMBER rank
windows + emission); **row-count reduction is mandatory** for the target.
Harness: `packages/daemon/tmp/bench-materialize.ts`.

## Test plan

Existing compact tests assert result-bounded semantics ("keeps last 5
non-terminal per turn", `turnHiddenMessageCount`, first-user-pinned). These are
**rewritten** to conversation-turn semantics:

- every renderable user message survives (no swallow);
- per-segment summary fallback (assistant text → thinking → last 3 tools);
- result row present iff the segment has a result;
- roster = conversation turn of the session's most recent agent row, running iff
  not a result;
- recent-M cap bounds output;
- multi-session independence preserved;
- `conversation_turn_index = anchor-count-so-far` invariant (incl. a test that
  it equals the forward-computed value after a simulated rewind).

Frontend: confirm existing `text`/`thinking`/`tool_use` rendering is distinct
enough to signal "not a plain reply"; add a small label/tweak only if needed.
No frontend change required for anchor visibility (it already splits user rows
out as standalone message turns).
