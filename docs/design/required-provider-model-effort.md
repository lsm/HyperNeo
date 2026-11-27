# Required provider, model and effort for new work

## 中文摘要

每一处能开新会话、派发新工作的入口（`neo.todo.add` 的 start 目标、`work.start`、编码包指派、目标会话、Neo 自身会话、界面新建会话等）都必须显式给出 provider、model、effort 三项。缺任何一项，守护进程在派发前拒绝并说明缺什么，不再悄悄回退到全局默认或“最新可用模型”。校验是一个纯函数（superpipe 管线，类型化拒绝门），落在守护进程这个环境边界上，不靠提示词或 CLI 解析。每个适配器声明 provider 的含义（Claude Desktop、Codex 等桌面适配器的 provider 固定）；无法在派发前确定三项的适配器必须拒绝启动，不允许“先启动、回执待补”。远程配对守护进程通过适配器目录广播自己的配置能力，由拥有会话的那台守护进程做最终校验并回执实际值。复用旧 worker 时按已记录的实际三项逐一比对。Neo 的引导文案随第一个改动服务端行为的 PR 一起发出。不做自动选型引擎。

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

## Entry points that start new sessions today

Every session can run turns, so every creation door is in scope, not only
worker sessions.

| Entry point | Where | How provider / model / effort are chosen today |
| --- | --- | --- |
| `neo.todo.add` start target | `packages/daemon/src/lib/neo/driver-work.ts:39` (schema), `:83` (add target), `:138` (`driverWorkCall`), dispatched by `packages/daemon/src/lib/neo/todo-runner.ts:479` | `provider`, `model`, `effort` all optional (`driver-work.ts:51,66`); omitted fields are dropped from the `work.start` input (`driver-work.ts:165`). The trigger. |
| `work.start` operation | `packages/daemon/src/lib/drivers/work-operations.ts:210` (input), `:1302` (pipeline) | `model`/`provider`/`effort` optional (`:240-242`). Gates only reject values a route cannot confirm (`:614`, `:625`); absent values pass. Fresh start records whatever the adapter reports (`:752`). |
| Worker reuse inside `work.start` | `work-operations.ts:811` (`reuseIdleWorker`), `:796` (`matchesRequested`) | Configuration is resolved only when `model` or `effort` was requested (`:896`); with neither, any recorded worker identity is accepted (`:1016`, `:1135`). Desktop worker templates strip model and provider from the resolved request (`:841`, `:901`). |
| Remote daemon start | `work-operations.ts:614` (`admitRemoteStartModel`), `:625` (`admitStartEffort`), `:699` (`admitRemoteCopilotStart`) | A start forwarded to a paired daemon refuses any explicit model or effort unless the Copilot-client handshake happened to mark the route `verifiedCopilotStart` (`:727`). So today a remote start (e.g. `claude-desktop` on another Mac) must omit the model entirely — the opposite of required identity. |
| Coding pack review/verify assign | `packages/daemon/src/lib/neo/packs/coding/assign-operation.ts:228` | Candidates are `CodingStageTarget` = adapter/place/model/effort, model and effort optional (`stage-preferences.ts:9`). Preference scoring covers harness/effort only (`stage-preferences.ts:37`); the unavailability fallback retries a default candidate (`assign-operation.ts:269`) that may carry no identity at all. |
| Coding write plan | `packages/daemon/src/lib/neo/packs/coding/assignments.ts:48` | Same `CodingStageTarget` schema and scoring; the write worker itself starts through `work.start`. |
| Goal session (`goal.session.create` with `ownSession`) | `packages/daemon/src/lib/goals/goal-session-start.ts:14` | Copies the parent session's `model`, `provider`, `thinkingLevel` and drops whichever are undefined (`:16-23`); dropped fields fall to lifecycle defaults. |
| Session clone (`session.clone.spawn`) | `packages/daemon/src/lib/session/clone-operations.ts:220` | Inherits the parent config; optional overrides. Same undefined-inheritance gap as goals. |
| Human UI session with a workspace | `packages/daemon/src/lib/rpc-handlers/session-handlers.ts:188` | Passes `req.config` through; a missing model resolves from global settings and a configured default (`session-lifecycle.ts:1292`, `new-session-model.ts:42`), with a fallback chain and newest-available last resort (`new-session-model.ts:106-128`). Thinking level defaults to global settings (`session-lifecycle.ts:292`). |
| Human UI quick create (command palette) | `packages/web/src/lib/default-commands.ts:29` | Sends `{ workspacePath: undefined }` — no config at all — so model and thinking come entirely from daemon defaults. |
| Neo coordinator session | `packages/daemon/src/lib/neo/service.ts:1169` | Config carries model/provider/thinkingLevel only when a model preference is recorded (`:1170-1186`); otherwise the same lifecycle defaults. |
| Neo front conversation session | `packages/daemon/src/lib/neo/front-session.ts:84` | Created with a partial config (`:87-99`); unset fields fall to lifecycle defaults. |
| HyperNeo driver session (`work.start` on adapter `hyperneo`) | `packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts:188` (`createDriverSession`) | Template model/thinking when a worker template applies (`:208-209`); provider-only requests pick the newest available model (`:242`); a failed creation retries on the newest available model (`:253-258`). Adapter-side validation refuses unknown values but not absent ones (`hyperneo-adapter.ts:698`). |
| Direct task sessions | `packages/daemon/src/lib/tasks/prepare-direct-session.ts:125` | `createSessionFromInit` fills `model ?? defaultModel` (`agent-session.ts:1097`) where the default is an env var or the literal `'default'` (`config.ts:111`); thinking level stays unset and is decided at query time (`query-options-builder.ts:919`). The construction passes no identity of its own. |
| Query-time effort resolution | `query-options-builder.ts:830-875` | Not an entry point, but the place where an unrecorded level silently becomes a provider default effort — the divergence in the trigger. |
| Handoffs and focused discussions | `drivers.ts:758` (`handoffPromptToMailbox`), `packages/daemon/src/lib/neo/ask-record-operations.ts:486` | Deliver to an existing session; they start nothing new and need no gate. |
| `work.reconfigure` | `packages/daemon/src/lib/drivers/work-reconfigure.ts:26` | Switches a live daemon-started HyperNeo session and records previous/next identity (`:128`). Maintains the recorded values the reuse check reads. |

