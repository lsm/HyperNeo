# Required provider, model and effort for Neo work dispatch

## 中文摘要

范围：Neo 工具能调用的派发入口，共 6 个——`neo.todo.add` 与 `neo.todo.edit` 的 start/send 目标、`work.start`（含空闲工人复用与远程启动）、派发新 todo 工作的 `work.send` 与 `work.queue`、编码包 `neo.coding.assign` 的目标。门槛只作用于 Neo 身份的调用（caller.role === 'neo'，todo runner 内部派发也是这个身份）；其他 MCP 代理与 checkPlan 计划检查保持现状。总结：6 个入口。判断标准：`packages/prompts/src/neo/tools` 里有对应工具；`neo.todo.retarget`/`neo.todo.continue` 只按已存储的 target 重新派发，不算新入口；Space、界面建会话、Neo 自身会话、目标会话、克隆、直接任务都不在 Neo 工具列表里，出范围。规则：每个入口必须显式给出 provider、model、effort，缺一项由纯函数（superpipe 管线）在派发前拒绝。可配置适配器回执标 confirmed：HyperNeo 取查询层每轮实际发送值，记录（思考等级，发送的 effort）二元组并按等级比对——level→effort 映射有损（think48k 与 think64k 都发 max），只记 effort 无法区分；Copilot 代理记 fit 后的值，fit 省略时记 omitted (support unknown)，永不算 confirmed、永不记 off。Claude Desktop/Cursor 无法应用也无法预读生效值，照常启动，回执写 requested …, effective unknown，复用与新任务 send 按已记录的请求等级匹配并标 unverified。编码审查的评审模型连续性改为候选排序优先匹配上一轮评审的三元组，不再用覆盖。切片：Build、Wire（start+复用 / send+todo 准入 / 编码+远程）、Delete，各带行数估算。不做自动选型引擎。

Status: proposed. Investigation base: `50e22151753673c39998bacd3056aad0ba059c29`
(`origin/dev`, 2026-11-27). Source references are repository-relative `file:line`
at that base. This page changes no runtime behavior.

## Problem

A todo started a HyperNeo worker without `target.effort`. The recorded and
executed efforts disagreed and nothing refused: the session recorded
`thinkingLevel` from global settings
(`packages/daemon/src/lib/session/session-lifecycle.ts:292`), whose receipt
label reads back as `medium` (`packages/shared/src/types.ts:168`,
`packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts:390`),
while the executed effort is decided independently at query time
(`packages/daemon/src/lib/agent/query-options-builder.ts:830-875`): a provider
default applies only when no level was chosen anywhere (`:830-834`,
`:910-917`); a recorded level maps to a sent effort only for granular thinking
modes on models that publish effort levels (`:837-842`); and the kimi
fixed-budget branch clears the effort outright (`:865-872`). Wherever that
mapping yields no effort, the harness's own default applies — `high` for the
model in the trigger — while the receipt still read back the recorded level's
label. Every dispatch schema field is optional and every miss has a silent
fallback, so no gate noticed. The fix makes the identity triple a required,
recorded fact at the one boundary Neo's dispatch passes through — the daemon's
work operations — not in prompt text or CLI parsing.

## Entry points in scope: Neo's dispatch tools

Every operation Neo's tools (`packages/prompts/src/neo/tools`) can use to give
new work to a worker. A dispatch onto an existing session is in scope whenever
it assigns *new* work; pure continuations (the same todo continuing, notice
replies) inherit the recorded identity and need no check.

