# Smaller worker context, fewer empty PR notices

Status: proposal, 2026-11-25. Design only. Items 1 and 2 of #11728.

## Why

Every model request re-reads the whole conversation. Over one week and 762 merged pull
requests, that re-reading was about 70% of the cost of a PR, at a median of 233k (Claude)
and 160k (Codex) tokens per request. Work before this one compacts a worker before its next
todo (`session-reuse.md`); nothing limits growth inside one todo, so a long todo, or review
rounds after the PR opens, run at whatever limit the machine or the model has.

## 1. A compaction limit on every worker

One constant, `WORKER_COMPACT_AT = 200_000` tokens, applied when the daemon starts a worker.
Each harness compacts by itself at that size, between requests; the daemon adds no trigger
and no state. A lower limit already in force (a smaller model window, a model's own compact
percent) stays; a higher one is replaced for workers only.

| Harness | Where it is set |
|---|---|
| HyperNeo session | `autoCompactWindow` in the session config (`deps.sessions.create` in `hyperneo-adapter.ts`), the limit plus the SDK reserve (`autoCompactReserveTokens`) |
| Codex | `model_auto_compact_token_limit` in the `config` of `thread/start` (`codex-desktop-adapter.ts`) |
| Claude Desktop, sandboxed worker | `autoCompactWindow` in the worker's own `.claude/settings.local.json` (`policy` in `claude-native-writes.ts`), limit plus reserve |
| Claude Desktop, unsandboxed; Copilot, Antigravity, Cursor | unchanged: the daemon has no setting of its own there and must not write the human's files |

Sessions the human started, and Neo's own session, are not touched.

**Why 200k.** Replaying the same week's worker sessions with a limit, charging each
compaction its summary, the rewritten prefix and four extra reading rounds:

| Limit | Claude | Codex | Compactions (Claude + Codex) |
|---|---|---|---|
| 300k | -20% | -16% | 205 |
| **200k** | **-28%** | **-27%** | **433** |
| 150k | -29% | -34% | 853 |
| 120k | -27% | -36% | 1519 |

200k takes most of the saving with half the compactions of 150k. It is a replay, not an
experiment: it cannot show work that a summary loses.

**Proof.** In an isolated daemon, start one worker per harness in the table with the limit
lowered by the test, grow it past the limit, and record that it compacted and finished the
todo. Codex must prove it after its thread is handed to Codex Desktop; if Desktop drops
the value, leave Codex out and say so here. A week after release, compare the
same numbers and review rounds per PR; revert if review rounds rise.

## 2. No notice that needs no action

Of the daemon's PR notices, two almost never lead to a push:

- **The second merge notice.** A PR the daemon merges sends "Merge confirmed" and then "was
  merged" to the same worker (271 of 311 merges). The daemon merge receipt cannot decide
  this: it is also marked notified when the worker could not be reached and Neo was woken
  instead. So the fact is recorded per recipient, with the per-owner receipt that failing
  reviews already use (`reviewSent` / `markReview`, keyed by event and owner): when `notify`
  in `daemon-merge-sweep.ts` delivers "Merge confirmed" to the owner, and only then, it marks
  the `merged` event of that PR and head as sent to that owner. `deliverCodingPrEvents` reads
  that receipt for `merged` as it does for `failing`, and accepts the event without telling.
  Every other case has no receipt and still sends "was merged": owner delivery failed and Neo
  was woken, the owner changed in between, a crash before the mark, a merge by hand.
- **The reminder while CI runs.** `waiting_ci` and `approved_pending` no longer remind the
  owner (one push in 80 reminders). If CI fails, `failing` still tells the owner at once.
  The last step still goes to Neo, so a stuck check is not lost.

Left alone on purpose: requested changes, failing CI, conflicts (67-72% lead to a push) and
"waiting for review" (half of those turns re-request the review).
Waiting for CI and review together before telling the author is not worth building: both
fired on the same head for 12 of 373 heads.

This part is small, about 1% of the cost. It is here because it removes code paths that
only spend.

## Changes

Two PRs from `dev`, no migration, no new setting.

1. The limit: one exported constant and the three places above.
2. The notices: `planCodingPrNudge` skips the owner reminder for the two states and keeps the
   escalation; `notify` marks the per-owner receipt and `deliverCodingPrEvents` reads it. Tests
   through the real sweep order: a daemon merge told to the owner sends one notice; **owner
   delivery fails and Neo's wake succeeds, then the owner is reachable: the owner gets "was
   merged" once**; an owner changed after "Merge confirmed" gets "was merged"; a hand merge
   sends one; pending CI sends no reminder and still escalates.
