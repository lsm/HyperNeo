# Required provider, model and effort for new work

## 中文摘要

每一处能开新会话、派发新工作的入口（`neo.todo.add` 的 start 目标、`work.start`、编码包指派、目标会话、界面新建会话等）都必须显式给出 provider、model、effort 三项。缺任何一项，守护进程在派发前拒绝并说明缺什么，不再悄悄回退到全局默认或“最新可用模型”。校验是一个纯函数（superpipe 管线，类型化拒绝门），落在守护进程这个环境边界上，不靠提示词或 CLI 解析。每个适配器用一张表说明 provider 的含义（Claude Desktop、Codex 等桌面适配器的 provider 是固定值）；回执必须报告实际生效的三项；复用旧 worker 时按已记录的实际值比对。Neo 的引导文案（`work.start`、`neo.todo.add` 工具说明，加一张按任务难度选 effort 的小表）随服务端改动在同一个 PR 发出。不做自动选型引擎。

Status: proposed. Investigation base: `50e22151753673c39998bacd3056aad0ba059c29`
(`origin/dev`, 2026-11-27). Source references are repository-relative `file:line` at
that base. This page changes no runtime behavior.

## Problem

A todo started a HyperNeo worker without `target.effort`. Three independent
defaults then disagreed, and nothing refused:

- The session recorded `thinkingLevel` from global settings
  (`packages/daemon/src/lib/session/session-lifecycle.ts:292`), whose receipt
  label reads back as `medium` (`packages/shared/src/types.ts:168`,
  `packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts:390`).
- The SDK query builder, seeing no chosen level, sent the provider's default
  effort instead (`packages/daemon/src/lib/agent/query-options-builder.ts:830`),
  which for the model in question is `high`.
- Provider adapters keep their own third mapping
  (`packages/daemon/src/lib/providers/anthropic-copilot/reasoning-effort.ts:10`).

The requested, recorded and executed identities were all different and no gate
noticed, because every schema field is optional and every miss has a silent
fallback. The fix is to make the identity triple a required, recorded fact at
the one boundary that owns sessions — the daemon — not in prompt text or CLI
parsing.

## Entry points that start new work today

| Entry point | Where | How provider / model / effort are chosen today |
| --- | --- | --- |
| `neo.todo.add` start target | `packages/daemon/src/lib/neo/driver-work.ts:39` (schema), `:83` (add target), `:138` (`driverWorkCall`), dispatched by `packages/daemon/src/lib/neo/todo-runner.ts:479` | `provider`, `model`, `effort` all optional (`driver-work.ts:51,66`); omitted fields are dropped from the `work.start` input (`driver-work.ts:165`). The trigger. |
| `work.start` operation | `packages/daemon/src/lib/drivers/work-operations.ts:210` (input), `:1302` (pipeline) | `model`/`provider`/`effort` optional (`:240-242`). Gates only reject values a route cannot confirm (`:614`, `:625`); absent values pass. Fresh start records whatever the adapter reports (`:752`). |
| Worker reuse inside `work.start` | `work-operations.ts:811` (`reuseIdleWorker`), `:796` (`matchesRequested`) | Configuration is resolved only when `model` or `effort` was requested (`:896`); with neither, any recorded worker identity is accepted (`:1016`, `:1135`). |
| Coding pack review/verify assign | `packages/daemon/src/lib/neo/packs/coding/assign-operation.ts:228` | Candidates are `CodingStageTarget` = adapter/place/model/effort, model and effort optional (`stage-preferences.ts:9`). Preference scoring covers harness/effort only (`stage-preferences.ts:37`); the unavailability fallback retries a default candidate (`assign-operation.ts:269`) that may carry no identity at all. |
| Coding write plan | `packages/daemon/src/lib/neo/packs/coding/assignments.ts:48` | Same `CodingStageTarget` schema and scoring; the write worker itself starts through `work.start`. |
| Goal session (`goal.session.create` with `ownSession`) | `packages/daemon/src/lib/goals/goal-session-start.ts:14` | Copies the parent session's `model`, `provider`, `thinkingLevel` and drops whichever are undefined (`:16-23`); dropped fields fall to lifecycle defaults. |
| Session clone (`session.clone.spawn`) | `packages/daemon/src/lib/session/clone-operations.ts:220` | Inherits the parent config; optional overrides. Same undefined-inheritance gap as goals. |
| Human UI session (`session.create` RPC) | `packages/daemon/src/lib/rpc-handlers/session-handlers.ts:188` | Passes `req.config` through; a missing model resolves from global settings and a configured default (`session-lifecycle.ts:1292`, `new-session-model.ts:42`), with a fallback chain and newest-available last resort (`new-session-model.ts:106-128`). Thinking level defaults to global settings (`session-lifecycle.ts:292`). |
| HyperNeo driver session (`work.start` on adapter `hyperneo`) | `packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts:188` (`createDriverSession`) | Template model/thinking when a worker template applies (`:208-209`); provider-only requests pick the newest available model (`:242`); a failed creation retries on the newest available model (`:253-258`). Adapter-side validation refuses unknown values but not absent ones (`hyperneo-adapter.ts:698`). |
| Direct task sessions | `packages/daemon/src/lib/tasks/prepare-direct-session.ts:125` | `createSessionFromInit` fills `model ?? defaultModel` (`agent-session.ts:1097`) where the default is an env var or the literal `'default'` (`config.ts:111`); thinking level stays unset and is decided at query time (`query-options-builder.ts:919`). |
| Query-time effort resolution | `query-options-builder.ts:830-875` | Not an entry point, but the place where an unrecorded level silently becomes a provider default effort — the divergence in the trigger. |
| Handoffs and focused discussions | `drivers.ts:758` (`handoffPromptToMailbox`), `packages/daemon/src/lib/neo/ask-record-operations.ts:486` | Deliver to an existing session; they start nothing new and need no gate. |
| `work.reconfigure` | `packages/daemon/src/lib/drivers/work-reconfigure.ts:26` | Switches a live daemon-started HyperNeo session and records previous/next identity (`:128`). Updates the recorded values the reuse check reads; unchanged by this design except that its results stay consistent with required receipts. |
| Remote daemon forward | `work-operations.ts:768` | A start on another daemon is validated by that daemon's own `work.start`; the gate below runs there, so no protocol change is needed. |

