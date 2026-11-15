# Model lines: a pack that ranks models for work and moves a held todo

Checked against dev 7742b21f62.

## Summary

A "line" is one way to run a model: provider, model, harness and effort. Today a todo's line is fixed when Neo creates it. When that line runs out, the todo fails or waits, and the human's routing wishes live only in free-text standing rules.

This design adds one pack, `models`, with nothing domain-specific in it. It does three things:
1. It ranks candidate lines for a piece of work against the human's structured preferences and each line's current availability. This is a pure function.
2. When a todo's worker is held on a line for longer than the human wants to wait, it tells Neo, together with the ranked alternatives.
3. It gives Neo one safe way to move that todo to another line in the same place.

Other packs name their kinds of work and pass only the candidates they consider eligible. Packs never import each other.

## What exists (dev 7742b21f62)

- A todo's line is fixed at creation (`neo_todo_sessions.target`). Nothing re-reads it after a hold or a failure.
- Usage is already readable by Neo through the transport-neutral `settings.provider.usage` operation, which calls `provider.getUsage()`. Anthropic, the Codex bridge and Kimi implement it.
- A session's hold already records its reason and `retryAt` in its processing state (`rate_limit_cooldown`). `docs/design/model-holds.md` adds typed reasons (`login | limit | overloaded | network`). That part is a dependency, not yet built.
- Coding ranks its own candidates (`stage-preferences.ts`). It applies reviewer eligibility and provenance rules (`codingReviewerPolicy`, `stage-facts.ts`), breaks ties by cross-harness preference, and owns session reuse (`session-strategy.ts`). It declares nine `write|review|verify` × `harness|model|effort` preferences.
- `redispatchTodo` (`todo-runner.ts`) refuses to start a new worker when stopping the old one fails. `rescueTodo` only handles stalled todos and does not stop the old worker or carry state over.
- Routing wishes today live in a free-text standing rule, for example: "spread writing across lines A, B and C; move work off A when its limit runs out; app work goes to B first; D reviews anywhere and writes only in org/tools; E never writes code; on a temporary error, wait in place."

## Facts the pack uses, and who owns them

The pack stores no copy of existing facts. It reads them:
- **A line's hold:** the worker session's own hold state (reason and `retryAt`). This is authoritative.
- **Usage:** `settings.provider.usage` for the line's provider. Usage windows are per account, not per model, so the pack applies them to every line on that account and never stores them.
- **Availability:** whether the provider is configured and signed in, read from the provider registry.

Two questions are kept apart:
- **Eligibility:** is the line configured and signed in? If not, it is skipped.
- **Telemetry:** is there a hold or a usage reading? A line with no hold and no reading, or a provider whose `getUsage` answers `not_supported`, is `usage unknown`. It stays ranked, in its route position, and is marked as such.

Only an observed hold, an exhausted usage window or `stopAtPercent` make an eligible line unavailable. The read step records when it read each usage result, because the result carries no timestamp. A reading older than 15 minutes counts as `usage unknown`.

## Preferences

The first delivery is global scope only. Per-project overrides come later, as a separate change to how preferences resolve scopes.

Three new generic preference types go in core, so any pack can use them. Each is a list whose entries carry their own optional filters, so a repo-specific entry needs no scope change:
- `routes`: entries `{kind, repos?, lines}`, where each line is `{provider, model, harness?, effort?, stopAtPercent?}`. The entry with the most specific match wins: kind and repo, then kind alone.
- `lineRules`: entries `{line, only?: {kinds?, repos?, projects?}, never?: {kinds?, repos?, projects?}}`. Inside one filter, the listed dimensions all must match (and); a missing dimension matches anything. Across entries for the same line: the line may be used where any `only` entry matches (or), and never where any `never` entry matches. `never` wins. A line with no `only` entry may be used anywhere it is not excluded.
- `holdRules`: entries `{reason, line?, action: 'wait' | 'move', afterMinutes}`. An entry with a line beats one without.

| Key | Type | Meaning | Default |
|---|---|---|---|
| `routes` | `routes` | For each kind (and optionally repo), the lines to prefer, in order. `stopAtPercent` stops new work on a line above that usage. | empty: the caller's order |
| `rules` | `lineRules` | Where a line may or may not be used | none |
| `onHold` | `holdRules` | What happens when a todo's worker is held | every reason: `wait` |

`afterMinutes` means: move when the hold has already lasted that long, or when the known reset is further away than that, whichever comes first. With `0`, a matching hold moves at once. Measuring the elapsed time as well means a reset time that keeps sliding cannot make a todo wait forever.