| Entry point | Where | How provider / model / effort are chosen today |
| --- | --- | --- |
| `neo.todo.add` start target | `packages/daemon/src/lib/neo/driver-work.ts:39` (schema), `:83`, `:138` (`driverWorkCall`), dispatched by `packages/daemon/src/lib/neo/todo-runner.ts:479` | `provider`, `model`, `effort` all optional (`driver-work.ts:51,66`); omitted fields are dropped from the `work.start` input (`driver-work.ts:165`). The trigger. |
| `neo.todo.edit` giving work to an unstarted todo | `packages/daemon/src/lib/neo/todo-operations.ts:329` (schema), admission `:470-476` | Accepts a start or send target with the same optional-identity schema; nothing validates it at edit time and the runner dispatches the stored target later. `neo.todo.retarget` and `neo.todo.continue` re-dispatch only this stored, already-admitted target and accept no identity fields, so validating at add/edit covers them. |
| `work.start` operation | `packages/daemon/src/lib/drivers/work-operations.ts:210` (input), `:1302` (pipeline) | `model`/`provider`/`effort` optional (`:240-242`). Gates only reject values a route cannot confirm (`:614`, `:625`); absent values pass. Fresh start records whatever the adapter reports (`:752`). |
| Worker reuse inside `work.start` | `work-operations.ts:811` (`reuseIdleWorker`), `:796` (`matchesRequested`) | Configuration is resolved only when `model` or `effort` was requested (`:896`); with neither, any recorded worker identity is accepted (`:1016`, `:1135`). Desktop worker templates strip model and provider (`:841`, `:901`); the reuse guards key on the `resolveStartConfiguration` hook (`:826`, `:895-897`); a mismatched worker is reconfigured in place and matched on the read-back with no turn in between (`:1016-1027`). |
| Remote daemon start | `work-operations.ts:614` (`admitRemoteStartModel`), `:625` (`admitStartEffort`), `:699` (`admitRemoteCopilotStart`) | A forwarded start refuses any explicit model or effort unless the Copilot-client handshake marked the route `verifiedCopilotStart` (`:727`), so a remote start must omit the model entirely. |
| `work.send` assigning new todo work | `work-operations.ts:1394` (`runSendWork`), input `:245`; `NeoSendWorkTarget` `driver-work.ts:69` | No identity fields at all: any open session, including legacy sessions with no recorded triple, can receive new todo work — a bypass of every start gate. |
| `work.queue` assigning new todo work | `work-operations.ts:1509` (`runQueueWork`), same `SendWorkInputSchema` (`:1725`), Neo-discoverable (`packages/daemon/src/lib/operations/neo-discovery.ts:96`), tool prompt `work.queue.md` | A separate Neo-exposed pipeline that queues a message to any open ref with the same todoId semantics and no identity check — the same bypass as `work.send`. |
| Coding pack assign and write plan | `packages/daemon/src/lib/neo/packs/coding/assign-operation.ts:228`, `assignments.ts:48` | Candidates are `CodingStageTarget`, model and effort optional (`stage-preferences.ts:9`); the start call overrides the selected candidate's model with the previous reviewer's (`assign-operation.ts:233`), and the fallback retry (`:269`) may land on a candidate carrying no identity. |

## Per-adapter identity mapping

`provider` names the account/backend a worker runs on. Each adapter declares
its identity facts once — `fixedProvider` and `configurable` — and the gate
reads the declaration instead of branching on adapter ids. `configurable` is
behavioral, not the presence of `resolveStartConfiguration`: the adapter
validates request-supplied model/effort against its own options and applies
them before the first turn, reading the applied values back. HyperNeo, Codex
and Copilot do this through `resolveStartConfiguration`; Antigravity does it
post-open, closing the session with a refusal when the options do not take
(`antigravity-start.ts:220-233`, `antigravity-configuration.ts:56-82`). A
non-configurable adapter cannot apply or pre-verify model/effort, and for the
two that matter no authoritative pre-dispatch source of the effective values
exists: the `claude-desktop` launch passes no model flag and only an env-only
`--settings` (`claude-desktop-adapter.ts:1706-1733`), and `cursor`'s
initialize/session-new exchange carries protocol and session id only
(`cursor-start.ts:81-106`). Such adapters take the requested triple as
required entry data they cannot enforce, start, and receipt it plainly as
`requested …, effective unknown` — never as actual; fields stay unknown unless
the harness happens to report them later, and nothing is promised.