## Per-adapter identity mapping

`provider` names the account/backend a session runs on. For the HyperNeo
adapter it is the model catalog provider; for desktop and CLI adapters it is
fixed by the product. Each adapter declares its facts once; the gate reads the
declaration instead of branching on adapter ids.

| Adapter | provider | model | effort |
| --- | --- | --- | --- |
| `hyperneo` | From the explicitly named model's catalog entry (`hyperneo-adapter.ts:708`) or the request | Required in the request | Required in the request (thinking-level ID or label, `start-configuration.ts:21`) |
| `codex-desktop` | Fixed: the Codex account | Required; resolved against the `model/list` catalog (`codex-start-configuration.ts:46`) | Required; resolved against the selected model's supported efforts (`codex-desktop-adapter.ts:1699`) |
| `copilot-cli` / Copilot desktop | Fixed: GitHub Copilot | Required already (`copilot-adapter.ts:115`) | Required (`copilot-adapter.ts:637`; desktop capability `copilot-desktop-adapter.ts:155`) |
| `antigravity` | Fixed: the Antigravity account | Required (`antigravity-configuration.ts:29`) | Required (`antigravity-adapter.ts:180`) |
| `claude-desktop` | Fixed: Anthropic | Owned by the app; explicit values keep refusing `unsupported_model` (`claude-desktop-adapter.ts:1487`). The receipt reports the observed runtime identity (`types.ts:83`) | Same as model |
| `cursor` | Fixed: the Cursor account | Owned by the CLI configuration (`cursor-start.ts` has no model/effort parameters); receipt reports observed values | Same as model |
| Claude Code inbox / discovery-only adapters | Fixed per adapter | No start capability; nothing to validate | — |

“Fixed” and “observed” values are adapter-declared data recorded in the receipt,
not silent fallbacks: the difference from today is that they are stated,
stored and compared, never guessed from global settings.

## Design

One pure gate, next to the existing start-configuration pipeline, plus one
declaration per adapter. No new layers.

### The gate

Add `requireIdentity` to `workStartConfiguration` in
`packages/daemon/src/lib/drivers/start-configuration.ts`, in the same superpipe
style as `select`/`confirm` with a typed `result:identity` rejection output:

```
input:  request  { adapter, provider?, model?, effort? }
        facts    { fixedProvider?, observed?: { model?, effort? }, configurable: boolean }
output: { value: { provider, model, effort } }            — fully determined triple
      | { reason: { ok: false, reason, detail } }         — refuse before dispatch
```

Pure rules, each a small function piped in order:

1. `provider` = request value, else the adapter's `fixedProvider`, else the
   unique catalog provider of an explicitly named model. Otherwise refuse.