Each line also gets a free-text note, for example "re-reads files and thinks about 3,000 tokens per tool call". Neo reads the notes when it chooses or moves work. A note becomes a structured rule only through the existing preference proposal and the human's yes.

### The example rule as preferences

For the example rule above, the structured part would be:
- `routes`: `coding.write`: A, B, C; `coding.write` for the app repos: B first, then the same list.
- `rules`: D, two entries: `{only: {kinds: [coding.review]}}` and `{only: {kinds: [coding.write], repos: [org/tools]}}`, so reviews anywhere and writes only in org/tools; E: `{never: {kinds: [coding.write]}}`.
- `onHold`: `{reason: limit, line: A, action: move, afterMinutes: 0}`; `overloaded` and `network`: wait.

"Spread" has no structured form. The rule is not retired as a whole: after the human confirms the proposals, it is rewritten to keep only the remaining clauses, and that rewrite also needs the human's yes.

## Decisions (pure)

`rankLines({kind, candidates, scope, prefs, holds, usage, availability, now})` returns:
- `ranked`: the usable candidates, each with a reason (`usage unknown` included). The candidates come from the caller. The matching route's order sorts them, and ties keep the caller's order.
- `skipped`: each skipped candidate with why: not configured or not signed in, held until a time, usage exhausted, over `stopAtPercent`, excluded by a rule.
- `exhausted: true` only when every candidate is skipped.

