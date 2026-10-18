# OAP as HyperNeo's model backend: plan

Plan only; nothing here is implemented yet. It is based on `dev` at 45775eb676 (after #7439 and #7444) and `open-agent-protocol` at d584fd5c68 (0.1.0-alpha.21 prepared). Inputs: a research note on Engine/Provider/Model selection in Global Settings (2026-10-17), the [OAP section of the driver model](neo-driver-model.md#oap), and the provider fixes #7398, #7430, #7433, #7439, #7441 and #7444.

In this plan, "OAP engine" means the daemon runs a session through one long-lived `oapx serve` child it owns. Non-Anthropic models use oapx's own loop (`--backend oapx`). GLM, Kimi, MiniMax, DeepSeek, OpenRouter, OpenCode Go and Ollama are already in oapx's provider catalog, and any Anthropic-wire endpoint can be declared as a custom provider.

## 1. What OAP replaces, and what stays

Today every non-Anthropic model reaches the Claude Code CLI by pretending to be Anthropic: env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_*_MODEL`, auth token) plus a loopback bridge that translates wire formats. Most of today's bugs came from that layer: #7398 (key in the subprocess env), #7439 (shared `process.env` leak), #7444/#7441 (GLM aliases in the Anthropic list). OAP removes that layer for every provider that moves.

Replaced, provider by provider as each one moves (paths are under `packages/daemon/src/lib/`):

| File | Today | With OAP |
| --- | --- | --- |
| `providers/glm-provider.ts`, `kimi-provider.ts`, `minimax-provider.ts`, `deepseek-provider.ts`, `openrouter-provider.ts`, `opencode-provider.ts`, `ollama-provider.ts` | `buildSdkConfig` sets Claude Code routing env; hard-coded `static MODELS` | Shrink to credentials plus an `engine: 'oap'` route; models come from oapx's `models` endpoint. The routing env code is deleted. |
| `providers/openai-chat-bridge/server.ts` (905 lines), `openai-responses-bridge/server.ts` (1,776 lines), `provider-anthropic-compat/*`, `anthropic-non-streaming.ts` | Translate Anthropic wire to OpenAI wire for the CLI | Deleted once no SDK provider needs them; oapx talks to each API natively. |
| `providers/ollama-bridge-server.ts`, `ollama-native-bridge/` | Ollama to Anthropic wire | Deleted; oapx has an `ollama` provider. Local Ollama needs no key; Ollama Cloud uses the pass-through proxy below. |
| `providers/anthropic-to-codex-bridge-provider.ts` (1,282 lines), `codex-model-discovery.ts` | Codex models behind the Anthropic wire | Moved to oapx `--backend codex` or the `openai-codex` provider; deleted after. |
| `providers/anthropic-copilot/*` | Copilot behind the Anthropic wire | oapx `github-copilot` provider; deleted after. |
| `provider-service.ts`: `providerProcessEnv`, `clearProviderRoutingEnvVars`, `PROVIDER_ROUTING_ENV`, `userConfigured*` | Builds each SDK child's env and strips other providers' vars | Shrinks to the Anthropic case only. |
| `providers/session-provider-env-pipeline.ts`, `provider-env-coordinator.ts`, `provider-env-enrollment.ts` | Coordinate shared env and per-session env | Deleted when only Anthropic remains on the SDK. |
| `agent/query-runner.ts`: `refreshQueryEnvFromProcess`, `PROVIDER_MANAGED_ENV_VARS`, `applyProviderEnvToFlagSettings`, `NON_ANTHROPIC_PREFIX_PROVIDER_VARS` | Per-provider env and flag-settings plumbing | Reduced to the Anthropic path. |
| `agent/query-options-builder.ts` (env block, about lines 860–950) | Provider env merge | Anthropic only. |
| `acp/*` (`acp-query-runner.ts` 1,752 lines, and others) | Separate ACP runner | Later moved onto oapx `--backend acp`, then deleted. This is optional and comes last. |

New code:
- `agent/oap/`: hub supervisor, client wrapper, OAP→SDK message translator, and `OapQueryRunner`.
- `providers/oap-models.ts`: model listing from the hub.
- A third branch in the runner seam in `agent/agent-session.ts:596` and `:979`, beside `QueryRunner` and `AcpQueryRunner`.

Stays unchanged:
- **Claude** stays on the Agent SDK: `anthropic-provider.ts`, `query-runner.ts`, `sdk-message-handler.ts`, `turn-end-routing.ts`, `sdk-cli-resolver.ts`.
- **Credentials:** the credential store and credential discovery (#7430).
- **Session flow and storage:** `model-switch-handler.ts` (it gains an engine check), the `sdk_messages` storage, LiveQuery `messages.bySession`, the web and iOS clients, and Neo's `WorkAdapter` drivers.
- **Credential bridge:** `providers/anthropic-messages-bridge/server.ts` and `provider-key-bridge.ts` from #7398 stay. They become how oapx reaches an Anthropic-wire provider's key without seeing it. Providers on another wire need a protocol-native pass-through proxy instead (see section 2).

## 2. What we lose or rebuild, and how we handle each

| Area | What changes under OAP | How we handle it |
| --- | --- | --- |
| Credentials | OAP never carries keys on the wire, and the hub has no per-session env (Decisions 0025/0029). | Each provider is declared in the generated hub config as an oapx custom provider in its own wire format, with `base_url` set to a daemon loopback proxy. The proxy forwards that wire unchanged and only swaps a random token for the real key. Anthropic-wire providers (GLM, Kimi, MiniMax, DeepSeek, OpenRouter's Anthropic endpoint) reuse the #7398 `anthropic-messages` bridge. OpenAI-wire providers (OpenCode Go, Ollama Cloud, Copilot, Codex) need a new pass-through proxy for `openai-completions` and `openai-responses`, which forwards without translating. Local Ollama needs no key. The only secret oapx holds is the proxy token, passed via the entry's `environment` allowlist; real keys stay in daemon memory. |
| Built-in tools | Claude Code's tools (Read/Edit/Bash/…) are replaced by the oapx loop's workspace tools and permission engine. | Accept the difference. Map their tool events onto our tool-use rendering. Check behaviour on the real Neo work in step 3 before moving more providers. |
| Daemon MCP tools (operations `invoke`, Neo turn, db-query, agent-memory) | These are in-process SDK MCP servers today; oapx cannot load them. | Offer them as client-provided tools (`action.tools.provide`, Decision 0011, supported by the oapx adapter). Answer the calls in the daemon from the same handlers. The ACP runner's `mcp-proxy-bridge.ts` is the precedent. |
| External MCP servers (app registry) | oapx attaches only `tool_sources` declared in the hub config at startup. | Write the enabled registry entries into the generated config. A registry change regenerates the config, but it applies only when the hub next restarts while no OAP turn is running. Otherwise it waits. |
| Sessions and transcripts | The hub keeps sessions only in memory; `transcript-load` is a staged unit, not available yet. | The daemon stays the source of truth. The translator writes OAP events into `sdk_messages` in today's shapes, so web, iOS, Neo and LiveQuery do not change. |
| Hub restart (sessions owned by the hub) | A hub restart kills every live OAP session, pending prompt and replay. | The daemon supervises one hub. When it restarts, each affected session goes idle with one notice ("engine restarted"). The next message opens a fresh OAP session seeded with the daemon's context-reset summary (the same summary we use after context resets). Never restart the hub while an OAP run is active. Push upstream for `transcript-load` and `session-reattach`. |
| Daemon restart | Same as a hub restart: the hub is the daemon's child. | Same as above. On startup, sessions that were running come back idle with the notice. |
| Compaction | oapx compacts by its session policy (Decisions 0044/0045). | Set the policy at open. Map its compaction run to our `compact_boundary` message and context-usage updates. Remove the SDK-only compaction triggers for OAP sessions. |
| Permissions and questions | These arrive as `action.permission.requested` and `user.input.requested`. | Route them to the existing permission prompt and the AskUserQuestion handler. Run oapx in ask mode. Neo's look-up guard (no credential reads) runs in the daemon's permission responder, because SDK hooks no longer apply. |
| Checkpoints, rewind, SDK hooks, mid-turn injection | These are SDK features with no OAP equivalent. | Hide rewind for OAP sessions. Hook-based guards move to the permission responder (above). Mid-turn messages use OAP's run queue (up to eight waiting runs). |
| Desktop threads (claude-desktop, codex-desktop) | OAP cannot attach to desktop threads. | No change. Neo's Desktop adapters stay as they are; this plan only covers sessions the daemon runs. |
| Model switch | OAP has `session.model.switch`. | Map our `session.model.switch` to it for OAP sessions. Switching between engines (SDK↔OAP) starts a new OAP session seeded from the summary. Refuse it mid-run. |

## 3. Staged rollout behind a per-provider setting

The setting is a per-provider `engine` (`sdk` or `oap`) stored in the provider row's `config_json` and editable in Providers settings. The default is `sdk`. A session picks its runner from its provider's engine when it starts.

1. **Neo's own GLM sessions through OAP.** Turn on `engine: oap` for the GLM provider used by Neo's sessions only, using a Neo-scoped override. Other GLM sessions stay on the SDK.
2. **Compare on real work for about a week.** Measure from the daemon's own logs and rows, with an `engine` label on every turn:
   - turn reliability: completed vs failed vs stuck turns per 100;
   - restart recovery: what fraction resume correctly after a daemon restart;
   - tool and MCP calls: success rate, and permission prompts per turn;
   - latency to first token.

   Go/no-go is the human's call, based on these numbers.
3. **Move the other non-Anthropic providers one at a time,** in this order: Kimi, MiniMax, DeepSeek, OpenRouter, OpenCode Go, Ollama, Copilot, Codex. Each move is two PRs: a cutover that flips the provider's default engine, then a deletion-only PR that removes its translator bridge, routing-env code and `static MODELS` once nothing else uses them.
4. **Claude last, as a decision** (see 5a). It is not part of this plan's default path.

## 4. Ordered small PRs

Each PR is about 100–200 production lines, merges from fresh `dev`, and is deployable and testable alone. Verification runs on the laptop daemon, or on an isolated daemon (NODE_ENV=test, own data dir and DB, no provider keys in env).

| # | PR | Verify after deploy |
| --- | --- | --- |
| 1 | A new ADR (next free number) for the OAP engine, the per-wire loopback credential proxies, the restart policy, and decisions a–c (docs only). | The ADR is merged and linked from `neo-driver-model.md`. |
| 2 | oapx binary resolution: a pinned version and SHA256, a per-platform download into the data dir, and an `engines.status` operation reporting found/version/adapters. | `operation.invoke engines.status` shows the pinned version; a wrong checksum is refused. |
| 3 | Hub supervisor: start `oapx serve --addr 127.0.0.1:<free>` with its own HOME/state dir and a generated config holding no keys; restart on crash, stop with the daemon. | `ps` shows one child; killing it brings back one new child; stopping the daemon leaves no oapx process. `~/.oapx` is untouched. |
| 4 | `oap-client` dependency per decision (c), plus a thin typed wrapper; tests run against `--backend memory`. | `engines.status` lists the hub's adapters. |
| 5 | OAP→SDK message translator as pure functions, with fixtures recorded from the memory backend. It is reachable from the runner stub in #6. | `engines.status` gains a `translatorSelfTest: ok` field from a fixture round-trip. |
| 6 | `OapQueryRunner` (open, submit, stream, cancel, close) and the runner-seam branch, behind the per-provider `engine` setting (default `sdk`). | An isolated daemon with a test provider set to `engine: oap` on `--backend memory`: a message gets the scripted reply, which appears in the web chat. |
| 7 | Credentials: the generated config declares GLM as an `anthropic-messages` custom provider pointing at the daemon bridge, with only the bridge token in `environment`. | On the laptop, a GLM test session on `engine: oap` replies. `printenv` inside it shows no provider key. The hub config file holds no key. |
| 8 | Permissions and questions: map them to the existing prompt UI and the AskUserQuestion handler; Neo's look-up guard runs in the responder. | In an OAP session, a permission prompt appears in the web UI and approving it continues the run. A Neo OAP session trying to read `.env` is refused. |
| 9 | Daemon tools as client-provided tools (operations `invoke`, Neo turn tool, db-query, agent-memory). | A Neo OAP session calls `operations.list` and `neo.snapshot` successfully. |
| 10 | Restart handling: one "engine restarted" notice, then a seeded reopen on the next message; the hub is never restarted mid-run. | Kill the oapx child while a session is idle: one notice appears, and the next message continues with context. A daemon restart gives the same result. |
| 11 | `engine` label on turn metrics, plus a per-engine summary operation. | `engines.metrics` returns counts per engine for the last 24 hours. |
| 12 | Neo-scoped override: Neo's GLM sessions use `engine: oap` (rollout step 1). | `neo.snapshot` shows Neo sessions on OAP; a day of Neo work runs with no stuck turns. |
| 13 | Pass-through proxy for the `openai-completions` and `openai-responses` wires: forwards unchanged and swaps the token for the key. Needed before the first OpenAI-wire provider moves. | A test request through the proxy reaches a loopback stub with the key header set; the proxy rejects a wrong token. |
| 14+ | Per provider (Kimi, MiniMax, DeepSeek, OpenRouter, OpenCode Go, Ollama, Copilot, Codex), a cutover PR that flips its default engine to `oap`. | That provider's session replies through OAP, and the model list matches oapx `models` for it. |
| 14+ (after each cutover) | A deletion-only PR for that provider: its translator bridge, routing-env code and `static MODELS`. | That provider's sessions still reply, and the deleted bridge's port is no longer opened. |
| last | Delete the env coordinator, routing-env tables and the OpenAI bridges once only Anthropic uses the SDK. | `grep` finds no `ANTHROPIC_DEFAULT_*_MODEL` writer; all provider sessions still reply. |

## 5. Blockers, risks and decisions

Blockers and risks:
- **Maturity.** oapx is 0.1.0-alpha.20/21 with no v0.1 tag; the schema can change. Pin one binary version and the client to that commit; bump deliberately.
- **Restarts lose sessions.** There is no `transcript-load` or reattach yet, so a hub or daemon restart costs live context. The seeded reopen softens this but does not restore it exactly.
- **Packaging.** oapx is a separate Zig binary for each OS and architecture. It has to be downloaded and checksummed at first use, or bundled in the npm package and the Tauri app. The Deno daemon path needs the same spawn support (`lib/runtime-spawn/`).
- **Local security.** The hub has no authentication; it relies on a loopback bind plus Host checks. Any local process can drive it. We bind a random port and never expose it.
- **Shared state.** oapx defaults to `~/.oapx`, which is shared with the human's TUI. The daemon must run it with its own HOME/state dir so it cannot touch the human's logins.
- **Behaviour drift.** The oapx loop's tools and prompts differ from Claude Code's, so results on the same model may differ. That is what the comparison step measures.
- **Event coverage.** Thinking, tool progress and usage events may not map one-to-one to SDK messages. The translator tests pin the mapping, and gaps are shown rather than hidden.

Decisions for the human:

| Decision | Recommendation | Why |
| --- | --- | --- |
| (a) Does Claude go through OAP? | Not now. Keep Claude on the native SDK and revisit after `transcript-load` and reattach graduate. | Claude would lose checkpoints, hooks, mid-turn injection and restart resume, while gaining nothing it lacks today. |
| (b) Model library: curated list or our hosted gateway with our keys? | A curated list. | A hosted gateway is a billing and auth product outside this repo, and it can be added later as one more provider behind the same list. |
| (c) `oap-client` from npm or vendored? | Publish it to npm from the OAP repo and pin it exactly, with vendoring only as a stopgap. | Both repos are ours, CI requires exact versions, and a vendored copy drifts from the protocol it tracks. |