2. For a configurable adapter, `model` and `effort` must be present in the
   request; an absent field refuses. For a non-configurable adapter they come
   from the adapter's observed values; if the adapter cannot observe them yet,
   the start proceeds only when the receipt will carry the observation
   (desktop rows above) and the recorded identity stays pending until observed.
3. Refusals reuse the existing vocabulary — `unsupported_model`,
   `unsupported_effort` — plus one new reason, `identity_required`, added to
   `WorkRejectionSchema` (`types.ts:128`), whose detail names every missing
   field: `identity_required: name provider, model and effort for new work
   (missing: effort).`

No global-settings read, no “newest available”, no template default inside the
gate: those are exactly the fallbacks being removed from the dispatch path.

### Wiring (the only call sites)

- `work.start`: one pipeline step after `admitStartEffort`
  (`work-operations.ts:1323`), before reuse and start. Every agent door —
  `neo.todo.add` targets, the todo runner, coding assign, remote forwards —
  already funnels through this pipeline, so they inherit the gate.
- `neo.todo.add`: validate a start target with the same pure gate at admission
  (facts from the adapter registry), so a target missing effort is rejected
  when the todo is written, not when it dispatches.
- HyperNeo session lifecycle: `SessionManager.createSession` /
  `session-lifecycle.ts:286` refuses worker-session configs without the
  recorded triple instead of substituting `globalSettings.thinkingLevel` and
  the default-model chain. This one boundary covers the UI RPC, goal sessions,
  clones and `createDriverSession`; direct task sessions
  (`prepare-direct-session.ts:125`) resolve the same triple before
  `createSessionFromInit`. The UI composer already shows a model and thinking
  selection; the client sends what it shows, so human behavior is unchanged.
- Reuse: with the requested triple always complete, the existing
  `matchesRequested` / `confirm` comparison (`work-operations.ts:796,1135`)
  becomes total: a reused worker qualifies only when its recorded actual
  provider/model/effort equals the request; a worker with unrecorded identity
  is not reused for a new todo. `work.reconfigure` keeps maintaining those
  recorded values.

### Receipts

`WorkStarted` (`types.ts:238`) and the persisted start facts
(`work-operations.ts:752`, `recordStarted`) must carry provider, model and
effort for every daemon-started session — actual values, not requested ones.
Desktop adapters report observed actuals through the existing
`identityObservation` field (`types.ts:83`) until confirmed. The worker
provenance brief (`worker-provenance.ts:12`) then never prints `unknown` for a
daemon-started HyperNeo worker, and `neo.todo.read` verification compares the
recorded triple against the todo target.

### Neo guidance, same PR as the server change

- `packages/prompts/src/neo/tools/work.start.md`: replace “Without model, a new
  HyperNeo session starts on the default model…” and the “Optional effort…”
  sentences with the required-triple rule, the `identity_required` refusal, and
  the per-adapter fixed-provider note.
- `packages/prompts/src/neo/tools/neo.todo.add.md:8`: the start target shape
  becomes `{verb:start,adapter,model,effort,provider?,place?}` — provider
  optional only where the adapter fixes or derives it.
- A short difficulty table in `work.start.md` so Neo picks effort by task, no
  selection engine: trivial lookups → low, ordinary changes → medium, hard
  debugging or design → high, rare deepest work → max, with the adapter's
  supported values as the vocabulary.

## Slices

1. Pin: unit tests capturing today's silent fallbacks (start without effort
   succeeds; receipt/execution divergence) as the behavior being removed.
2. Build: the pure gate, the `identity_required` reason and per-adapter fact
   declarations — exported, tested, not yet called (knip-reachable).
3. Wire: `work.start` step, `neo.todo.add` admission, adapter declarations
   switched on, and the prompt changes above in the same PR.
4. Wire: session-lifecycle boundary (UI, goals, clones, direct tasks).
5. Delete: remove the dispatch-path fallbacks — newest-available retry
   (`drivers.ts:253`), provider-only newest pick (`drivers.ts:242`) and the
   global thinking-level default for worker sessions
   (`session-lifecycle.ts:292`).

Each slice stays under the production-line budget; 3 and 4 are separate PRs
because they touch independent doors.

## Out of scope

- Any automatic provider/model selection engine; Neo chooses per task with the
  guidance table.
- Cross-adapter model equivalence or capability negotiation beyond the
  existing catalogs.
- Human sign-in, payment and other delegation preferences; unrelated.
- Remote protocol changes; each daemon enforces its own starts.