| Adapter | provider | model | effort |
| --- | --- | --- | --- |
| `hyperneo` | From the explicitly named model's catalog entry (`hyperneo-adapter.ts:708`) or the request; both must agree | Required by the gate; applied and read back (`hyperneo-adapter.ts:719`) | Required by the gate (thinking-level ID or label, `start-configuration.ts:21`) |
| `codex-desktop` | Fixed: the Codex account | Required by the gate; resolved against the `model/list` catalog and confirmed applied (`codex-start-configuration.ts:46`, `codex-desktop-adapter.ts:1699`) | Required by the gate; resolved against the selected model's supported efforts |
| `copilot-cli` / Copilot desktop | Fixed: GitHub Copilot | Required already today (`copilot-adapter.ts:115`) | Supported today, not required — an absent effort passes (`copilot-worker.ts:244` throws only for a named unsupported effort; `copilot-adapter.ts:154-156` records nothing when absent); the gate makes it required. Support flags: `copilot-adapter.ts:637`, `copilot-desktop-adapter.ts:155` |
| `antigravity` | Fixed: the Antigravity account | Supported today, not required (`antigravity-start.ts:221` returns unconfigured when neither is given); the gate makes it required, validated and applied post-open with refusal on failure (`antigravity-start.ts:220-233`) | Same as model; support flag `antigravity-adapter.ts:180` |
| `claude-desktop` | Fixed: Anthropic | Required at entry as the requested value; not enforceable (the override refusal at `claude-desktop-adapter.ts:1487` becomes accept-as-requested) and no pre-dispatch source exists. Receipt: `requested …, effective unknown`; the CLI transcript may corroborate but may report neither field (`claude-runtime-identity.ts:23-27`) | Same rule as model |
| `cursor` | Fixed: the Cursor account | Same rule as `claude-desktop` (`cursor-start.ts:81-106`). Receipt: `requested …, effective unknown` | Same as model |

