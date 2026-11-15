# Model lines: a pack that ranks models for work and moves a held todo

Checked against dev b315021b06.

## Summary

A "line" is one way to run a model: provider, model, harness and effort. Today a todo's line is fixed when Neo creates it. When that line runs out, the todo fails or waits, and the human's routing wishes live only in free-text standing rules.

This design adds one pack, `models`, with nothing domain-specific in it. It does three things:
1. It ranks candidate lines for a piece of work against the human's structured preferences and each line's current availability. This is a pure function.
2. When a todo's worker is held on a line for longer than the human wants to wait, it tells Neo, together with the ranked alternatives.
3. It gives Neo one safe way to move that todo to another line in the same place.

Other packs name their kinds of work and pass only the candidates they consider eligible. Packs never import each other.

## What exists (dev b315021b06)

- A todo's line is fixed at creation (`neo_todo_sessions.target`). Nothing re-reads it after a hold or a failure.
- Usage is already readable by Neo through the transport-neutral `settings.provider.usage` operation, which calls `provider.getUsage()`. Anthropic, the Codex bridge and Kimi implement it.
- A session's hold already records its reason and `retryAt` in its processing state (`rate_limit_cooldown`). The typed reason already exists (`RateLimitHoldReason = 'network' | 'login' | 'limit' | 'overloaded'`, `packages/shared/src/state-types.ts`), with `heldPrompt`; `network` and `login` holds write it. The remaining dependency from `docs/design/model-holds.md` is that the usage-limit and overload holds write `limit` and `overloaded`.
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
| `onHold` | `holdRules` | What happens when a todo's worker is held | `limit` and `login`: `move` after 30 minutes; `overloaded` and `network`: `wait` |

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

A move is not a new mechanism. The daemon already moves a stalled todo to a fresh worker with `neo.todo.redispatch` (`todo-runner.ts`): stop the old worker, mark it unusable, reopen the todo as `todo`, and start it through the normal start path (`neo.todo.start`). That start path already has the start receipt, the capacity and busy-worker holds, and the uncertain-start handling (`recordStartInterrupted`, `start_uncertain`, `work.find`). A held todo moves through the same pipeline. The only difference is which line the restart picks.

**Picking the line.** The start path asks the todo's pack for its target through the existing `NeoPack.workerTarget` hook (`pack-contract.ts`, added in HyperNeo #10694; called in `chooseTarget`, `todo-runner.ts`), and a `start` target it returns replaces the stored one when the claim is dispatched. No new hook is needed. Coding's `workerTarget` calls `chooseLine`, so a reopened todo is ranked again. The held line is skipped by its own hold, so the restart lands on the best usable line without anyone naming it. When Neo names a line, it is passed as the first candidate.

**The operation.** `neo.todo.retarget {todoId, fromRef, line?}` lets Neo ask for a move. `fromRef` is the worker Neo wants to move off. If the todo's current worker is no longer `fromRef`, the move already happened, and the call returns the todo as it is. That makes a repeated call harmless with no request store. It then runs `neo.todo.redispatch`.

**Two fixes to the shared pipeline**, which also make the existing stall redispatch safe:
- **Stop must be confirmed.** The stop helper treats an `unsupported` stop as success and skips adopted workers (`neo.todo.stop-current-worker`, `todo-runner.ts`). A move continues only when the old worker reads as terminal after the stop. Otherwise it is refused, the todo stays where it is, and Neo is told once. This rule prevents two live workers on one todo.
- **A held session drops its held prompt.** For a HyperNeo session in a hold, the stop also clears the held prompt, so the old session cannot resume the moved work later. Clearing an empty prompt succeeds.

**Every case, with no new state:**
- Two moves at once: the start claim is one transaction, so only one worker starts. The second call sees a new worker and returns.
- A crash after the stop and before the reopen: the todo is `doing` on a stopped worker. The existing stall rescue (`neo.todo.rescue-stalled`) picks it up and moves it.
- A crash during the start: the existing uncertain-start path handles it, as for any start.
- A shared session (another todo is bound to it, or has a delivery outstanding): refused, because marking it unusable would stop the other todo too. Moving work off a shared session is later work.
- No usable line: the start path waits, as it does today, and `onLineHeld` has already told Neo with `exhausted`.

**The hand-off.** The new worker's brief is the todo's instruction plus the old worker's latest report. A domain pack adds its own hand-off through `workerStartBrief`. Coding adds the branch, uncommitted and unpushed changes, and the PR link, so the new worker continues in the same folder and worktree instead of starting over.

## Notices

`onLineHeld`'s `tellNeo` goes through Neo's planned attention subsystem when it exists. Until then, it uses the existing todo note, once per hold episode.

## Change (first delivery)

1. **Core:** the `routes`, `lineRules` and `holdRules` preference types (validation in `preference-operations.ts`), the `workKinds` field, and `chooseLine`, which passes candidates through when no pack ranks them. Test: with no pack, the order is unchanged.
2. **Pack:** `rankLines`, reading holds, `settings.provider.usage` and availability. Tests: each skip reason, `stopAtPercent`, unknown versus held, a stale reading, an exhausted ranking.
3. **Pack:** `onLineHeld` on the hold state, telling Neo once per episode. Tests: a short limit hold waits, a long one tells once, and overloaded follows `onHold`.
4. **Core:** `neo.todo.retarget` on top of `neo.todo.redispatch`, the confirmed stop, and clearing the held prompt. Tests: an unsupported stop, an adopted worker and a stop that leaves the worker live each refuse and start nothing; a shared session is refused; two concurrent calls start one worker; a repeated call with an old `fromRef` changes nothing; the restart skips the held line; a crash between stop and reopen is picked up by the stall rescue; the existing stall redispatch now refuses an unconfirmed stop too.
5. **Coding:** name its kinds, filter and then call `chooseLine`, replace the six model and effort preferences, and add the hand-off facts to `workerStartBrief` (branch, uncommitted and unpushed changes, PR link).
6. **Migration:** proposals for the structured part of a saved routing rule, then a rewrite of the rule down to its remaining clauses. Both need the human's yes.

Later and separate: per-project and per-repo overrides, moving to a fresh worktree, routes for Neo itself and the front (the first fallback step is already in flight), and kinds for other packs.

## Limits

- Ranking only chooses among the candidates the caller passes and the lines that are signed in.
- Usage is per account. A reading cannot say which model on that account used it.
- A move needs the old worker stopped. If it cannot be stopped, the todo stays where it is and Neo reports it.