## Per-adapter identity mapping

`provider` names the account/backend a session runs on. Each adapter declares
its identity facts once — `fixedProvider`, whether it is `configurable`
(has `resolveStartConfiguration`), and, for non-configurable adapters, a
pre-dispatch identity read — and the gate reads the declaration instead of
branching on adapter ids.

| Adapter | provider | model | effort |
| --- | --- | --- | --- |
| `hyperneo` | From the explicitly named model's catalog entry (`hyperneo-adapter.ts:708`) or the request; both must agree | Required in the request | Required in the request (thinking-level ID or label, `start-configuration.ts:21`) |
| `codex-desktop` | Fixed: the Codex account | Required; resolved against the `model/list` catalog (`codex-start-configuration.ts:46`) | Required; resolved against the selected model's supported efforts (`codex-desktop-adapter.ts:1699`) |
| `copilot-cli` / Copilot desktop | Fixed: GitHub Copilot | Required already (`copilot-adapter.ts:115`) | Required (`copilot-adapter.ts:637`; desktop capability `copilot-desktop-adapter.ts:155`) |
| `antigravity` | Fixed: the Antigravity account | Required (`antigravity-configuration.ts:29`) | Required (`antigravity-adapter.ts:180`) |
| `claude-desktop` | Fixed: Anthropic | The adapter must read the app's configured model before dispatch and state it in the receipt; explicit overrides keep refusing `unsupported_model` (`claude-desktop-adapter.ts:1487`). Until that read exists, start refuses `identity_required` | Same rule as model. The transcript observer is not a substitute: it runs after the first turn and can observe neither field (`claude-runtime-identity.ts:18-27`) |
| `cursor` | Fixed: the Cursor account | Same rule as `claude-desktop`: a pre-dispatch read of the CLI configuration, or refusal (`cursor-start.ts` has no model/effort parameters today) | Same as model |
| Claude Code inbox / discovery-only adapters | Fixed per adapter | No start capability; nothing to validate | — |