There is no “start now, decide later”: a dispatch either carries a fully
determined triple or it is refused. Determination is pre-dispatch; the
`confirmed` label attaches when the adapter's execution-building boundary has
produced the values (for HyperNeo, a turn's query options), and receipts
distinguish the two states honestly in between.

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
   that single value. A contradicting caller-supplied provider is refused, not
   overridden. No source at all refuses.
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
labels its source instead of promising actuals it cannot bind:

- `confirmed`: the value observed at the boundary that builds execution, not
  a configuration echo. For HyperNeo sessions that boundary is the query
  layer, and the recorded identity is what the builder actually sends on every
  turn — so a `work.reconfigure` switch is upgraded from declared to confirmed
  when the next turn runs — never empty:
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

  The recorded confirmed identity is the pair (thinking level, sent effort),
  and comparisons run on the level: the level→effort mapping is lossy —
  `think48k` and `think64k` both send `max`, `think32k` sends `xhigh`
  (`packages/shared/src/types.ts:205-213`) — so the effort string alone cannot
  distinguish a requested `think64k` from a worker running `think48k`, and a
  strict string compare (`work-operations.ts:796-806`) would conflate them.
  The effort string is recorded alongside for receipts and provenance. For
  `anthropic-copilot`, whose recorded value is a post-fit effort, the
  requested level's `LEVEL_EFFORTS` mapping is compared against it.

  This is the boundary because the builder resolves provider effort
  independently of session config (`query-options-builder.ts:830-842`) and a
  config read-back (`hyperneo-adapter.ts:719-729`) cannot prove what it sends
  — that gap is the trigger. Silent remaps are refused at admission, not
  recorded after the fact: the builder downgrades a level to the nearest
  supported effort (`packages/shared/src/types.ts:215`), forces the `think16k`
  budget for kimi K2.7 (`query-options-builder.ts:865-872`) and turns an `off`
  request on a non-anthropic granular model into the lowest effort
  (`query-options-builder.ts:330-335`, `:840`). The HyperNeo start validation
  therefore checks the requested effort against the selected model's
  executable set — the provider registry already exposes per-model thinking
  modes and effort levels, as `work.reconfigure` uses them
  (`work-reconfigure.ts:90-100`) — and refuses a request the builder would
  remap with `unsupported_effort` naming the executable values, so a confirmed
  identity always equals what the request resolves to on a satisfied start —
  the request itself where no mapping applies; on `anthropic-copilot`, whose
  fit cannot be known at admission, the receipt instead shows the post-fit
  value next to the request whenever they differ.

  For Codex, Copilot and Antigravity the adapter's own configuration API is
  that boundary — the existing `workStartConfiguration.confirm` shape
  (`start-configuration.ts:102`) as used by the Codex path and Antigravity's
  post-open option read-back (`antigravity-start.ts:222-229`) — so their
  applied read-backs are confirmed. Only confirmed identities satisfy an
  explicit request as verified; reuse of non-configurable workers follows the
  unverified rule below.
- `declared`: anything short of that boundary, reported as `requested …,
  effective unknown` — a non-configurable adapter's recorded request it cannot
  enforce, or a HyperNeo session's config values before a turn's query options
  exist for them. It is never presented as actual. Observation is conditional
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
triple, the level pair where one exists, and this source label for every
daemon-started worker. The worker provenance brief
(`worker-provenance.ts:12`) states the label, and `neo.todo.read` verification
compares the recorded triple against the todo target.

### Wiring

- `work.start`: one pipeline step in place of `admitStartEffort`
  (`work-operations.ts:1323`). That gate's local branch (`:626-627`) refuses
  any explicit effort for adapters without `supportsStartEffort` — only
  antigravity, codex-desktop, copilot and hyperneo set it — so with the gate
  making effort mandatory it would reject every claude-desktop and cursor
  start with `unsupported_effort` before the new gate ran, leaving the
  declared receipt path unreachable; its remote branch keys on
  `verifiedCopilotStart` (`:627`). Both refusal roles are subsumed by the new
  gate's per-adapter facts. The step is keyed on `caller.role === 'neo'` — the
  identity the todo runner also dispatches under (`driver-work.ts:174`) — so
  non-Neo agent callers of `work.start` (MCP agents and daemon devices) and
  `checkPlan: true` plan checks, which dispatch no worker, keep today's
  behavior, matching this design's scope. Until the coding-and-remote slice
  lands, this gate step applies to local routes only: `admitRemoteStartModel` (`:614-623`)
  refuses any explicit model on a remote route without `verifiedCopilotStart`,
  so requiring the triple on remote starts earlier would make every remote
  start impossible in between — remote-routed starts keep today's admission
  until the remote slice replaces it. The desktop carve-outs that strip model and
  provider (`work-operations.ts:841`, `:901`) are deleted — a desktop worker
  template's ordered model list is recorded configuration and enters the
  request like any other explicit value.
- Reuse compares the requested triple against recorded identity on every path
  — the idle-reuse match (`work-operations.ts:796`, `:1016`) and the
  queued/busy-worker confirmation (`:1135-1139`) — on the thinking level where
  one exists. Two `reuseIdleWorker` guards keyed on the
  `resolveStartConfiguration` hook are rewired: the early return at
  `work-operations.ts:826` and the resolution/dereference at `:895-897`; with
  the gate forcing the triple they would exclude every adapter without the
  hook (antigravity, claude-desktop, cursor) from reuse entirely. Reuse
  consumes the gate-resolved triple and compares it against each candidate's
  recorded identity through `matchesRequested`; the hook stays start-time
  validation for the adapters that define it. The in-place switch-then-reuse
  path (`work-operations.ts:1016-1027`) is dropped: a post-switch read-back is
  a declared-class config echo that can never satisfy confirmed-only matching,
  so a non-matching worker is skipped and a fresh worker starts;
  `work.reconfigure` plus a turn remains the way to move a live session.
  Non-configurable workers (`claude-desktop`, `cursor`) stay reusable by
  matching on their recorded requested triple, labeled `unverified` in receipt
  and status; a differing request starts fresh, and a contradicted observation
  (where one exists) disqualifies the worker like a failed confirmation.
- `neo.todo.add` and `neo.todo.edit`: validate a start or send target with the
  same pure gate at admission, so an incomplete identity is rejected when the
  work is assigned, not when the runner dispatches it later. Like the start
  gate, admission applies to local targets first, using the local adapter
  registry; remote targets keep today's admission until the coding-and-remote
  slice adds the `work.adapters` catalog read at admission (the local registry
  cannot supply another machine's facts, and requiring the triple for remote
  targets before the remote dispatch gate accepts it would refuse every remote
  todo start in between). From that slice on, an unreachable remote defers
  validation to dispatch, where the owning daemon's gate is authoritative.
  `neo.todo.retarget` and `neo.todo.continue` need no admission of their own:
  they re-dispatch only the stored target this admission already validated.
- New todo work sent to an existing session (`work.send` or `work.queue`
  naming a todo the worker is not already running) carries the identity too:
  `SendWorkInputSchema` (`work-operations.ts:245`) — shared by both pipelines
  (`:1725`) — and `NeoSendWorkTarget` (`driver-work.ts:69`) gain the same
  optional `provider`/`model`/`effort` fields, required exactly when the send
  or queue assigns new todo work, and the same gate, wired into both
  `runSendWork` (`:1394`) and `runQueueWork` (`:1509`), checks them against
  the target's recorded values — the confirmed triple
  for a configurable-adapter session, the recorded requested triple (labeled
  `unverified`) for `claude-desktop`/`cursor`. A missing triple or a mismatch
  refuses `identity_required` and Neo starts a fresh worker. A
  configurable-adapter session without a confirmed triple — every legacy
  session included — is likewise refused. The upgrade path for such a
  HyperNeo session is `work.reconfigure` plus its next turn: `switchSettings`
  only switches config and reads it back (`work-reconfigure.ts:105-126`), a
  declared-class read by this design's own definition, so reconfigure alone
  does not unblock the session; the query-layer recorder upgrades the record
  to confirmed when the next turn runs, which is also when the switched
  settings take effect (`work-reconfigure.ts:124`). Continuation keeps today's
  semantics and carries no triple: the same todo continuing on its worker,
  notice replies, and the human messaging their own sessions.
- Coding pack: `CodingStageTarget` (`stage-preferences.ts:9`) requires model
  and effort in every candidate, so `planCodingStageTarget`'s fallback retry
  (`assign-operation.ts:269`) can only land on a candidate that carries the
  full triple. The start call's override that substitutes the previous
  reviewer's model for the selected candidate's model
  (`assign-operation.ts:233`) is deleted — it can dispatch a different model,
  provider or incompatible effort than the gate validated. Reviewer-model
  continuity is kept by ordering, not override: only harness and effort are
  declared stage preferences (`stage-preferences.ts:37`), so model scoring is
  always zero today, and the assign step instead prefers, among the validated
  candidates, the one whose full triple matches the previous reviewer's
  recorded values; the retry path re-selects from the same validated
  candidates and inherits the rule.
- Remote daemon starts: the remote `work.adapters` catalog
  (`work-operations.ts:1645`, schema `:346`) gains the per-adapter identity
  facts (`fixedProvider`, `configurable`). The forwarding daemon admits the
  required triple for any advertised adapter — a `configurable` remote adapter
  confirms it, a non-configurable one receipts it `requested …, effective
  unknown`; an adapter advertising neither fact refuses. This replaces the
  blanket refusal in `admitRemoteStartModel` (`:614`) and the model/effort
  role of `verifiedCopilotStart` (`:615`, `:627`). Copilot client selection
  keeps its own validation unchanged (`admitRemoteCopilotStart`, `:699-727`).
  Final validation and the receipt happen on the daemon that owns the session;
  the forwarding daemon records that receipt verbatim.

### Neo guidance, same PR as the first server behavior

- `packages/prompts/src/neo/tools/work.start.md`: replace “Without model, a new
  HyperNeo session starts on the default model…” and the “Optional effort…”
  sentences with the required-triple rule, the `identity_required` refusal,
  the per-adapter fixed-provider note, the confirmed/declared receipt labels
  (including that `claude-desktop` and `cursor` receipts read `requested …,
  effective unknown`, with unobserved fields never resolving on their own) and
  the remote-start rule. The sentence “An idle local HyperNeo worker with
  another model or effort is switched in place first and reused once the
  switch is confirmed” is deleted with the dropped switch-then-reuse path.
- `packages/prompts/src/neo/tools/neo.todo.add.md:8` and
  `packages/prompts/src/neo/tools/neo.todo.edit.md`: the start target shape
  becomes `{verb:start,adapter,model,effort,provider?,place?}` — provider
  optional only where the adapter fixes or derives it; model and effort are
  required for every adapter, enforced where the adapter can and receipted
  `effective unknown` where it cannot. A send target that assigns new todo
  work names the same triple, in both tools; `work.queue.md` and
  `work.send.md` state the same rule for direct sends and queues.
- `packages/prompts/src/neo/tools/neo.coding.assign.md`: candidates name the
  full triple; continuity with the previous reviewer is expressed by
  candidate ordering.
- A short difficulty table in `work.start.md` so Neo picks effort by task, no
  selection engine: trivial lookups → low, ordinary changes → medium, hard
  debugging or design → high, rare deepest work → max, with the adapter's
  supported values as the vocabulary.

## Slices

Five merge contracts following the repo's Pin/Build/Wire/Delete rungs. No
standalone pin slice: each wiring PR carries its own failing-then-passing
assertions. Production-line estimates are measured from the cited regions at
the investigation base; prompts and tests do not count against the budget.
The first Wire gate refuses before any old fallback can run, so the invariant
holds per door from the moment its slice merges.

1. **Build** (≈200 production lines; measured surface: `start-configuration.ts`
   8 importers, `types.ts` 128 importers with an additive-only change): the
   pure gate (~120 lines in `start-configuration.ts`), the `identity_required`
   reason and receipt-label/plus-level-pair fields (~10 in
   `drivers/types.ts`), and the per-adapter fact declarations including the
   `work.adapters` catalog fields (~70 across the seven adapters). Exported
   and tested, not yet called.
2. **Wire: start and reuse** (contract: every local `work.start` and reuse
   passes the gate; remote-routed starts keep today's admission until slice 4,
   so no remote start is caught between a required model and a refused one;
   ≈160 production lines): the `work.start`
   pipeline step replacing `admitStartEffort` on local routes
   (`work-operations.ts:626-627`,
   `:1323`, ~30), the desktop carve-out removal (`:841`, `:901`, 2 lines under
   the few-line Build+Wire allowance), the reuse rewiring — hook-keyed guards
   (`:826`, `:895-897`) and the dropped switch-then-reuse block (`:1016-1027`)
   (~40), the HyperNeo admission executable-set check
   (`hyperneo-adapter.ts:698-717`, ~35), query-layer recording of the
   executed identity on every turn (`query-options-builder.ts` plus the
   session facts write, ~35), and the receipt label plumbing through
   `recordStarted` (`work-operations.ts:752`, ~20).
3. **Wire: send, queue and todo admission** (contract: new-todo sends,
   queues and local todo targets pass the gate; remote todo targets keep
   today's admission until slice 4, matching the start gate's staging; ≈95
   production lines): the `SendWorkInputSchema`/`NeoSendWorkTarget` identity
   fields (`work-operations.ts:245`, `driver-work.ts:69`, ~10), the new-todo
   identity check wired into `runSendWork` and `runQueueWork` (`:1394`,
   `:1509`, ~45), and `neo.todo.add`/`neo.todo.edit` admission for local
   targets (`todo-operations.ts`, ~40).
4. **Wire: coding pack and remote** (contract: coding candidates,
   remote-routed starts and remote todo targets pass the gate; ≈105
   production lines): required
   `CodingStageTarget` fields (`stage-preferences.ts:9`, ~5), the override
   deletion (`assign-operation.ts:233`, 1 line) and continuity-by-ordering
   (~15), and the remote advertisement schema plus forwarding admission that
   extend the gate step to remote routes and replace
   `admitRemoteStartModel`/`verifiedCopilotStart`'s model/effort role
   (`work-operations.ts:614-635`, `:346`, ~60) while preserving Copilot client
   validation, plus remote-target admission for `neo.todo.add`/`neo.todo.edit`
   with the `work.adapters` catalog read (~25). The prompt changes above ride this slice, the last
   behavior-changing one; slices 2 and 3 update the tool text they change in
   the same PR as their behavior.
5. **Delete** (removal only, ≈20 lines): the dispatch-path fallbacks the gates
   made unreachable — the `createDriverSession` newest-available retry and
   provider-only pick (`drivers.ts:242-244`, `:253-258`).

## Out of scope

Session-creation doors Neo cannot call — Space workflow and task agent spawn,
human UI session creation and quick create, Neo coordinator and front
sessions, goal sessions, session clones and direct task sessions — keep their
current behavior; also out: any automatic provider/model selection engine,
cross-adapter model equivalence, binding a non-configurable adapter's declared
identity to its runtime or adding identity observers, and retrofitting
identity onto sessions that already exist.
