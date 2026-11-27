# Required provider, model and effort for Neo work dispatch

## 中文摘要

范围按人类要求收窄：只管 Neo 自己能调用的派发入口，共 5 个——`neo.todo.add` 的 start/send 目标、`neo.todo.edit` 给未开工 todo 补写的 instruction+target、`work.start`（含空闲工人复用和远程守护进程启动）、派发新 todo 工作的 `work.send`、编码包 `neo.coding.assign` 的审查/验证/编写目标。判断标准：`packages/prompts/src/neo/tools` 里有没有对应工具；`neo.todo.retarget` 和 `neo.todo.continue` 只按已存储的 target 重新派发（该 target 在 add/edit 准入时已校验），不接收新的身份字段，所以不算新入口；`goal.session.create`、`session.clone.spawn`、界面建会话、Space 工作流、Neo 自身会话、直接任务都不在 Neo 工具列表里，全部出范围。规则不变：每个入口必须显式给出 provider、model、effort 三项，缺一项就由一个纯函数（superpipe 管线）在派发前拒绝并说明缺什么，不再悄悄回退。能应用并回读配置的适配器回执标 confirmed（HyperNeo 取查询层实际发送值，含 Copilot 代理 fit 后的值；fit 省略时记 omitted (support unknown)，永不算 confirmed、永不记 off）；Claude Desktop 和 Cursor 无法应用也无法预读生效值，照常启动，回执写 requested …, effective unknown，复用和新任务 send 按已记录的请求三项匹配并标 unverified。引导文案随第一个改行为的 PR 发出。不做自动选型引擎。

Status: proposed. Investigation base: `50e22151753673c39998bacd3056aad0ba059c29`
(`origin/dev`, 2026-11-27). Source references are repository-relative `file:line` at
that base. This page changes no runtime behavior.

## Problem

A todo started a HyperNeo worker without `target.effort`. The recorded and
executed efforts then disagreed, and nothing refused:

- The session recorded `thinkingLevel` from global settings
  (`packages/daemon/src/lib/session/session-lifecycle.ts:292`), whose receipt
  label reads back as `medium` (`packages/shared/src/types.ts:168`,
  `packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts:390`).
- The executed effort is decided independently at query time
  (`packages/daemon/src/lib/agent/query-options-builder.ts:830-875`): a
  provider default applies only when no level was chosen anywhere (`:830-834`,
  `:910-917`); a recorded level maps to a sent effort only for granular
  thinking modes on models that publish effort levels (`:837-842`); and the
  kimi fixed-budget branch clears the effort outright (`:865-872`). Wherever
  that mapping yields no effort, the harness's own default applies, `high` for
  the model in the trigger, while the receipt still read back the recorded
  level's label.

The requested, recorded and executed identities could all differ and no gate
noticed, because every dispatch schema field is optional and every miss has a
silent fallback. The fix is to make the identity triple a required, recorded
fact at the one boundary Neo's dispatch passes through — the daemon's work
operations — not in prompt text or CLI parsing.

## Entry points in scope: Neo's dispatch tools

Every operation Neo's tools (`packages/prompts/src/neo/tools`) can use to give
new work to a worker. A dispatch onto an existing session is in scope whenever
it assigns *new* work; pure continuations (the same todo continuing, notice
replies) inherit the recorded identity and need no check.

