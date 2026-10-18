# OAP as HyperNeo's model backend: plan

Plan only; nothing here is implemented yet. It is based on `dev` at 45775eb676 (after #7439 and #7444) and `open-agent-protocol` at d584fd5c68 (0.1.0-alpha.21 prepared). Inputs: a research note on Engine/Provider/Model selection in Global Settings (2026-10-17), the [OAP section of the driver model](neo-driver-model.md#oap), and the provider fixes #7398, #7430, #7433, #7439, #7441 and #7444.

A session is one harness (an agent loop with its tools) running one provider's model. When several harnesses can run a provider, the user picks one. Each provider has a default harness, and a session can override it.

| Provider | Default harness | Other harnesses |
| --- | --- | --- |
| Claude (Anthropic subscription) | Claude Agent SDK, as today; not through OAP | — |
| GLM, Kimi | oapx's own loop and tools (`--backend oapx`) | Pi, Claude Code, Codex CLI/app-server, through their oapx adapters |
| DeepSeek | oapx's own loop and tools | DeepSeek's own harness (oapx `deepseek` adapter), Pi, Claude Code, Codex CLI/app-server |
| Codex | Native Codex CLI/app-server driven by oapx (`--backend codex`) | — |
| Copilot | Native Copilot CLI/server driven by oapx | — |
| OpenCode | Native OpenCode server driven by oapx (`--backend opencode`) | — |
| Devin | Its ACP agent through oapx's `acp` backend | — |

Everything except Claude runs through one long-lived `oapx serve` child the daemon owns. MiniMax, OpenRouter, Ollama and custom endpoints are not in the matrix yet. They stay on today's path until the human places them.

## 1. What OAP replaces, and what stays

Today every non-Anthropic model reaches the Claude Code CLI by pretending to be Anthropic: env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_*_MODEL`, auth token) plus a loopback bridge that translates wire formats. Most of today's bugs came from that layer: #7398 (key in the subprocess env), #7439 (shared `process.env` leak), #7444/#7441 (GLM aliases in the Anthropic list). OAP removes that layer for every provider that moves.

**Settings.** Harness choice is per provider × harness:
- Each provider row's `config_json` gains `harness`, its default.
- The allowed harnesses per provider are the matrix above, kept as one static table in code.
- A session stores the `harness` it started with, and the new-session picker can override it.
- `claude-sdk` means today's `QueryRunner`; every other value runs through oapx.

Replaced or deleted as each provider moves (paths are under `packages/daemon/src/lib/`):

| Move | Deleted after the move | Kept, and why |
| --- | --- | --- |
| GLM, Kimi, DeepSeek → oapx loop | Their `buildSdkConfig` routing env and hard-coded `static MODELS` in `providers/glm-provider.ts`, `kimi-provider.ts`, `deepseek-provider.ts`; models come from oapx's `models` endpoint. | `providers/anthropic-messages-bridge/server.ts` and `provider-key-bridge.ts` (#7398) stay as the credential route (section 2). |
| Codex → native Codex | `providers/anthropic-to-codex-bridge-provider.ts` (1,282 lines), `codex-model-discovery.ts`, `codex-models.ts`, and `providers/openai-responses-bridge/` (1,776 lines; Codex is its only user). | — |
| Copilot → native Copilot | `providers/anthropic-copilot/*`, and its entries in `credential-discovery.ts`, `model-service.ts`, `agent/context-fetcher.ts`, `query-options-builder.ts` and `factory.ts`. | — |
| OpenCode → native OpenCode | `providers/opencode-provider.ts` routing and `opencode-catalogue.ts`. | `providers/openai-chat-bridge/` stays: custom endpoints still use it. |
| Devin → ACP | Nothing; it is a new provider. | `acp/*` (the existing ACP runner) can later move onto oapx's `acp` backend; this is optional and comes last. |
| Last non-Claude provider moved | `provider-service.ts` routing env (`providerProcessEnv`, `clearProviderRoutingEnvVars`, `PROVIDER_ROUTING_ENV`, `userConfigured*`), `providers/session-provider-env-pipeline.ts`, `provider-env-coordinator.ts`, `provider-env-enrollment.ts`, and the per-provider env plumbing in `agent/query-runner.ts` and `query-options-builder.ts`. | `provider-anthropic-compat/*`, `anthropic-non-streaming.ts`, `ollama-bridge-server.ts` and `ollama-native-bridge/` stay while MiniMax, OpenRouter, Ollama or custom endpoints still use them. |

New code:
- `agent/oap/`: hub supervisor, config generator, client wrapper, OAP→SDK message translator, and `OapQueryRunner`.
- `providers/oap-models.ts`: model listing from the hub.
- `providers/harness-matrix.ts`: the static provider × harness table.
- A third branch in the runner seam in `agent/agent-session.ts:596` and `:979`, beside `QueryRunner` and `AcpQueryRunner`.

Stays unchanged:
- **Claude** stays on the Agent SDK: `anthropic-provider.ts`, `query-runner.ts`, `sdk-message-handler.ts`, `turn-end-routing.ts`, `sdk-cli-resolver.ts`.
- **Credentials:** the credential store and credential discovery (#7430).
- **Session flow and storage:** `model-switch-handler.ts` (it gains a harness check), the `sdk_messages` storage, LiveQuery `messages.bySession`, the web and iOS clients, and Neo's `WorkAdapter` drivers.

## 2. What we lose or rebuild, and how we handle each

| Area | What changes under OAP | How we handle it |
| --- | --- | --- |
| Credentials | OAP never carries keys on the wire, and the hub has no per-session env (Decisions 0025/0029). | There are two routes, depending on the harness. **Key-based providers** (GLM, Kimi, DeepSeek), on any harness that takes an Anthropic-wire endpoint (oapx loop, Pi, Claude Code): the generated hub config points `base_url` at the #7398 `anthropic-messages` bridge, and the hub's only secret is the bridge's random token, passed through the entry's `environment` allowlist. Running them under Codex needs an OpenAI-wire endpoint; we build that only if someone turns the combination on. **Native harnesses** (Codex, Copilot, OpenCode, Devin): the daemon holds no key. Each harness uses its own login, and the hub entry forwards only that harness's own config-dir variable. |
| Built-in tools | Each harness brings its own tools: the oapx loop's workspace tools, or the native harness's own. | Accept the difference. Map their tool events onto our tool-use rendering. Check behaviour on the real Neo work before moving more providers. |
| Daemon MCP tools (operations `invoke`, Neo turn, db-query, agent-memory) | These are in-process SDK MCP servers today; oapx cannot load them. | Offer them as client-provided tools (`action.tools.provide`, Decision 0011) where the adapter supports it; the oapx loop does. Answer the calls in the daemon from the same handlers. The ACP runner's `mcp-proxy-bridge.ts` is the precedent. For adapters without client tools, list the gap in the OAP inventory. |
| External MCP servers (app registry) | oapx attaches only the `tool_sources` declared in the hub config at startup. | Write the enabled registry entries into the generated config. A registry change regenerates the config, but it only takes effect at the next hub restart, made while no OAP turn is running. Until then it waits. |
| Sessions and transcripts | The hub keeps sessions only in memory; `transcript-load` is a staged unit, not available yet. | The daemon stays the source of truth. The translator writes OAP events into `sdk_messages` in today's shapes, so web, iOS, Neo and LiveQuery do not change. |
| Hub restart (sessions owned by the hub) | A hub restart kills every live OAP session, pending prompt and replay. | The daemon supervises one hub. When it restarts, each affected session goes idle with one notice ("engine restarted"). The next message opens a fresh OAP session seeded with the daemon's context-reset summary. Native harnesses that reopen by id (Claude Code `--resume`, Pi `switch_session`) use that instead where the adapter supports it. Never restart the hub while an OAP run is active. Push upstream for `transcript-load` and `session-reattach`. |
| Daemon restart | Same as a hub restart: the hub is the daemon's child. | Same as above. On startup, sessions that were running come back idle with the notice. |
| Compaction | The oapx loop compacts by its session policy (Decisions 0044/0045); native harnesses compact their own way. | Set the policy at open where the adapter takes one. Map compaction runs to our `compact_boundary` message and context-usage updates. Remove the SDK-only compaction triggers for OAP sessions. |
| Permissions and questions | These arrive as `action.permission.requested` and `user.input.requested`. | Route them to the existing permission prompt and the AskUserQuestion handler. Run in ask mode. Neo's look-up guard (no credential reads) runs in the daemon's permission responder, because SDK hooks no longer apply. |
| Checkpoints, rewind, SDK hooks, mid-turn injection | These are SDK features with no OAP equivalent. | Hide rewind for OAP sessions. Hook-based guards move to the permission responder (above). Mid-turn messages use OAP's run queue (up to eight waiting runs). |
| Desktop threads (claude-desktop, codex-desktop) | OAP cannot attach to desktop threads. | No change. Neo's Desktop adapters stay as they are; this plan only covers sessions the daemon runs. |
| Model and harness switch | OAP has `session.model.switch`. | Map our `session.model.switch` to it within one harness. Switching harness starts a new OAP session seeded from the summary. Refuse it mid-run. |

## 3. Staged rollout behind the per-provider harness setting

Every provider's default stays at today's path until its step. A session picks its runner from its own `harness`, or else its provider's default, when it starts.

1. **Neo's own GLM sessions on the oapx loop.** A Neo-scoped override sets `harness: oapx` for the GLM sessions Neo runs. Other GLM sessions stay on today's path.
2. **Compare on real work for about a week.** Measure from the daemon's own logs and rows, with a `harness` label on every turn:
   - turn reliability: completed vs failed vs stuck turns per 100;
   - restart recovery: what fraction resume correctly after a daemon restart;
   - tool and MCP calls: success rate, and permission prompts per turn;
   - latency to first token.

   Go/no-go is the human's call, based on these numbers.
3. **Make the oapx loop the default for GLM, Kimi and DeepSeek**, one provider at a time.
4. **Move the native-harness providers, one at a time: Codex, Copilot, OpenCode.** Each move is two PRs:
   - a cutover that sets the provider's default harness to its native harness;
   - a deletion-only PR that removes what section 1 lists for it.
5. **Add Devin through the `acp` backend**, as a new provider.
6. **Open the other harnesses as choices.** For GLM, Kimi and DeepSeek: Pi, Claude Code, and DeepSeek's own harness for DeepSeek. Codex CLI comes only if the OpenAI-wire endpoint is built. Each is offered in the new-session picker once a smoke check passes.
7. **Claude stays on the Agent SDK.** It is out of scope.

## 4. Ordered small PRs

Each PR is about 100–200 production lines, merges from fresh `dev`, and is deployable and testable alone. Verification runs on the laptop daemon, or on an isolated daemon (NODE_ENV=test, own data dir and DB, no provider keys in env).

| # | PR | Verify after deploy |
| --- | --- | --- |
| 1 | A new ADR (next free number): the provider × harness model, the two credential routes, the restart policy, and decisions b–c (docs only). | The ADR is merged and linked from `neo-driver-model.md`. |
| 2 | oapx binary resolution: a pinned version and SHA256, a per-platform download into the data dir, and an `engines.status` operation reporting found/version/adapters. | `operation.invoke engines.status` shows the pinned version; a wrong checksum is refused. |
| 3 | Hub supervisor and config generator: start `oapx serve --addr 127.0.0.1:<free>` with its own state dir and a generated config holding no keys; restart on crash, stop with the daemon. | `ps` shows one child; killing it brings back one new child; stopping the daemon leaves no oapx process. `~/.oapx` is untouched. |
| 4 | `oap-client` dependency per decision (c), plus a thin typed wrapper; tests run against `--backend memory`. | `engines.status` lists the hub's adapters. |
| 5 | OAP→SDK message translator as pure functions, with fixtures recorded from the memory backend. | `engines.status` gains a `translatorSelfTest: ok` field from a fixture round-trip. |
| 6 | Harness matrix and settings: `providers/harness-matrix.ts`, `harness` in provider `config_json` and session config, and the picker override. Every default is still today's path. | Providers settings shows each provider's allowed harnesses and its default; a new session records the harness it started with. |
| 7 | `OapQueryRunner` (open, submit, stream, cancel, close) and the runner-seam branch for any non-`claude-sdk` harness. | An isolated daemon with a test provider on `--backend memory`: a message gets the scripted reply, which appears in the web chat. |
| 8 | Key-based credential route: the generated config points GLM's oapx-loop entry at the #7398 bridge, with only the bridge token in `environment`. | On the laptop, a GLM test session on `harness: oapx` replies. `printenv` inside it shows no provider key. The hub config file holds no key. |
| 9 | Permissions and questions: map them to the existing prompt UI and the AskUserQuestion handler; Neo's look-up guard runs in the responder. | In an OAP session, a permission prompt appears in the web UI and approving it continues the run. A Neo OAP session trying to read `.env` is refused. |
| 10 | Daemon tools as client-provided tools (operations `invoke`, Neo turn tool, db-query, agent-memory). | A Neo OAP session calls `operations.list` and `neo.snapshot` successfully. |
| 11 | Restart handling: one "engine restarted" notice, then a seeded reopen on the next message; the hub is never restarted mid-run. | Kill the oapx child while a session is idle: one notice appears, and the next message continues with context. A daemon restart gives the same result. |
| 12 | `harness` label on turn metrics, plus a per-harness summary operation. | `engines.metrics` returns counts per harness for the last 24 hours. |
| 13 | Neo-scoped override: Neo's GLM sessions use `harness: oapx` (rollout step 1). | `neo.snapshot` shows Neo sessions on the oapx loop; a day of Neo work runs with no stuck turns. |
| 14–16 | One cutover per provider: GLM, then Kimi, then DeepSeek, each defaulting to the oapx loop. | That provider's new sessions reply through OAP, and its model list matches oapx `models`. |
| 17 | Deletion-only: the routing env and `static MODELS` of GLM, Kimi and DeepSeek. | Their sessions still reply; `grep` finds no `ANTHROPIC_DEFAULT_*_MODEL` writer for them. |
| 18 | Native-harness entries: hub config entries for Codex, Copilot and OpenCode that forward only each harness's own config-dir variable. | `engines.status` shows the three adapters ready, with no key in the config file. |
| 19, 21, 23 | Cutovers to the native harness: Codex, Copilot, OpenCode. | That provider's session replies through its native harness; the old bridge's port is no longer opened. |
| 20, 22, 24 | Deletion-only, after each cutover: what section 1 lists for Codex, Copilot and OpenCode. | That provider's sessions still reply. |
| 25 | Devin through the `acp` backend: a provider row and its hub entry. | A Devin session replies through oapx's `acp` backend. |
| 26 | Extra harness choices for GLM, Kimi and DeepSeek (Pi, Claude Code, DeepSeek's own harness), each behind a smoke check. | The picker offers them, and a session on each one replies. |
| last | Deletion-only: the env coordinator and routing-env plumbing listed in the last row of section 1, once only Claude runs on the SDK. | `grep` finds no non-Anthropic writer of `ANTHROPIC_*` env; all provider sessions still reply. |

## 5. Blockers, risks and decisions

Blockers and risks:
- **Maturity.** oapx is 0.1.0-alpha.20/21 with no v0.1 tag; the schema can change. Pin one binary version and the client to that commit; bump deliberately.
- **Restarts lose sessions.** There is no `transcript-load` or reattach yet, so a hub or daemon restart costs live context. The seeded reopen softens this but does not restore it exactly.
- **Packaging.** oapx is a separate Zig binary for each OS and architecture. It has to be downloaded and checksummed at first use, or bundled in the npm package and the Tauri app. The Deno daemon path needs the same spawn support (`lib/runtime-spawn/`).
- **Local security.** The hub has no authentication; it relies on a loopback bind plus Host checks. Any local process can drive it. We bind a random port and never expose it.
- **Shared state.** oapx defaults to `~/.oapx`, which is shared with the human's TUI. The daemon must give it its own state dir. Native harnesses still need their own logins, so a hub entry forwards only that harness's config-dir variable and nothing else.
- **Copilot and Devin adapters.** oapx's catalog pins adapters for Claude Code, Codex, Pi, ACP, Hermes, DeepSeek and OpenCode. Copilot has no adapter of its own, and Devin depends on its ACP agent. Both need confirming in the OAP protocol-gap inventory before their steps.
- **Behaviour drift.** The oapx loop's tools and prompts differ from Claude Code's, so results on the same model may differ. That is what the comparison step measures.
- **Event coverage.** Thinking, tool progress and usage events may not map one-to-one to SDK messages. The translator tests pin the mapping, and gaps are shown rather than hidden.

Decisions for the human:

| Decision | Recommendation | Why |
| --- | --- | --- |
| (a) Does Claude go through OAP? | Decided: no. Claude stays on the native SDK. | Claude would lose checkpoints, hooks, mid-turn injection and restart resume, while gaining nothing it lacks today. |
| (b) Model library: curated list or our hosted gateway with our keys? | A curated list. | A hosted gateway is a billing and auth product outside this repo, and it can be added later as one more provider behind the same list. |
| (c) `oap-client` from npm or vendored? | Publish it to npm from the OAP repo and pin it exactly, with vendoring only as a stopgap. | Both repos are ours, CI requires exact versions, and a vendored copy drifts from the protocol it tracks. |