There is no “start now, confirm later”: a start either carries a fully
determined triple before dispatch or it is refused. `identityObservation`
(`types.ts:83`) stays as post-hoc corroboration in status reads; receipts
never depend on it.

## Design

One pure gate, one declaration per adapter, no new layers.

### The gate

Add `requireIdentity` to `workStartConfiguration` in
`packages/daemon/src/lib/drivers/start-configuration.ts`, in the same superpipe
style as `select`/`confirm` with a typed `result:identity` rejection output:

```
input:  request  { adapter, provider?, model?, effort? }
        facts    { fixedProvider?, catalogProvider?, configurable: boolean,
                   declared?: { model, effort } }
output: { value: { provider, model, effort } }            — fully determined triple
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
2. Model and effort: for a configurable adapter both must be present in the
   request. For a non-configurable adapter they come from the adapter's
   declared pre-dispatch read (`facts.declared`); no declaration refuses.
   Absent values never fall back to global settings, “newest available” or
   templates the caller did not name.
3. Refusals reuse the existing vocabulary — `unsupported_model`,
   `unsupported_effort` — plus one new reason, `identity_required`, added to
   `WorkRejectionSchema` (`types.ts:128`), whose detail names every missing or
   conflicting field: `identity_required: name provider, model and effort for
   new work (missing: effort)` or `identity_required: adapter claude-desktop
   runs on provider anthropic, not openai`.

### Wiring

- `work.start`: one pipeline step after `admitStartEffort`
  (`work-operations.ts:1323`). The resolved triple is written back into the
  pipeline input, so reuse and start consume the same values: the desktop
  carve-outs that strip model/provider (`work-operations.ts:841`, `:901`) are
  deleted — a desktop worker template's ordered model list is recorded
  configuration and enters the request like any other explicit value.
  Worker-template and coding-pack candidates count as explicit sources the
  same way: recorded configuration named by the caller, never a global
  default.
- Reuse compares all three confirmed actuals on every path: the idle-reuse
  match (`work-operations.ts:796`, `:1016`) and the queued/busy-worker
  confirmation (`:1135-1139`) run against the complete requested triple, and a
  worker whose recorded identity is missing any field is not reused — a fresh
  start is. `work.reconfigure` keeps those recorded values current.
- `neo.todo.add`: validate a start target with the same pure gate at admission
  (facts from the adapter registry), so a target missing effort is rejected
  when the todo is written, not when it dispatches.
- Remote daemon starts: the remote daemon's `work.adapters` catalog already
  crosses the wire (`work-operations.ts:1645`, schema `:346`); each adapter
  entry gains its declared identity facts (`configurable`, `fixedProvider`,
  whether effort is supported). The local route gate then requires the full
  triple as usual and admits it only when the remote adapter advertises
  configuration support — replacing both the blanket refusal in
  `admitRemoteStartModel` (`:614`) and the Copilot-only `verifiedCopilotStart`
  special case (`:727`) with one generic mechanism. Final validation and the
  actual-value receipt happen on the daemon that owns the session, which is
  the environment boundary; the forwarding daemon records that receipt
  verbatim. A remote daemon too old to advertise refuses with `unsupported`
  naming the gap.
- Session lifecycle: `SessionManager.createSession`
  (`session-lifecycle.ts:286`) refuses any new session whose config lacks the
  recorded triple, instead of substituting `globalSettings.thinkingLevel` and
  the default-model chain. Each door supplies its triple from a named source:
  - UI sessions (workspace and quick create): the client sends the model and
    thinking selection it displays (`default-commands.ts:29` today sends
    none); the picker state is the explicit source, so human behavior is
    unchanged.
  - Neo coordinator and front sessions: the recorded Neo model preference
    (`service.ts:1170`, set through `neo.front.model.set`) is the source;
    creation refuses when it is unset, and setup asks for it once.
  - Goal sessions and clones: inherited parent values count when recorded;
    a parent missing any field refuses (`goal-session-start.ts:16` stops
    dropping undefined fields silently).
  - Direct task sessions: the task's recorded configuration (its space or
    agent model settings) is the source; `prepare-direct-session.ts:125`
    resolves the triple before `createSessionFromInit` and refuses when the
    task carries none — the env-var `defaultModel` (`config.ts:111`) stops
    being a session identity.
  - Existing sessions and legacy configs are untouched: the gate runs at
    creation, and `work.reconfigure` governs later changes.

### Receipts

`WorkStarted` (`types.ts:238`) and the persisted start facts
(`work-operations.ts:752`, `recordStarted`) must carry provider, model and
effort for every daemon-started session — actual values, not requested ones.
For non-configurable adapters these are the adapter's pre-dispatch declared
values, corroborated afterwards by `identityObservation` where the harness
reports them. The worker provenance brief (`worker-provenance.ts:12`) then
never prints `unknown` for a daemon-started worker, and `neo.todo.read`
verification compares the recorded triple against the todo target.

### Neo guidance, same PR as the first server behavior

- `packages/prompts/src/neo/tools/work.start.md`: replace “Without model, a new
  HyperNeo session starts on the default model…” and the “Optional effort…”
  sentences with the required-triple rule, the `identity_required` refusal,
  the per-adapter fixed-provider note and the remote-start rule (explicit
  triple admitted when the remote adapter advertises support).
- `packages/prompts/src/neo/tools/neo.todo.add.md:8`: the start target shape
  becomes `{verb:start,adapter,model,effort,provider?,place?}` — provider
  optional only where the adapter fixes or derives it.
- A short difficulty table in `work.start.md` so Neo picks effort by task, no
  selection engine: trivial lookups → low, ordinary changes → medium, hard
  debugging or design → high, rare deepest work → max, with the adapter's
  supported values as the vocabulary.

## Slices

Three merge contracts, each independently safe; no standalone pin slice —
tests asserting the old fallbacks would only pin behavior the same PRs
remove, so each wiring PR carries its own failing-then-passing assertions.

1. **Build** (≈150 production lines): the pure gate, the `identity_required`
   reason, per-adapter fact declarations including the `work.adapters`
   catalog fields. Exported and tested, not yet called; nothing observable
   changes.
2. **Wire: work dispatch** (≈250 production lines): the `work.start` pipeline
   step with triple propagation into reuse and start, deletion of the desktop
   stripping carve-outs, `neo.todo.add` admission, remote advertisement
   replacing `admitRemoteStartModel`/`verifiedCopilotStart`, and the prompt
   changes above. After this merge, every agent-dispatched start requires the
   triple; no door this slice touches retains a fallback.
3. **Wire: session lifecycle** (≈250 production lines): the lifecycle
   boundary plus each door's named source (UI clients, Neo preference, goal
   and clone inheritance, direct tasks), and in the same PR the deletion of
   the fallbacks it replaces — the newest-available retry
   (`drivers.ts:253-258`), the provider-only newest pick (`drivers.ts:242`)
   and the global thinking-level default for new sessions
   (`session-lifecycle.ts:292`). The gate and the fallback removal land
   together so no fallback stays reachable behind a merged gate.

## Out of scope

- Any automatic provider/model selection engine; Neo chooses per task with the
  guidance table.
- Cross-adapter model equivalence or capability negotiation beyond the
  existing catalogs.
- Retrofitting identity onto sessions that already exist.
- Human sign-in, payment and other delegation preferences; unrelated.