| Entry point | Where | How provider / model / effort are chosen today |
| --- | --- | --- |
| `neo.todo.add` start target | `packages/daemon/src/lib/neo/driver-work.ts:39` (schema), `:83` (add target), `:138` (`driverWorkCall`), dispatched by `packages/daemon/src/lib/neo/todo-runner.ts:479` | `provider`, `model`, `effort` all optional (`driver-work.ts:51,66`); omitted fields are dropped from the `work.start` input (`driver-work.ts:165`). The trigger. |
| `neo.todo.edit` giving work to an unstarted todo | `packages/daemon/src/lib/neo/todo-operations.ts:329` (schema: `instruction` + `NeoTodoTargetSchema`), admission `:470-476` | Accepts a start or send target for a todo that has not started; the same optional-identity schema applies and nothing validates it at edit time — the runner dispatches the stored target later. `neo.todo.retarget` and `neo.todo.continue` re-dispatch only this stored, already-admitted target and accept no identity fields of their own, so they are covered by validating at add/edit. |
| `work.start` operation | `packages/daemon/src/lib/drivers/work-operations.ts:210` (input), `:1302` (pipeline) | `model`/`provider`/`effort` optional (`:240-242`). Gates only reject values a route cannot confirm (`:614`, `:625`); absent values pass. Fresh start records whatever the adapter reports (`:752`). |
| Worker reuse inside `work.start` | `work-operations.ts:811` (`reuseIdleWorker`), `:796` (`matchesRequested`) | Configuration is resolved only when `model` or `effort` was requested (`:896`); with neither, any recorded worker identity is accepted (`:1016`, `:1135`). Desktop worker templates strip model and provider from the resolved request (`:841`, `:901`). |
| Remote daemon start | `work-operations.ts:614` (`admitRemoteStartModel`), `:625` (`admitStartEffort`), `:699` (`admitRemoteCopilotStart`) | A start forwarded to a paired daemon refuses any explicit model or effort unless the Copilot-client handshake marked the route `verifiedCopilotStart` (`:727`), so a remote start (e.g. `claude-desktop` on another machine) must omit the model entirely. |
| `work.send` assigning new todo work | `work-operations.ts:1394` (`runSendWork`), input `:245`; `NeoSendWorkTarget` `driver-work.ts:69` | No identity fields at all: any open session, including legacy sessions with no recorded triple, can receive new todo work — a bypass of every start gate. |
| Coding pack assign and write plan | `packages/daemon/src/lib/neo/packs/coding/assign-operation.ts:228`, `assignments.ts:48` | Candidates are `CodingStageTarget` = adapter/place/model/effort, model and effort optional (`stage-preferences.ts:9`). Preference scoring covers harness/effort only (`stage-preferences.ts:37`); the unavailability fallback retries a default candidate (`assign-operation.ts:269`) that may carry no identity at all. |

## Per-adapter identity mapping

`provider` names the account/backend a worker runs on. Each adapter declares
its identity facts once — `fixedProvider` and `configurable` — and the gate
reads the declaration instead of branching on adapter ids. `configurable` is a
behavioral fact, not the presence of `resolveStartConfiguration`: the adapter
validates request-supplied model/effort against its own options and applies
them before the first turn, reading the applied values back. HyperNeo, Codex
and Copilot do this through `resolveStartConfiguration`; Antigravity does it
post-open — it applies the requested options and closes the session with a
refusal when they do not take (`antigravity-start.ts:220-233`, validation in
`antigravity-configuration.ts:56-82`) — so it declares `configurable` too. A
non-configurable adapter cannot apply or pre-verify model/effort, and for the
two that matter no authoritative pre-dispatch source of the effective values
exists: the `claude-desktop` launch passes no model flag and only an env-only
`--settings` (`claude-desktop-adapter.ts:1706-1733`), so the effective model
is the CLI's own settings/account resolution, unreadable before launch, and
`cursor`'s initialize/session-new exchange carries protocol and session id
only (`cursor-start.ts:81-106`). Such adapters therefore take the requested
triple as required entry data they cannot enforce, start, and receipt it
plainly as `requested …, effective unknown` — never as actual. Fields stay
unknown unless the harness happens to report them later; nothing is promised.

| Adapter | provider | model | effort |
| --- | --- | --- | --- |
| `hyperneo` | From the explicitly named model's catalog entry (`hyperneo-adapter.ts:708`) or the request; both must agree | Required by the gate; applied and read back (`hyperneo-adapter.ts:719`) | Required by the gate (thinking-level ID or label, `start-configuration.ts:21`) |
| `codex-desktop` | Fixed: the Codex account | Required by the gate; resolved against the `model/list` catalog and confirmed applied (`codex-start-configuration.ts:46`, `codex-desktop-adapter.ts:1699`) | Required by the gate; resolved against the selected model's supported efforts |
| `copilot-cli` / Copilot desktop | Fixed: GitHub Copilot | Required already today (`copilot-adapter.ts:115`) | Supported today, not required — an absent effort passes (`copilot-worker.ts:244` throws only for a named unsupported effort; `copilot-adapter.ts:154-156` records nothing when absent); the gate makes it required. Support flags: `copilot-adapter.ts:637`, `copilot-desktop-adapter.ts:155` |
| `antigravity` | Fixed: the Antigravity account | Supported today, not required — a start with neither model nor effort returns the opened session unconfigured (`antigravity-start.ts:221`); the gate makes it required, validated against the opened session's options and applied before the first turn, the session closed on refusal (`antigravity-start.ts:220-233`, `antigravity-configuration.ts:56-82`) | Same as model; support flag `antigravity-adapter.ts:180` |
| `claude-desktop` | Fixed: Anthropic | Required at entry as the requested value; the adapter cannot apply it (its override refusal at `claude-desktop-adapter.ts:1487` becomes accept-as-requested, not enforced) and no pre-dispatch source carries the effective model. Receipt: `requested …, effective unknown`; where the CLI transcript reports identity it corroborates, but it may report neither field (`claude-runtime-identity.ts:23-27`) and unobserved fields stay unknown | Same rule as model |
| `cursor` | Fixed: the Cursor account | Same rule as `claude-desktop`: required at entry, not enforceable, no pre-dispatch source (`cursor-start.ts:81-106`). Receipt: `requested …, effective unknown` | Same as model |