`onLineHeld({todo, hold, prefs, ranking, now, told})` returns:
- `wait` when the matching `onHold` entry says wait, or its `afterMinutes` has not been reached;
- `tellNeo` with the ranking, once per hold episode (`told` is that episode's record);
- `tellNeo` with `exhausted` when nothing else is usable.

A hold with no `retryAt` has an unknown reset and is measured by elapsed time only.

Tests give the expected output for: a configured line with no usage reader (ranked, `usage unknown`); a stale reading; a line-specific hold rule beating a reason rule; a sliding reset under `afterMinutes`; a repo route beating a kind route; and the two-entry `only` example: a review in another repo is allowed, a write in the named repo is allowed, a write elsewhere is excluded.

## Work kinds and coding

- A new optional pack field, `workKinds`, lists a pack's kinds with labels, prefixed by the pack id: coding gives `coding.write`, `coding.review`, `coding.verify`. Core adds `general`. A todo's kind is `named.workKind`, or `general` when it has none.
- A new core function, `chooseLine(kind, candidates, scope)`, calls the `models` pack when it is enabled and otherwise returns the candidates unchanged.
- Coding keeps its eligibility rules, its provenance check, its tie-break and its session strategy. It filters candidates first, calls `chooseLine` with only the eligible ones, and keeps its own tie-break when ranking ties or the pack is off. Its three model and three effort preferences are replaced by `routes`. Where an installation has saved values, coding keeps reading them until the migration proposal for them is confirmed. Its three harness preferences, and the harness scoring in `stage-preferences.ts`, stay as they are.

## Moving a held todo

Neo moves a todo with one core operation, `neo.todo.retarget {todoId, line, requestId}`. Neo chooses `requestId`; the same id always returns the same recorded outcome. The `models` pack offers the operation as the action on its notice. The operation is core, because it changes a todo's worker.

**Admission (first delivery).** The move is refused unless the old worker session serves only this todo:
- no other todo is bound to it;
- no outstanding delivery for another todo;
- its current input belongs to this todo.

Moving work off a shared session is later work.

**Steps.** One superpipe. Each step records its phase on a `neo_todo_moves` row (move id, todo, request id, from line, to line, phase, outcome, times) before acting. Every step is safe to run again, so recovery re-runs the step of the recorded phase instead of skipping ahead:
1. **Claim.** One guarded insert. It fails if an open move exists for the todo, and returns the recorded outcome if the request id exists.
2. **Stop and confirm** (phase `stopping`). Stop the old worker with `work.stop`, then read its live status again. Continue only if the stop returned `ok` and the worker now reads as terminal, or if it was already terminal before the stop. These refuse the move and record `stop_unconfirmed`: an unsupported stop, an adopted worker, and a worker still live. The existing stop helper treats `unsupported` as success and skips adopted workers (`todo-runner.ts:1648-1691`), so retarget needs this stricter check. For a HyperNeo session, the held prompt in its hold state is cleared as well, so the old session cannot resume the moved work. Clearing is idempotent: clearing an already-empty prompt succeeds. Replace is not reached until the stop is confirmed and the prompt is cleared. That is a small new session-control step: today only the restart-resume marker has a drop call (`dropRestartResume`, `hyperneo-adapter.ts:123`).
3. **Replace** (phase `replacing`). In one transaction, write the new target on the todo-session row and set the phase to `dispatching`, so no crash can leave one without the other. The place stays the same: machine, folder and worktree. The verb is `start`: retarget always starts a new session and never sends to an existing one, so it never reuses the held session.
4. **Dispatch** (phase `dispatching`). Start the worker through the existing dispatch, with the existing start receipt. The brief's first line names the move id (`Move <move id>`), so the new worker can be recognised later. A successful start is recorded through the normal dispatch record (`recordDispatch`, `neo-todo-session-repository.ts:107`), which keeps the `start` target and the delivery evidence. That record is the move's receipt. The brief is the todo's instruction plus the old worker's latest report. A domain pack adds its hand-off through `workerStartBrief`. Coding gets new edge work for this, counted in its slice: read the branch, uncommitted and unpushed changes, and the PR link.
5. **Settle.** Record `moved` or `failed` with the reason. The row is kept as the outcome.

**Recovery.** The 5-minute sweep re-runs the step of any move row left in a phase:
- `claimed` or `stopping`: Stop and confirm again, including clearing the held prompt. A live worker records `stop_unconfirmed`; a confirmed stop continues to Replace.
- `replacing`: Replace again. It is one transaction, so either nothing was written or the phase already reads `dispatching`.
- `dispatching` with the new session already recorded: record `moved`.
- `dispatching` with no recorded session: the start may or may not have happened. The todo blocks as `start_uncertain`, like today's interrupted start (`recordStartInterrupted`, `todo-runner.ts:526`, refused at `:227`). The sweep runs `work.find` in the place's folder for the move id:
  - exactly one match: record it with `recordDispatch`, as a normal start would have, clear the interrupted mark (a small new repository call; today only `bind` clears it, `neo-todo-session-repository.ts:449`), and record `moved`. It must not use `bind`: that writes an `adopt` target and clears delivery evidence, and retarget refuses adopted workers, so the replacement could never be moved again;
  - several matches: stay blocked and tell Neo;
  - no match: stay blocked. An empty result is not proof, because a find can miss sources (`unreachable`) or be cut short (`more`, `limit`) (`find-operation.ts:35-43`). Neo is told once, with the find result.

  An uncertain move is released in only two ways: the found worker is recorded as above, or the human confirms that no worker started. Until then, no new move or retry is admitted.

Moving to a fresh worktree is not in the first delivery.

## Notices

`onLineHeld`'s `tellNeo` goes through Neo's planned attention subsystem when it exists. Until then, it uses the existing todo note, once per hold episode.

## Change (first delivery)

1. **Core:** the `routes`, `lineRules` and `holdRules` preference types (validation in `preference-operations.ts`), the `workKinds` field, and `chooseLine`, which passes candidates through when no pack ranks them. Test: with no pack, the order is unchanged.
2. **Pack:** `rankLines`, reading holds, `settings.provider.usage` and availability. Tests: each skip reason, `stopAtPercent`, unknown versus held, a stale reading, an exhausted ranking.
3. **Pack:** `onLineHeld` on the hold state, telling Neo once per episode. Tests: a short limit hold waits, a long one tells once, and overloaded follows `onHold`.
4. **Core:** `neo.todo.retarget`, the `neo_todo_moves` table, the stricter stop confirmation, clearing the held prompt, and sweep recovery. Tests: an unsupported stop, an adopted worker and a failed stop each refuse and start nothing; a shared session is refused; two concurrent requests start one worker; the same request id returns the first outcome; a crash before and after clearing the held prompt each end with the prompt cleared and one new worker; a crash inside Replace leaves either no change or `dispatching`; an unclear dispatch with one find match records `moved` with a `start` target, and a second hold on that replacement can be moved again; with no match, or with `unreachable` or `more` set, it stays blocked and admits no new move.
5. **Coding:** name its kinds, filter and then call `chooseLine`, replace the six model and effort preferences, and add the hand-off facts to `workerStartBrief` (branch, uncommitted and unpushed changes, PR link).
6. **Migration:** proposals for the structured part of a saved routing rule, then a rewrite of the rule down to its remaining clauses. Both need the human's yes.

Later and separate: per-project and per-repo overrides, moving to a fresh worktree, routes for Neo itself and the front (the first fallback step is already in flight), and kinds for other packs.

## Limits

- Ranking only chooses among the candidates the caller passes and the lines that are signed in.
- Usage is per account. A reading cannot say which model on that account used it.
- A move needs the old worker stopped. If it cannot be stopped, the todo stays where it is and Neo reports it.