There is no “start now, decide later”: a dispatch either carries a fully
determined triple or it is refused. Determination is pre-dispatch; the
`confirmed` label attaches when the adapter's execution-building boundary has
produced the values (for HyperNeo, the first turn's query options), and
receipts distinguish the two states honestly in between.

## Design

One pure gate, one declaration per adapter, no new layers.

### The gate

Add `requireIdentity` to `workStartConfiguration` in
`packages/daemon/src/lib/drivers/start-configuration.ts`, in the same superpipe
style as `select`/`confirm` with a typed `result:identity` rejection output:

```
input:  request  { adapter, provider?, model?, effort? }
        facts    { fixedProvider?, catalogProvider?, configurable: boolean }
output: { value: { provider, model, effort } }            — required entry triple
      | { reason: { ok: false, reason, detail } }         — refuse before dispatch
```

Pure rules, each a small function piped in order:

1. Provider agreement: `request.provider`, `facts.fixedProvider` and
   `facts.catalogProvider` (the unique catalog owner of an explicitly named
   model, looked up by the caller and passed in — the gate stays pure) must
   pairwise agree wherever more than one is present; the resolved provider is
   that single value. A caller supplying a provider that contradicts the
   adapter's fixed provider is refused, not silently overridden. No source at
   all refuses.
2. Model and effort: both must be present in the request, for every adapter —
   the entry requirement is uniform. For a configurable adapter the resolved
   values are written back into the pipeline input so reuse and start consume
   them, and the adapter confirms them by applying and reading back its own
   configuration. For a non-configurable adapter the values pass through as
   the recorded request the adapter cannot enforce; the receipt says so
   (`requested …, effective unknown`) rather than refusing a start the human's
   workflow depends on, and unobserved fields simply stay unknown.
3. Refusals reuse the existing vocabulary — `unsupported_model`,
   `unsupported_effort` — plus one new reason, `identity_required`, added to
   `WorkRejectionSchema` (`packages/daemon/src/lib/drivers/types.ts:128`),
   whose detail names every missing or conflicting field:
   `identity_required: name provider, model and effort for new work (missing:
   effort)` or `identity_required: adapter claude-desktop runs on provider
   anthropic, not openai`.

No global-settings read, no “newest available”, no unnamed template default
inside the gate: those are exactly the fallbacks being removed.

### Receipts: confirmed vs declared

A configuration read is not proof of execution — settings can change between
read and dispatch, and a harness can pick a different runtime. The receipt
therefore labels its source instead of promising actuals it cannot bind:

- `confirmed`: the value observed at the boundary that builds execution, not
  a configuration echo. For HyperNeo sessions that boundary is the query
  layer, and the recorded identity is what the builder actually sends, in the
  provider's own vocabulary — never empty:
  - granular thinking modes with published effort levels: the effort string
    sent (`query-options-builder.ts:837-842`);
  - every path that sends a thinking config instead of an effort string —
    thinking mode `on`, granular models without published levels (the effort
    mapping yields nothing and the builder falls through to
    `thinkingLevelToThinkingConfig`, `query-options-builder.ts:843-846`,
    `:762-777`), and the kimi fixed-budget branch
    (`query-options-builder.ts:865-872`): the thinking level whose config was
    sent — an enabled budget maps to its level (the kimi branch always sends
    the `think16k` budget), a disabled config records `off`;
  - thinking mode `off` splits by what execution does. Providers that run no
    reasoning at all (minimax, ollama, ollama-cloud —
    `packages/shared/src/types.ts:175-187`) record the explicit value `off`.
    `anthropic-copilot` is mode `off` in the UI sense
    (`packages/shared/src/types.ts:185`) and the query builder emits no effort
    for it (`query-options-builder.ts:837-842`): its effort is decided at the
    provider proxy, which maps the requested level through `LEVEL_EFFORTS`
    (`reasoning-effort.ts:7-15`) and then fits it against the model's live
    supported efforts, downgrading or omitting when the model supports fewer
    (`server.ts:380-385`, `fitReasoningEffort` at `reasoning-effort.ts:21-29`).
    The proxy is the boundary that builds execution for this provider, so the
    confirmed value is the post-fit effort recorded where the proxy applies
    it; until the first request runs, the receipt is declared with the mapped
    (pre-fit) value. When the fit yields no effort — support empty or
    unavailable, so the proxy omits the field entirely
    (`reasoning-effort.ts:25`) — the effective reasoning level is the Copilot
    runtime's own default, which the daemon cannot know: the receipt records
    `omitted (support unknown)`, the effort field stays effective-unknown, it
    is never recorded as `off` (reasoning still runs), and the worker counts
    as not confirmed, so reuse treats it as not matching any explicit request.
    Admission does not pre-refuse on this provider — it exposes no per-model
    effort levels to check against (`provider.ts:313-317` offers only the
    thinking mode) and support is live data — so a fit below the requested
    level shows in the receipt as a requested-vs-confirmed mismatch, and reuse
    treats such a worker as not matching the request, starting fresh.

  This is the boundary because the builder resolves provider effort
  independently of session config (`query-options-builder.ts:830-842`) and a
  config read-back (`hyperneo-adapter.ts:719-729`) cannot prove what it sends
  — that gap is the trigger. With the gate making effort explicit, the
  builder's mapping is deterministic and the recorded query-layer value is
  what receipts report and reuse compares.

  Silent remaps are refused at admission, not recorded after the fact: the
  builder downgrades a level to the nearest supported effort
  (`packages/shared/src/types.ts:215`), forces the `think16k` budget for kimi
  K2.7 whatever was asked (`query-options-builder.ts:865-872`) and turns an
  `off` request on a non-anthropic granular model into the lowest effort
  (`query-options-builder.ts:330-335`, `:840`). The HyperNeo start validation
  therefore checks the requested effort against the selected model's
  executable set — the provider registry already exposes per-model thinking
  modes and effort levels, as `work.reconfigure` uses them
  (`work-reconfigure.ts:90-100`) — and refuses a request the builder would
  remap with `unsupported_effort` naming the executable values, so a
  confirmed identity always equals what the request resolves to on a satisfied
  start — the request itself where no mapping applies; on `anthropic-copilot`,
  whose fit cannot be known at admission, the receipt instead shows the
  post-fit value next to the request whenever they differ.

  For Codex, Copilot and Antigravity the adapter's own configuration API is
  that boundary — the existing `workStartConfiguration.confirm` shape
  (`start-configuration.ts:102`) as used by the Codex path and Antigravity's
  post-open option read-back (`antigravity-start.ts:222-229`) — so their
  applied read-backs are confirmed. Only confirmed identities satisfy an
  explicit request as verified; reuse of non-configurable workers follows the
  unverified rule below.
- `declared`: anything short of that boundary, reported as `requested …,
  effective unknown` — a non-configurable adapter's recorded request it cannot
  enforce, or a HyperNeo session's config values before its first turn's query
  options exist. It is never presented as actual. Observation is conditional
  per field, never promised: where the harness reports identity after turns
  the existing `identityObservation`
  (`packages/daemon/src/lib/drivers/types.ts:83`) corroborates or contradicts
  the request — a contradiction surfaces in `work.status` as an
  observed-identity fact instead of silently rewriting the record — but the
  Claude observer may legitimately report neither field
  (`claude-runtime-identity.ts:23-27`) and Cursor has no identity observer at
  all, and this design adds none. Any field never observed stays `effective
  unknown` indefinitely; nothing guesses it.

`WorkStarted` (`packages/daemon/src/lib/drivers/types.ts:238`) and the
persisted start facts (`work-operations.ts:752`, `recordStarted`) carry the
triple plus this source label for every daemon-started worker. The worker
provenance brief (`worker-provenance.ts:12`) states the label, and
`neo.todo.read` verification compares the recorded triple against the todo
target.

### Wiring

- `work.start`: one pipeline step after `admitStartEffort`
  (`work-operations.ts:1323`). The desktop carve-outs that strip model and
  provider (`work-operations.ts:841`, `:901`) are deleted — a desktop worker
  template's ordered model list is recorded configuration and enters the
  request like any other explicit value, resolved by the HyperNeo adapter like
  any configurable start. Worker-template and coding-pack candidates count as
  explicit sources the same way.
- Reuse compares all three confirmed actuals for configurable adapters on
  every path: the idle-reuse match (`work-operations.ts:796`, `:1016`) and the
  queued/busy-worker confirmation (`:1135-1139`) run against the complete
  requested triple, and a configurable worker whose recorded identity is
  missing any field is not reused — a fresh start is. Non-configurable workers
  (`claude-desktop`, `cursor`) stay reusable by matching on their recorded
  requested triple instead: a new todo requesting the same provider, model and
  effort reuses the worker, with the match labeled `unverified` in the receipt
  and status — the daemon knows what was asked, not what ran, and says so. A
  request that differs from the recorded request starts fresh, and a
  contradicted observation (where one exists) disqualifies the worker the same
  way a failed confirmation does. `work.reconfigure`
  (`work-reconfigure.ts:26`) keeps recorded values current.
- `neo.todo.add` and `neo.todo.edit`: validate a start or send target with the
  same pure gate at admission, so an incomplete identity is rejected when the
  work is assigned, not when the runner dispatches it later. Local targets use
  the local adapter registry; targets on a paired daemon use that daemon's
  `work.adapters` catalog read at admission — the local registry cannot supply
  another machine's facts. An unreachable remote defers validation to
  dispatch, where the owning daemon's gate is authoritative either way.
  `neo.todo.retarget` and `neo.todo.continue` need no admission of their own:
  they re-dispatch only the stored target this admission already validated.
- Coding pack: `CodingStageTarget` (`stage-preferences.ts:9`) requires model
  and effort in every candidate, so `planCodingStageTarget`'s fallback retry
  (`assign-operation.ts:269`) can only land on a candidate that carries the
  full triple. The start call's override that substitutes the previous
  reviewer's model for the selected candidate's model
  (`assign-operation.ts:223-233`) is deleted in the Wire slice — it can
  dispatch a different model, provider or incompatible effort than the one the
  gate validated. Reviewer-model continuity across rounds becomes a
  candidate-ordering concern the pack already owns through
  `planCodingStageTarget`'s preference scoring; the retry path re-selects from
  the same validated candidates, so it inherits the rule.
- Remote daemon starts: the remote `work.adapters` catalog
  (`work-operations.ts:1645`, schema `:346`) gains the per-adapter identity
  facts (`fixedProvider`, `configurable`). The forwarding daemon admits the
  required triple for any advertised adapter — a `configurable` remote adapter
  confirms it, a non-configurable one receipts it `requested …, effective
  unknown`; an adapter advertising neither fact refuses. This replaces the
  blanket refusal in `admitRemoteStartModel` (`:614`) and the model/effort
  role of `verifiedCopilotStart` (`:615`, `:627`). Copilot client selection
  keeps its own validation unchanged (`admitRemoteCopilotStart`, `:699-727`)
  — the identity advertisement does not vouch for the requested client. Final
  validation and the receipt happen on the daemon that owns the session; the
  forwarding daemon records that receipt verbatim.
- New todo work sent to an existing session (`work.send` naming a todo the
  worker is not already running) is a dispatch of new work, so the send
  carries the identity too: `SendWorkInputSchema` (`work-operations.ts:245`)
  and `NeoSendWorkTarget` (`driver-work.ts:69`) gain the same optional
  `provider`/`model`/`effort` fields, required exactly when the send assigns
  new todo work, and the same pure gate checks them against the target's
  recorded values — the confirmed triple for a configurable-adapter session,
  the recorded requested triple (matched and labeled `unverified`) for
  `claude-desktop`/`cursor`. A missing triple refuses `identity_required`; a
  mismatch with the recorded values refuses the same way, and Neo starts a
  fresh worker instead. A configurable-adapter session without a confirmed
  triple — every legacy session included — is likewise refused, with
  `work.reconfigure` as the upgrade path that records one. Continuation keeps
  today's semantics and carries no triple: the same todo continuing on its
  worker, notice replies to a session that messaged Neo, and the human
  messaging their own sessions.

### Neo guidance, same PR as the first server behavior

- `packages/prompts/src/neo/tools/work.start.md`: replace “Without model, a new
  HyperNeo session starts on the default model…” and the “Optional effort…”
  sentences with the required-triple rule, the `identity_required` refusal,
  the per-adapter fixed-provider note, the confirmed/declared receipt labels
  (including that `claude-desktop` and `cursor` receipts read `requested …,
  effective unknown`, with unobserved fields never resolving on their own) and
  the remote-start rule (the required triple is admitted for any advertised
  adapter).
- `packages/prompts/src/neo/tools/neo.todo.add.md:8` and
  `packages/prompts/src/neo/tools/neo.todo.edit.md`: the start target shape
  becomes `{verb:start,adapter,model,effort,provider?,place?}` — provider
  optional only where the adapter fixes or derives it; model and effort are
  required for every adapter, enforced where the adapter can and receipted
  `effective unknown` where it cannot. A send target that assigns new todo
  work names the same triple, in both tools.
- `packages/prompts/src/neo/tools/neo.coding.assign.md`: candidates name the
  full triple; the preference fallback explains when a preferred value was
  unavailable.
- A short difficulty table in `work.start.md` so Neo picks effort by task, no
  selection engine: trivial lookups → low, ordinary changes → medium, hard
  debugging or design → high, rare deepest work → max, with the adapter's
  supported values as the vocabulary.

## Slices

Three merge contracts following the repo's Pin/Build/Wire/Delete rungs —
construction, wiring and deletion stay separate. No standalone pin slice:
the wiring PR carries its own failing-then-passing assertions. Caller
surfaces measured with `bun run system-map impact` at the investigation base;
every slice stays within the repo's ~300 production-line budget. The Wire
gate refuses before any old fallback can run, so the invariant holds from the
moment it merges; the now-unreachable fallback code is removed by the Delete
rung.

1. **Build** (contract: gate + declarations only; measured surface:
   `start-configuration.ts` 8 importers, `types.ts` 128 importers but the
   change is additive — optional fields and one enum value — so no caller
   churn): the pure gate, the `identity_required` reason, the receipt source
   label and the per-adapter fact declarations including the `work.adapters`
   catalog fields. Exported and tested, not yet called; nothing observable
   changes.
2. **Wire: dispatch** (contract: every in-scope entry point passes the gate;
   measured surface: `work-operations.ts` 36 importers, `driver-work.ts` 15,
   `hyperneo-adapter.ts` 14, `drivers.ts` 3): the `work.start` pipeline step
   with triple write-back, the reuse rules, the `work.send` new-todo identity
   fields and check, query-layer recording of the executed HyperNeo identity,
   `neo.todo.add`/`neo.todo.edit` and coding-candidate admission, deletion of
   the assign start call's previous-reviewer-model override
   (`assign-operation.ts:233`, one line, required for the validated candidate
   triple to be what dispatches), remote advertisement
   replacing the model/effort admission role of
   `admitRemoteStartModel`/`verifiedCopilotStart` while preserving Copilot
   client validation, and the prompt changes above. Recorded merge-contract
   exception: removing the two desktop stripping carve-outs
   (`work-operations.ts:841`, `:901`) rides this Wire PR under the repo's
   few-line Build+Wire allowance, because the wire cannot function for
   desktop-template workers while they strip the resolved triple; it is two
   lines, not a deletion rung.
3. **Delete** (removal only): the dispatch-path fallbacks the gate made
   unreachable — the `createDriverSession` newest-available retry and
   provider-only pick (`drivers.ts:242-244`, `:253-258`), which serve only
   `work.start` on the HyperNeo adapter.

## Out of scope

Session-creation doors Neo cannot call — Space workflow and task agent spawn,
human UI session creation and quick create, Neo coordinator and front
sessions, goal sessions, session clones and direct task sessions — keep their
current behavior; also out: any automatic provider/model selection engine,
cross-adapter model equivalence, binding a non-configurable adapter's declared
identity to its runtime or adding identity observers, and retrofitting
identity onto sessions that already exist.
