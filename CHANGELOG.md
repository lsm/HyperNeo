# Changelog

All notable changes to HyperNeo will be documented in this file.

## [0.39.2] - 2026-07-03

### Fixed

- **npm publishing**: Reverted the main npm package name from `hyperneo` to `neokai` so v0.39.2 can publish using the existing `neokai` package and Trusted Publishing configuration. The CLI binary remains `hyperneo` and HyperNeo branding is unchanged; only the `npm install -g` package name is `neokai` for now.

## [0.39.1] - 2026-07-03

### Fixed

- **npm publishing**: Reverted CLI platform package scope from `@hyperneo/cli-*` to `@neokai/cli-*` so v0.39.1 can publish using the existing npm scope and Trusted Publishing configuration. The user-facing package name (`hyperneo`), CLI binary (`hyperneo`), and HyperNeo branding are unchanged.

## [0.39.0] - 2026-07-03

Project-wide rebrand from NeoKai to HyperNeo: packages, imports, environment variables, data directory, CLI binary, and npm packages renamed. Space runtime PR-event subscription hardened across three fixes, worker agent tool profiles aligned with runtime inheritance, provider logos branded in the model picker and composer pill, and Kimi/OpenAI bridge resilience improved. 15 commits since v0.38.0.

### Added

- **HyperNeo rebrand**: NeoKai renamed to HyperNeo across packages, imports, env vars, data dir, CLI binary (`hyperneo`), npm packages, and user-facing docs
- **Provider branding**: Brand logos added to model picker and composer pill
- **Inline session rename**: Chat and space sessions can be renamed inline
- **Forge diagnostics**: Result-artifact gap detector in episode generation

### Changed

- **Worker tool profiles**: Aligned with runtime inheritance semantics
- **OpenAI bridge logging**: Capped 4xx log noise, histogram metrics, skipped body summary for quota/auth errors
- **Desktop description**: Updated sidecar description from neokai to HyperNeo

### Fixed

- **Space runtime PR-event subscriptions**: Stopped clearing auto-subscription on non-terminal unblock; no longer terminally drops PR events linked to a run; registers auto-subscription during `in_progress` and hardens pause-cache lifecycle
- **Kimi prompt-too-long**: Enabled SDK native auto-compact; detects `blocking_limit` prompt-too-long result
- **Web UI**: Space task composer no longer restores deleted text; `useAutoScroll` latch resets on context switch via `resetKey`

## [0.38.0] - 2026-06-28

ACP query runner activation with provider registration and MCP tool proxying, Kimi provider hardened with local bridge for 262k context and multi-region support, Codex SDK aliasing removed in favor of real model IDs, workflow hooks migrated from gate-poll loops with event-driven gate evaluation, external GitHub event system expanded with PR/check-run/reaction polling and per-node subscriptions, Forge friction-digest evidence capture, Space runtime auto-continue on terminal errors, and provider resilience improvements (5xx/overloaded retry, auto-compact on prompt-too-long). 115 commits since v0.37.0.

### Added

- **ACP query runner activation**: ACP provider registration, query runner activation, message polish and config option switching, Space MCP tool proxying for ACP, Space session MCP tools
- **Kimi provider multi-region support**: Region selection (China vs Global), local bridge routing for 262k context window, context reserve buffer matching Kimi's ~32k max output, HyperNeo compaction fallback for both regions, prompt-too-long detection in user-message stderr with recovery, official Claude Code config alignment
- **Workflow hooks system**: Built-in workflows migrated to hooks; gate-poll runtime loops retired; event-driven gate evaluation for blocked runs; workflow hook UI exposure; hook events rendered in chat (roster-only in task threads); PR-ready gates migrated to send_message hooks
- **External event expansions**: `get_external_event` MCP tool for on-demand raw event fetch; `subscribe_pr_events` node-agent tool; worker nodes auto-subscribe to PR events on `pr_url`; PR event subscription contract step; GitHub reply/resolve handle capture in event normalizer; GitHub PR reaction polling for review approvals; check-run failure polling delivered to PR workers; GitHub polling interval setting with rate-limit-aware polling and gate-hook retry; PAT storage in keychain with token/polling config UI
- **Forge friction digest**: Repeated tool-use errors broken with `conversation_friction` evidence; `verification_triage` evidence after repeated verification failures; friction digest for repeated tool failures; existing lessons and proposals fed into episode judge prompt; artifact selection diagnostics in episode preflight; scope lessons ranked by task relevance before prompt injection
- **Space runtime improvements**: Auto-continue on terminal error results; terminal result errors surfaced inline in MinimalThreadFeed; reviewer merge conflicts routed to coder (not human); rate-limit cooldown and re-auth banners in task thread; external events delivered to review runs and idle node subscribers; activation pending flush guarded with run deliverability check; pending event deliveries flushed when a worker node activates; lean external event essence injected; review thread workflow contracts updated
- **Provider resilience**: Bounded 5xx/overloaded retry path in query-runner with backoff; auto-compact + continue on 'prompt is too long' overflow; circuit breaker prompt-too-long regex broadened for bare Kimi error; HTTP 529 mapped to `overloaded_error` in all provider bridges; body-embedded/mid-stream provider errors normalized (GLM); GLM 1305 overload classified as retryable via `isRetryableProviderError`; OpenAI Chat bridge `chat_template_kwargs` injection
- **UI/UX**: Running tool indicators (border, live task progress); task status persisted in roster; whole content column as image drop zone; red error bubble for assistant error messages; API retries shown in minimal roster; hook events rendered in chat; compact boundaries rendered in task threads; worker agents shown in space config; worker agent configure tab restored
- **Credentials**: `DatabaseCredentialStore` fallback when macOS Keychain unavailable; keychain error UX with encrypted file fallback for screen/SSH
- **Agent SDK**: Claude Agent SDK upgraded from 0.2.141 to 0.3.179; agent-memory embedding model prefetched on daemon startup
- **GLM-5.2 context support**: New GLM model with aligned context window display and compaction
- **SDK system-message rendering matrix**: Complete coverage (render 5, hide 9, conditional 2)
- **Event-driven external delivery**: Pending external event deliveries persisted for inactive workers; pending delivery queue retention bounded; GitHub comment poll watermarks seeded; PR metadata deduped on head sha (not updated_at)

### Changed

- **Codex SDK aliasing removed**: Real Codex model IDs used instead of Anthropic SDK aliases; stable Codex bridge key across OAuth token refresh; GPT-5.5 context routing test coverage
- **Kimi/Codex compaction**: SDK compaction used for Kimi and Codex; SDK compaction trigger fixed for provider contexts; context metadata resolved from SDK model
- **Worker tool profiles**: Made permissive to reduce false denials
- **Persistent thinking/api_retry**: Stopped persisting `thinking_tokens` deltas; `api_retry` messages persisted; api_retry/thinking_tokens/task_notification rendered roster-only in minimal feed; retry folding aligned in minimal thread feed; background task notifications folded onto tool cards; task_notification folded onto the tool card; hidden subtype SQL filters narrowed
- **Codex bridge diagnostics**: 4xx request bodies logged; tool output stringified; reasoning 400s self-healed

### Fixed

- **Kimi 1M → 200K fallback**: Stripped trailing `[1m]` suffixes from GLM model IDs to prevent compaction-threshold collapse
- **Provider env precedence**: Corrected env precedence between provider-stored and process env
- **Codex OAuth probe**: Correct validation flow
- **Provider test connection**: Now actually verifies API credentials instead of returning a false positive
- **Context window display**: Aligned for GLM/Kimi with compaction thresholds
- **Daemon startup regression**: Fixed startup path broken by earlier refactor
- **SDK message visibility performance**: No transcript scan on session open
- **Task-agent thinking token counts**: Correct accounting
- **OpenAI Chat bridge**: Guarded catch-block `send()` against closed controller
- **Reviewer gh api review-body contract**: Forbade `-f body=@-` form
- **Worker session supersession**: Activation flush guards against superseded worker sessions
- **Concurrent flush**: Guarded against double-dispatching persisted deliveries
- **Codex bot login matcher**: Corrected with cycle-anchored gate timeout
- **Synthetic user messages**: Toolbar now shows on synthetic user messages
- **Terminal results**: Input unlocked after terminal results
- **Bash task notification folding**: Test coverage added
- **GLM strip suffix**: All trailing `[1m]` suffixes stripped from GLM model IDs

## [0.37.0] - 2026-06-09

ACP protocol client with query adapter and message translator, runtime hook engine with MCP action integration, ACP protocol type definitions with JSON-RPC stdio transport, workflow hook schema storage with validation and persistence, separation of worker and long-horizon agent types, provider context window fix for non-native models, and terminology sweep with boundary tests. 7 commits since v0.36.0.

### Added

- **ACP client + query adapter + message translator**: Implemented ACP protocol client with lifecycle management (initialize, authenticate, createSession, sendPrompt, cancel, close), server-to-client request delegation, streaming chunk accumulation into SDK messages, and query-contract adapter with interrupt and close support
- **Runtime hook engine and MCP action integration**: Hook executor with sandboxed script execution using Bun.spawn, restricted env, credential stripping, timeout SIGKILL, and bounded stdout capture. Extended workflow hook types for runtime with submit_for_approval and approve_task methods
- **ACP protocol types + JSON-RPC stdio transport**: Added ACP (Agent Client Protocol) JSON-RPC 2.0 type definitions covering initialization, authentication, session lifecycle, content blocks, tool calls, permission requests, file system operations, and MCP server configurations
- **Workflow hook schema storage**: Typed hook definitions, validation, persistence, and per-run hook state storage so workflow hooks can be introduced without removing legacy gates. Includes export/import round-trip support and runtime bounds enforcement
- **Separate worker and long-horizon agents**: Worker agents and long-horizon agents are now distinct agent types with separate lifecycle management

### Changed

- **Terminology sweep**: Replaced "custom agent" / "SpaceAgent ID" with "worker agent" / "long-horizon agent" across tool descriptions, comments, and user-facing labels. Added boundary design doc with developer guidance

### Fixed

- **Prefer provider metadata context window for non-native providers**: Non-Anthropic providers (GLM, Kimi, Ollama, MiniMax, custom endpoints) now use their own model metadata contextWindow instead of the SDK's assumed capacity. Only Anthropic and Anthropic Copilot continue to trust SDK-reported values by default
- Fixed legacy long-horizon migration test to use the correct migration function (runMigration155) and added wrong-ID validation tests for goal/scope/reminder tools rejecting worker-only agent IDs

## [0.36.0] - 2026-06-02

Auto-fetch model list from custom endpoints, refresh models on provider changes, Forge completed-task automation and task-result backfill, Codex auth reliability fixes, long-horizon event subscription rehydration, agent event subscription UI, external event delivery log UI, auto-configure GitHub webhooks for spaces, and mobile Space tab fixes. 18 commits since v0.35.0.

### Added

- **Auto-fetch model list from custom endpoints**: Custom OpenAI-compatible endpoints now expose their available models via `/v1/models` discovery. Fetched models are merged into the unified provider registry with real-time UI updates
- **Refresh model list immediately when providers change**: Adding, updating, or removing a provider triggers an immediate model-list refresh so the UI stays in sync without manual reload
- **Forge completed-task automation**: Server-side automation triggers for completed Forge tasks, enabling cross-scope evidence capture and downstream goal progression
- **Forge task-result backfill**: Terminal task transitions now backfill `task.result` from `reportedSummary` when the result field is empty, ensuring downstream workflow nodes receive actionable output
- **Codex review bot opt-in per workflow node**: The Codex review bot check is now configurable per workflow node rather than globally enforced
- **Long-horizon event subscription rehydration**: Event subscriptions for long-horizon agents are now rehydrated across daemon restarts
- **Agent event subscription UI**: New settings UI for managing agent event subscriptions
- **External event delivery log UI**: New UI for viewing external event delivery logs and subscription status
- **Auto-configure GitHub webhooks for spaces**: Spaces can now auto-configure GitHub webhooks for push, PR, and issue events, with repository discovery and webhook status UI

### Fixed

- **Codex auth stale token refresh**: When OAuth token refresh fails definitively (invalid/revoked token), credentials are now cleared and the user is prompted to re-authenticate instead of receiving repeated 401s
- **Codex provider re-add after removal**: Built-in providers can now be re-added after deletion; `registerBuiltInProvider` restores the live registry entry on login and sync
- **Codex logout flow**: ProviderCredentialManager no longer mutates `auth_type` on logout, so the Login button remains visible after sign-out
- **Forward reasoning_content from OpenAI Chat Completions bridge**: The OpenAI Chat Completions bridge now correctly forwards `reasoning_content` through the response stream
- **Propagate thinking config to Codex bridge via side-channel**: Thinking configuration is now correctly propagated to the Codex bridge through a dedicated side-channel
- **Include reasoning.summary_text in OpenAI Responses bridge**: The OpenAI Responses bridge now forwards `reasoning.summary_text` so reasoning summaries appear in the UI
- **Disable SDK auto-compaction for non-Anthropic models**: SDK message auto-compaction is now disabled for non-Anthropic providers, preventing context loss on custom endpoints
- **Space ad-hoc session refresh spinning on slug URLs**: Space ad-hoc session refresh no longer spins indefinitely when navigating via slug-based URLs
- **Task thread loading after reconnect**: Task message threads now correctly resume loading after a WebSocket reconnect
- **Mobile Space tab highlighting**: Bottom tab bar on mobile now highlights the active Space tab correctly

## [0.35.0] - 2026-05-29

Unified provider registry with CRUD RPCs and credential store, rich markdown rendering with KaTeX and Mermaid, persisted Space agent handles, compacted Space workflow prompts, unified Providers settings UI, Codex thumbs-up review gate, test-quality audit, and composer draft race fix. 10 commits since v0.34.0.

### Added

- **Unified provider registry**: Full CRUD RPCs for providers (`providers.list`, `.get`, `.create`, `.update`, `.delete`, `.setDefault`, `.test`, `.healthCheck`), reactive DB repository, and startup migration from env vars and auth files
- **Provider credential store**: Keychain-backed storage on macOS with AES-256-GCM SQLite fallback, OAuth refresh scheduler, and `ProviderCredentialManager` for high-level credential operations
- **Unified Providers settings UI**: Replaces split Providers + Custom Endpoints with single view — provider rows with badges, health checks, OAuth flows, and `AddProviderModal` for quick-add of 9 built-in providers
- **Rich markdown rendering**: Migrated from marked to unified/remark/rehype with lazy KaTeX math, lazy Mermaid diagram rendering, GFM, line breaks, and syntax highlighting
- **Persisted Space agent handles**: Space agents now have persistent, user-configurable handles with reserved-name protection, DB-backed actor routing, and slug-based URL navigation
- **Codex thumbs-up review gate**: Review workflow now requires `codex[bot]` +1 reaction before QA review gate opens, with 10-minute timeout warning path
- **Test-quality audit**: Added `scripts/check-test-quality.ts` to CI which flags dead mock assertions and describe-scope mismatches via TypeScript AST analysis

### Changed

- **Compacted Space workflow prompts**: Centralized reviewer and QA contracts, trimmed coordinator and task prompts, and reduced dynamic activation context bloat without changing workflow semantics
- Old `?tab=custom-endpoints` settings URL redirects to `?tab=providers`

### Fixed

- Composer no longer restores draft content after send due to stale `onInput` race against `clearDraft()`
- Daemon startup no longer hangs on macOS when no Keychain entry exists and no TTY is available — falls back to encrypted SQLite credential store
- Slug-based Space navigation preserves canonical state and resolves agent detail routes correctly

## [0.34.0] - 2026-05-28

Forge proposal evidence, validation-only workflow completion, flaky test retry policy, long-horizon agent lifecycle coverage, task result capture fallback fixes, prompt builder token-cost audit, provider compatibility fixes, Copilot SDK binary bundling fix, workflow agent session titles, DB schema parity CI check, daemon unit test shard rebalance, and gate space task RPC handler test coverage. 13 commits since v0.33.0.

### Added

- **Forge proposal evidence**: Cross-post completed task evidence back to the originating Forge scope when proposal-created tasks run under a different scope
- **Validation-only workflow completion**: Added validation-only mode for workflow completion, allowing tasks to complete without running full execution
- **Long-horizon agent lifecycle coverage**: Added tests for long-horizon Space agent lifecycle behavior
- **Prompt builder token-cost audit**: Audited prompt builder token costs for workflow/runtime prompts
- **DB schema parity CI check**: Added CI check to ensure DB schema files stay in sync with migrations
- **Gate space task RPC handler test coverage**: Added test coverage for gate space task RPC handlers

### Changed

- **Flaky test retry policy**: Added retry policy for flaky tests
- **Stabilized SpaceGoals component test**: Reduced flakiness in the SpaceGoals UI component test
- **Rebalanced daemon unit test shards**: Rebalanced daemon unit test shards for better CI parallelism
- Workflow agent sessions now get clearer session titles

### Fixed

- Task result capture now has a fallback for missing or malformed result data
- Provider compatibility gaps were fixed
- Copilot SDK binary bundling issue was fixed

## [0.33.0] - 2026-05-26

Spaces home command center, recurring goal progress visibility, Forge trace diagnostics coverage, and graph tooling evaluation. 4 commits since v0.32.0.

### Added

- **Spaces home command center**: Spaces home now includes command-center updates, mobile navigation, and task tab routing
- **Forge trace diagnostics coverage**: Clean scoped task traces now assert no-friction diagnostic capture and conversation-friction analysis enqueueing
- **Graph tooling evaluation**: Benchmarked CodeGraph, code-review-graph, Graphify, and baseline exploration against task planning workflows

### Changed

- Recurring goals now hide progress bars and percentages, showing activity and metrics instead

## [0.32.0] - 2026-05-25

Goal/Forge automation triggers, Space session promotion, daemon log evidence capture, dynamic agent reply target fixes, and compressed agent output evaluation. 6 commits since v0.31.0.

### Added

- **Goal/Forge automation triggers**: Server-side triggers for completed-task thresholds, self-nag schedules, and external event subscriptions
- **Space session promotion**: Promote recent Space session context into long-horizon agent profiles through the agent editor
- **Daemon log evidence capture**: Structured daemon warning, error, crash, and uncaught exception events now feed Forge evidence
- **Compressed agent output evaluation**: Documented Caveman-style compressed output primitives and rollout considerations

### Changed

- Repository formatting switched from tabs to spaces

### Fixed

- Dynamic inter-agent message footers now show actual sender names and reply targets

## [0.31.0] - 2026-05-23

Long-horizon Space agents, Forge task dependencies, workflow gate validation, and Forge evidence fixes. 15 commits since v0.30.0.

### Added

- **Long-horizon Space agents**: Persistent agent instances with templates, lifecycle management, and MCP server attachment
- **Agent management tools**: MCP tools for creating, listing, and managing Space agent instances
- **Long-horizon agent templates**: Pre-built templates for common agent patterns (coder, reviewer, QA, etc.)
- **Forge task dependencies**: Support creating Forge tasks with dependency relationships, blocking execution until deps resolve
- **Workflow gate writer validation**: Validate that only authorized node agents can write to workflow gates

### Changed

- Space Agent UI renamed to Agents for clarity
- Space agent idle status messages suppressed to reduce noise
- QA workflow now discovers and injects QA.md context into node prompts
- Agents automatically stop when a new dependency blocks their current task

### Fixed

- Forge trace evidence capture on task completion now persists correctly
- Guard Forge task result artifact capture against missing or malformed data

## [0.30.0] - 2026-05-22

Forge evidence reliability, mobile Goal/Forge navigation, and workflow result propagation. 4 commits since v0.29.0.

### Added

- **Forge evidence preflight**: Score task results, workflow artifacts, metric snapshots, concrete outcomes, and manual-note-only risk before episode judging
- **Forge trace evidence**: Capture trace-derived task evidence from persisted SDK message/tool spans with friction clustering

### Changed

- Goal and Forge views now use mobile-friendly navigation and list-or-detail panes on small screens
- Workflow completion now propagates result artifact summaries into task results and reported summaries

### Fixed

- Preserve existing task results while filling missing workflow outcome fields
- Improve Forge evidence capture coverage for completed scoped tasks

## [0.29.0] - 2026-05-21

Forge self-evolution system, actor messaging UI, and memory consolidation. 20 commits since v0.28.0.

### Added

- **Forge episode judge**: LLM-powered episode evaluation from scope evidence
- **Forge scope UI foundation**: Frontend scaffolding for browsing evolution scopes, evidence, and episodes
- **Forge evolution scope APIs**: Backend CRUD for scopes, evidence, metric snapshots, and lessons
- **Forge proposal task creation**: Convert Forge proposals into real SpaceTasks
- **Forge judge model selector**: Choose which model judges episodes per scope
- **Forge space agent tools**: MCP tools for agents to interact with Forge (scopes, evidence, episodes, lessons)
- **Scoped Forge lessons**: Inject active lessons from evolution scopes into agent prompts
- **Forge rollup**: Accepted episodes roll metrics and summaries into linked recurring goals
- **Memory consolidation job**: Background job to compress and deduplicate agent memories
- **Actor messaging UI projections**: Frontend views for actor-targeted messages
- **Forge review follow-ups**: Structured follow-up actions after episode review

### Changed

- Space MCP session policy centralized for consistent tool attachment
- Forge evidence metadata included in episode judge prompts

### Fixed

- Review approval gate writer authorization
- Coding with QA workflow gate transitions
- Message search FTS write optimization (batched for lower I/O)
- Forge dogfood loop test hardening

## [0.28.0] - 2026-05-20

Space agent infrastructure, external event system, and semantic memory search. 19 commits since v0.27.1.

### Added

- **Space goals UI**: Frontend for Space-native goal tracking
- **Dynamic external event subscriptions**: Agents subscribe to GitHub/webhook events at runtime via MCP tools
- **External event source settings UI**: Configure event sources (GitHub repos, topics) in the Space settings panel
- **External event backpressure**: Rate-limiting and queue depth controls for external event ingestion
- **Hybrid semantic memory search**: Agents recall context via combined keyword + vector search
- **Long-term Space agent inbox**: Persistent event queue for Space agents across sessions
- **Space actor registry adapter**: Unified actor model for Space members and agents
- **Space messaging resolver facade**: Actor-targeted message routing abstraction
- **Space folder browse button**: Quick-access button to browse Space folders

### Changed

- Space messaging tools now wrap around actor targets instead of raw session IDs
- Routine task events no longer pollute Space chat channels
- Steer and queue controls polished for better usability
- Legacy Space GitHub service removed (replaced by dynamic subscription system)

### Fixed

- GitHub external event topic format corrected
- Worker session Space MCP reattach after disconnect
- Agent slot event interest cap prevents unbounded subscription growth
- Message search indexing constrained to prevent runaway index size
- Transformers web backend loading failure

## [0.27.1] - 2026-05-18

### Fixed

- Removed AppImage from Linux desktop release (unreliable linuxdeploy bundling); deb and rpm remain

## [0.27.0] - 2026-05-18

A major release adding full-text message search, custom OpenAI-compatible endpoints, persistent agent memory, Space-native goals, and signed desktop release artifacts. 8 commits since v0.26.0.

### Added

- **Full-text message search**: FTS5-backed search across session messages with quick-open UI in command palette; highlighted snippets; cross-session search; task title indexing
- **Custom OpenAI-compatible endpoints**: User-defined endpoints (LM Studio, vLLM, LiteLLM) with embedded Anthropic↔OpenAI bridge; tool_calls streaming; vision/thinking/reasoning_effort support; loopback binding; baseUrl normalisation; settings panel with presets
- **Persistent agent memory**: Agents retain memory across sessions
- **Space-native goal backend**: Goals reimplemented on Space infrastructure; rolling state (summary, progress, metrics, nextSteps); autoTriggerNext; goal-task-schedule linkage; MCP tools for agents; append-only event history
- **Generic messaging contracts**: Unified messaging abstractions
- **Signed macOS desktop release artifacts**: CI produces signed desktop builds for macOS
- **Linux desktop release artifacts**: Unsigned Linux desktop builds in CI

## [0.26.0] - 2026-05-17

A major release with a full Codex-style /sessions UI redesign, command palette, Space actor communication model, and node-level post-approval routing. 10 commits since v0.25.0.

### Added

- **Codex-style /sessions redesign**: Borderless session sidebar with project grouping, collapsible projects, inline archive action, empty-state landing with "What should we build?" composer, project/worktree/branch selectors, lighter sidebar with dark content contrast, resizable right panel with git info/chat info/review diff
- **Command palette (Cmd+K)**: Global fuzzy-search command palette with action registry, keyboard shortcuts, and Settings ▸ Shortcuts panel
- **Space actor communication model**: Designed communication model for Space actors
- **Node-level post-approval routes**: Per-node post-approval routing in workflow canvas; preserved in built-in templates
- **Edit task description mid-flight**: User-facing inline task description editing
- **git.branches RPC**: Git context for folder paths (branches, dirty state, current branch)

### Changed

- **Remove global Neo agent surface**: Centralized agent surface removed
- **Remove built-in task-agent LLM helper from workflows**: Simplified workflow prompting
- **Remove inbox surface**: Inbox UI removed

### Fixed

- **Provider model tagging**: Stop tagging foreign SDK model IDs as anthropic
- **MCP guard**: Deterministic MCP guard for Space member sessions before query start
- **Tool results**: Show error message for failed Edit/Read/Write tool results in web UI

## [0.25.0] - 2026-05-16

A release adding 429 auto-recovery, SDK binary warmup, GitHub external event extension, hook card redesign, and fixing node-agent MCP tools in eager-spawn sessions. 5 commits since v0.24.0.

### Added

- **429 retry exhaustion detection + auto-recovery**: RateLimitWatchdog detects exhausted SDK retries, schedules auto-retry after 10-minute cooldown (up to 3 cycles); frontend countdown banner with retry-now/cancel; cancels on new user message
- **SDK binary warmup**: Download SDK CLI at daemon startup (after server bind); non-fatal on failure; guards concurrent warmup and early shutdown
- **GitHub external event extension**: Full wiring of extension manager, routes, RPC handlers, lifecycle hooks; legacy polling preserved; per-space config persistence
- **Hook response card redesign**: Collapsible card matching ToolResultCard; default collapsed; slate color scheme; error indicator for non-zero exits

### Fixed

- **Node-agent MCP tools in eager-spawn sessions**: `isWorkflowSubSession` now matches `:agent:` IDs; `attachSpaceToolsToMemberSession` skips eager-spawn sessions; workflow MCP tools force-loaded with `alwaysLoad: true` to bypass SDK tool-search deferral
- **429 recovery edge cases**: Case-insensitive rate-limit matching; exclude 402/quota errors; guard cooldown on null message; cancel watchdog on reset/restart; await async state writes

## [0.24.0] - 2026-05-15

A release adding runtime anti-stuck recovery, external event delivery, reply routing, gate-open caching, and replacing the embedded SDK CLI with runtime download. 20 commits since v0.23.0.

### Added

- **Runtime anti-stuck recovery**: Layer 1 detection for alive-but-silent workflow node agents; nudge before session restart; preserves idle incomplete executions
- **External event delivery**: Wire workflow runtime external events through extension management; GitHub event extension extraction; workflow topic subscription trie; event interest schema
- **Reply routing**: Task/node agent replies route back to originating session (not always space:chat); in-memory registry with XML footer for cross-restart durability; TTL purge
- **Gate-open caching**: Skip re-evaluation on every message once gate is open; cyclic channels exempt; cache evicted on run completion and archive
- **Configurable task concurrency**: Per-space task concurrency limits
- **MCP tools**: `publish_task` and `archive_task` for space agent and task agent
- **Space GitHub events**: Routed through external events pipeline

### Changed

- **SDK CLI**: Runtime auto-download with SHA-512 verification replaces 200 MB embedded binary; compiled binary drops from ~266 MB to ~66 MB
- **SDK upgrade**: `@anthropic-ai/claude-agent-sdk` 0.2.112 → 0.2.141
- **App events**: Routed through InternalEventBus

### Removed

- **Google provider support**: All Google provider code removed entirely

### Fixed

- **Auto-scroll**: Reset latch on navigation; direct scrollTop instead of scrollIntoView; re-pin after layout; observe markdown growth and container resize
- **Review gate**: Fix reset race condition
- **Task/node replies**: Route replies to originating session instead of always space:chat
- **Process cleanup**: Clean up agent subprocess groups
- **Dependencies**: Update Bun workspace dependencies and lockfile

## [0.23.0] - 2026-05-12

A release completing the InternalEventBus migration, adding space chat subagents, settings URL routing, and fixing task dependency enforcement and mobile Safari composer. 17 commits since v0.22.0.

### Added

- **Space chat subagents**: Enable read-only SDK subagents for Space Agent investigation while keeping file editing tools denied
- **Settings URL routing**: Settings tab selection preserved in URL for direct links and browser history
- **Scheduled task fire events**: Tests ensure scheduled task fires publish task and schedule update events

### Changed

- **InternalEventBus migration complete**: All session, agent, query, config, and Space events migrated from DaemonHub; NotificationSink removed; StateManager split into StateProjectionService + InternalEventBus subscribers; ClientEventBridge owns all client delivery; namespaceId replaces sessionId
- **Root test guard**: Block bare `bun test` from repo root to prevent unintended full-suite runs

### Fixed

- **Task dependencies**: Enforce dependencies on late `dependsOn` addition; auto-unblock dependents on completion; cascade events for all dependency state changes
- **iOS Safari composer**: Keep textarea visible during keyboard resize; avoid padding churn; freeze composer growth during keyboard input; restore pre-1836 resize timing
- **Post-approval merge**: Preserve branches after post-approval merge
- **Task composer**: Show live context usage instead of 0% fallback
- **Mobile**: Fix overflow in space task tabs; merge archived into Completed; handle legacy archived routes
- **Codex**: Use Codex context windows for auto-compaction instead of fixed 1M

## [0.22.0] - 2026-05-11

A release adding workflow handles, scheduled tasks, dead-loop detection, Channels/ClientEventGateway foundation, and major LiveQuery performance improvements. 24 commits since v0.21.0.

### Added

- **Workflow handles**: Short human-readable identifiers (e.g. `coding-with-qa`) as alternative to UUIDs; auto-generated from names with collision resolution; pinned on built-in templates; accepted by all MCP tools and RPC handlers
- **Scheduled and recurring tasks**: TaskSchedule support for one-shot and recurring task creation via UI and API
- **Dead-loop detection**: Bash dead loops detected via PostToolUse failure tracking (threshold=5 consecutive failures); SDK dead-loop detection via identical output fingerprinting
- **Task observability**: `update_task` MCP tool for space agent and task agent
- **Create Session and Create Task buttons** on Space pages
- **SpaceWorkflowSummary**: Lightweight workflow list with reduced payload size
- **ClientEventGateway and Channels foundation**: Extracted from StateManager for cleaner daemon-to-client event routing

### Changed

- **ClientEventBridge**: Extracted remaining StateManager forwarding (session, connection, config, error events) into dedicated bridge
- **TypedHub**: `publish` now awaits async handlers; adds `publishAsync`
- **External events**: Simplified architecture — removed task coupling

### Fixed

- **LiveQuery performance**: Index-targeted lookups for sdk_messages queries (4-400x speedup); materialised `parent_tool_use_id` column; server-side pagination for task list groups
- **Workflow runtime**: Gate data writes resolve agent-name targets to node-name channels; keep open tasks open when dependency fails; add `pr_url` field to review-posted-gate
- **Chat UX**: Sync textarea height before auto-scroll; remove double-compensation causing mobile Safari composer jump; keep composer visible above mobile Safari keyboard
- **Providers**: Set autoCompactWindow for non-native providers with large context windows

## [0.21.0] - 2026-05-08

A release adding image support across bridges and task threads, external event infrastructure, task observability tools, and significant idle performance improvements. 13 commits since v0.20.0.

### Added

- **Image attachments in task thread**: Composer images flow through space task message pipeline to SDK; server-side 5MB validation; preserved on send failure
- **OpenAI Responses bridge image forwarding**: Image content blocks translated to OpenAI input_image format with URL and base64 support
- **Task observability tools**: `list_tasks`, `get_task`, `list_audit_entries` MCP tools with audit trail
- **ExternalEvent schema and store**: Durable event lifecycle storage with dedup, retry, and per-subscription delivery state machine
- **InternalQueryBus facade**: Preserves Live Query boundary with semantic query interface
- **GLM-5V-Turbo model**: Vision-capable model added to GLM/Zhipu provider

### Changed

- **Migrate settings.updated event behind InternalEventBus**: Consistent event dispatch pattern
- **Replace task_thread_messages projection with derived columns**: Schema simplification
- **Remove legacy Codex app-server adapter**: Cleanup of unused code path

### Fixed

- **Plan & Decompose workflow**: Gate evaluation before activation; map-field deep-merge for gate data; atomic repository transactions; re-check gate after activation; archive guard before gate eval; corrected planner and reviewer prompts
- **Idle performance**: Stop session polling when agent is idle; remove broken queued-messages polling; scope task live-query invalidation; reduce file-index churn
- **Gemini**: Whitelist JSON Schema keywords in tool definitions instead of blacklist
- **Model cache**: Scope per-session cache invalidation keys

## [0.20.0] - 2026-05-06

A release adding configurable settingSources, OpenAI reasoning.effort support, workflow disable toggle, internal command/event buses, and removing the legacy Room feature entirely. 18 commits since v0.19.0.

### Added

- **Configurable settingSources**: Per-session, per-space, per-agent control over which settings files load (user, project, local); clear-override UI; round-trip through export/import
- **OpenAI reasoning.effort**: Granular thinking levels for anthropic-codex bridge; maps budget_tokens to reasoning.effort (low/medium/high/xhigh); multi-turn reasoning pass-through
- **InternalCommandBus**: Semantic daemon command facade
- **InternalEventBus**: Semantic daemon event facade
- **Disable workflows**: Ability to disable workflow execution per space
- **Target-aware task thread composer**: Per-agent model, thinking, and tools selection in the task thread composer

### Changed

- **Thinking level UI**: Renamed Auto→Off; added think24k; provider-aware options
- **CLAUDE.md**: Condensed from 422 to 158 lines

### Removed

- **Legacy Room feature**: Full removal including source code, migrations references, and web surfaces

### Fixed

- **Thinking**: Explicitly disable thinking when level is 'off' for thinking-capable providers
- **Tools**: Add missing tools to KNOWN_TOOLS and specialist agents; expose Task/Agent tools for non-Anthropic providers
- **Workflow**: Fix submit_for_approval state transition and prevent autonomy gate bypass
- **Gemini OAuth**: Fix redirect mismatch; refresh model cache on account changes with generation-guarded invalidation
- **Settings**: Make settingSources configurable so CLAUDE.md loads again

## [0.19.0] - 2026-05-05

A release adding Google Gemini OAuth, Kimi Moonshot provider, gate poll mechanism, configurable thinking levels, and node-to-Space-Agent messaging. 21 commits since v0.18.0.

### Added

- **Google Gemini OAuth provider**: Account rotation with UI management in provider settings
- **Kimi Moonshot provider**: OpenAI-compatible bridge with auth-secured localhost proxy
- **Gate poll mechanism**: Periodic script execution and node message injection for workflow nodes
- **Configurable thinking levels**: Per-agent thinking budget in space settings
- **Default model picker**: Space Settings and Task Agent editor now expose model selection
- **Node-to-Space-Agent messaging**: Workflow nodes can escalate to the built-in Space Agent with runtime envelopes and attribution
- **Mobile space navigation redesign**: Improved mobile layout for Spaces

### Changed

- **OpenAI bridge session routing refactor**: Cleaner session management for OpenAI-compatible providers
- **OpenRouter**: Use `/models/user` endpoint and filter system models
- **Mid-run gate poll config pickup**: Gate poll config changes take effect without restart

### Fixed

- **SDK**: Transcript usage rehydration sanitization for legacy JSONL
- **Gemini OAuth**: Default credentials so setup works without env vars
- **OpenAI**: Response usage normalization
- **Chat UX**: Composer stop button state; task thread refresh after reconnect
- **Gate poll**: PR comment notifications; rehydration after restart; template hash includes gate poll to prevent drift
- **Space Agent**: Gated peer discoverability and reachability when no injector configured

## [0.18.0] - 2026-05-03

A release adding Ollama provider support, Space GitHub PR ingestion, draft task status, and significant workflow and bridge reliability improvements. 37 commits since v0.17.0.

### Added

- **Ollama model providers**: Local model support with environment-based configuration
- **Space GitHub PR ingestion**: Poll and ingest GitHub PRs into Spaces with dedupe key normalization and cursor follow-ups
- **Native draft status for Space tasks**: Tasks can be created in draft state before activation
- **Workflow agent prompts**: Data-driven prompt templates for workflow agents
- **Provider model allowlists**: Applied on startup to gate available models

### Changed

- **Route overlay sends through task messaging**: Overlay messages flow through the task messaging pipeline
- **Cancel stale workflow node executions**: Timeout and cancel workflow nodes stuck in intermediate states
- **Recover stalled workflow handoffs after restart**: Workflow transitions resume properly across daemon restarts
- **Make agent_session_id write-once**: Prevents mutation issues on node_executions
- **Scope sdk_messages live-query invalidation**: Invalidation scoped per session to reduce churn
- **Reduce daemon live-query churn**: Optimize query refresh patterns
- **Improve large SDK thread performance**: Better handling of long conversation histories

### Removed

- **"Awaiting Approval" filter chip**: Removed from tasks Action tab; status filters are sufficient

### Fixed

- **Codex bridge**: Retry SDK API requests on transient connection errors; fix OpenRouter model allowlist filtering; fix OpenRouter model cache never refreshing; fix context window reporting for non-Codex models and increase chat limits
- **Workflow**: Fix restamp ID preservation; fix node respawn state tracking; fix queued workflow handoff recovery; fix runtime reverting manually reopened/resumed tasks back to Blocked; fix own-PR review handoffs; prevent coder agents from merging PRs; block unresolved PR conversations before merge
- **Agent resilience**: Guard idle node agents with last-message checks; fix Space Agent MCP recovery after resume; fix restart migration preserving agent prompts; fix stale compact summary carryover; fix autocompact buffer threshold mapping
- **Chat UX**: Fix chat autoscroll padding; fix MinimalThreadFeed active turn drift; graceful socket disconnection handling in UI
- **GitHub**: Fix Space GitHub polling cursor follow-ups; normalize Space GitHub dedupe keys
- **Review**: Fix review-posted gate URL extraction

## [0.17.0] - 2026-04-29

A major release adding the OpenAI Responses bridge and OpenRouter provider, retiring the Room feature, and hardening Codex bridge reliability and Space workflow resilience. 46 commits since v0.16.0.

### Added

- **OpenAI Responses bridge**: Full streaming Responses API support with continuation tracking, ChatGPT Codex endpoint compatibility, and per-session isolation
- **OpenRouter provider**: Anthropic-compatible provider with environment-based credentials, model discovery, and searchable model picker
- **Codex searchable model picker**: UI for browsing and selecting Codex models
- **Task numbers in space task headers**: Display task sequence numbers in the task view

### Changed

- **Runtime owns deterministic workflow routing**: Normal completion and post-approval dispatch moved to runtime; Task Agent contact reserved for escalation only
- **Workflow task recovery**: Reopen and resume actions route through runtime recovery so task, run, and node execution state move together
- **Restrict node agent MCP tools**: Remove space-agent-tools from workflow node sessions; mirror safe task creation through node-agent-tools
- **Enforce Space agent tool permissions**: Persist custom tool allow/deny lists into workflow node worker sessions

### Removed

- **Room feature retirement**: Deleted all Room E2E specs, unit tests, daemon online tests (~55k lines); retired active Room shared contracts, web surfaces, and runtime wiring; legacy schema preserved for DB compatibility
- **Brave Search MCP integration**: Removed entirely

### Fixed

- **Codex bridge**: Subprocess crash retry with session reservation; orphan tool continuation recovery with fail-forward; context window metadata for GPT-5.3/5.4/5.5 (272k); context usage normalization; MCP elicitation responses; ChatGPT Codex endpoint compatibility (store, max_output_tokens, previous_response_id); stale resume recovery with checkpoint fallback; first message after model switch
- **Space task thread scroll**: Mirror composer bottom inset into scroll padding so newest messages stay visible
- **Agent activation**: Activate node-agent sessions before message delivery; reset stale session references before spawn
- **Reviewer prompts**: Fix preset prompt reconciliation after daemon restart; rehydrate node-agent prompts on session restore
- **Workflow**: PR ready gate handoff validation with protected-branch support; reviewer follow-up after terminal action; hard reset agent sessions on reset
- **MCP**: Repair missing agent_session_id from sub-session id; ghost tool continuation rehydrate race
- **Message routing**: Fix type misclassification in unified thread view; mark timed-out queued messages as failed
- **Context windows**: Fix model context windows for Codex and Copilot; fix Codex context capacity display
- **Responses bridge**: Guard SSE controller lifecycle against aborted clients
- **SDK**: Disable Codex bridge SDK auto-compaction; fix stale SDK rewind resume recovery

## [0.16.0] - 2026-04-27

A release improving context usage reporting for Copilot/Codex bridges and fixing Space session rehydration and workflow prompt handling. 5 commits since v0.15.0.

### Added

- **Copilot context usage**: Consume Copilot SDK `session.usage_info` events in bridge stream; add `/v1/messages/count_tokens` and `/v1/models` endpoints
- **Codex context reporting**: Report non-zero Codex context estimates through the bridge; handle v2 nested token usage

### Fixed

- **Space MCP rehydration**: Restore Space-owned sessions attach live runtime MCP servers before replaying pending messages; propagate late MCP changes into active SDK queries
- **Post-approval workflow prompts**: Fix prompt routing after human approval in workflow execution
- **Overlay highlight**: Make overlay message highlight one-shot

## [0.15.0] - 2026-04-27

A stability release fixing session persistence, message routing, and provider bridge issues. 15 commits since v0.14.0.

### Fixed

- **Session persistence**: `AskUserQuestion` survives daemon restart; dead sessions cleaned up; in-process MCP servers preserved across runtime mutations
- **Message routing**: Guard sub-session MCP servers; prevent silent message drop; tighten matcher in task-composer target picker
- **Workflow execution**: Lazy-activate stranded executions; clickable not-started entries; skip redundant merge approval when human already approved
- **Provider bridges**: Fix Codex model routing + stub endpoints; normalize usage on BetaMessages to prevent SDK crash; fix usage.input_tokens crash on bridge providers; upgrade copilot-sdk; fix copilot early error handling
- **Space sessions**: Drop bogus sessionId filter from session.created/deleted subs; unify Active-tab filter between sidebar and tasks view

## [0.14.0] - 2026-04-24

A release introducing the Tauri desktop wrapper, server-derived active-turn tracking, and workflow definition improvements. 10 commits since v0.13.0.

### Added

- **`@neokai/desktop` Tauri wrapper**: Bundles daemon as sidecar for native desktop app
- **Server-derived active-turn roster**: Decoupled from compact feed for accurate per-agent turn tracking
- **Lazy workflow agent activation**: Agents activate on first message instead of at workflow start

### Changed

- Per-node timeouts moved from runtime constants into workflow definitions
- Removed all `report_result` references

### Fixed

- Space migrations made idempotent with foreign keys
- Reviewer terminal actions forbidden while P0–P3 findings are open
- Active-turn rail tracked per agent label
- Space task view polished (Codex)

### Dependencies

- Patch + minor bumps across the monorepo

## [0.13.0] - 2026-04-23

A major release replacing the completion-actions pipeline with workflow-declared post-approval routing, unifying the MCP/Tools modal, and hardening daemon restart resilience. 38 commits since v0.12.0.

### Added

#### Post-Approval Routing
- **`approved` task status**: New lifecycle stage between `review` and `done` for tasks whose end-node verdict is accepted but post-approval side effects are still in flight
- **`postApproval` workflow schema**: Workflows declare an optional post-approval route; runtime spawns the named agent on the `review/done → approved` boundary
- **`mark_complete` MCP tool**: Post-approval executor calls this to transition `approved → done` (or back to `blocked`)
- **Post-approval populated on built-in workflows** with enable flag

#### MCP & Tools
- **Per-session MCP override toggles** in Tool Modal
- **Unified session Tools modal**: Session-scoped with deferred toggles
- **Per-space MCP override UI** + import scanner for `.mcp.json`
- **Generalized MCP enablement** with `mcp_enablement` table + resolver
- **`.mcp.json` import** into `app_mcp_servers` (source + sourcePath tracking)
- **Runtime state in Tools modal** and MCP Servers settings
- **Preset agent drift detection and sync**

#### Frontend & UI
- **Minimal thread style exploration page**
- **Autocompact buffer visualization** on context usage indicator
- **Task dependency badges** in task list
- **Submit-for-Review UI unified** with agent `submit_for_approval`
- **Floating task pane tab pill** inside content area

### Removed

- **`completionActions` pipeline**: Types, schema column, `CompletionActionExecutor`, `approve_completion_action` tool, and completion-action constants removed (M104 migration)
- **Global MCP Servers page**: Removed; MCP config unified into per-space overrides
- **Legacy thread render mode** from `SpaceTaskUnifiedThread`
- **Artifacts header** and legacy MCP config code paths

### Changed

- Drop `completionActions` types, schema, and docs
- Delete completion-action pipeline + consolidate approval banners
- Remove legacy thread render mode; float SpaceTaskPane tab pill

### Fixed

- **Daemon restart**: Rehydrate sub-session MCP servers; recover stalled workflow runs; close restart race + stop wiping MCP on space_chat
- **Tasks in review/approved**: Treated as at-rest in `recoverSingleRun`
- **MCP servers**: Built-in skills wrapped as SDK plugins (`/playwright`, `fetch-mcp`); kill `.mcp.json` auto-load leak
- **Chat UX**: Scroll to bottom on cached-session re-mount; keep last message visible above floating composer; gate chat empty state on first messages snapshot
- **Channel cycles**: Reset counters on human touch
- **CI**: Stabilize flaky tests (workspace-history sort, web Suspense, Node imports)

## [0.12.0] - 2026-04-22

A release improving tool surface area and session resilience. 5 commits since v0.11.1.

### Added

- **Runtime MCP surface**: Sync-attach space tools to all member sessions; surface runtime MCP servers in Tool Modal
- **Standalone task dependencies**: `depends_on` parameter in `create_standalone_task` MCP tool

### Changed

- Remove global MCP Servers page; plan MCP unification

### Fixed

- Sessions only deleted/archived from UI actions (not agent)
- Task-agent `sdkSessionId` preserved across restart; sub-sessions eagerly spawned

## [0.11.1] - 2026-04-22

A patch release fixing session persistence and workflow fingerprint accuracy. 8 commits since v0.11.0.

### Changed

- Default `completionAutonomyLevel` set to 3; legacy `WorkflowEditor` removed
- Task status actions moved from inline bar to dropdown menu

### Fixed

- Ad-hoc space sessions now get `space-agent-tools` MCP via `session.created` event
- Task agent sessions preserved across daemon restart
- Workflow fingerprint expanded to include customPrompt, completionActions, and completionAutonomyLevel
- Lock file removed on process exit; WAL checkpointed on DB close

## [0.11.0] - 2026-04-22

A refinement release improving workflow reliability, artifact display, and communication resilience. 15 commits since v0.10.0.

### Added

**Space Workflow System**
- **Stacked PR task chain**: Plan & Decompose workflow generates ordered tasks with branch name, base branch, and dependency instructions for bottom-up PR chains
- **Data-driven artifact rendering**: Worktree commit display for artifacts
- **Unified save_artifact tool**: Consolidated `save`, `write_artifact`, and `report_result` into one tool
- **Clickable overview stat cards**: Navigate to tasks page from overview stats

**Frontend & UI**
- **Compact approval banners**: One-line + modal pattern replaces inline banners

### Fixed

- **Node-agent MCP tools**: Restored in workflow sessions after daemon restart; auto-resume idle sessions when messages are queued
- **Gate scripts**: Resolved from live templates instead of stale DB rows; startup drift warnings added
- **Communication**: `list_peers` shows topology peers; `send_message` queues for inactive nodes instead of failing
- **db-query MCP**: Exposed `space_sessions` and `sdk_messages` in space scope

## [0.10.0] - 2026-04-21

A focused release hardening the Space Workflow System for production use — autonomy enforcement, completion pipelines, workflow template sync, and significant UI polish. 76 commits since v0.9.0.

### Added

#### Space Workflow System
- **Stacked PR task chain**: Plan & Decompose Task Dispatcher embeds branch name, base branch, and dependency ordering instructions in each task description so downstream coders automatically produce a reviewable PR chain bottom-up from `dev`
- **Completion actions pipeline**: `script`, `instruction`, and `mcp_call` completion actions with audit trail, approval reason tracking, pause/resume flow, and `task_awaiting_approval` events
- **Autonomy-gated approvals**: Supervisor/semi-autonomous enforcement for workflow gates; "X of Y workflows autonomous" selector in SpaceSettings and SpaceOverview
- **Runtime controls**: Pause/resume lifecycle; Stop/Start runtime on overview page
- **Task dependency enforcement**: Cycle detection and failure cascade for dependent tasks
- **LLM-driven workflow selection**: Space chat agent auto-selects workflows for standalone tasks
- **Target any workflow node**: `send_message_to_task` auto-spawns and activates nodes across the workflow graph
- **Workflow template sync**: Drift detection with confirmation UI
- **Channel topology hardening**: Queue-until-active behavior; Task→Space escalation for unreachable targets
- **Workflow run artifacts**: Persisted artifacts per run with `GateArtifactsView` and `FileDiffView`
- **Reason-aware blocked tasks**: Blocked-task banner with gate approval UI and reason-based grouping
- **Approval audit trail**: `SpaceApprovalSource` tracking with `approvalReason` and thread events
- **Sessions page**: New Sessions list page and tab
- **Attention LiveQuery**: Action tab with reason-based grouping for tasks needing attention

#### Frontend & UI
- **URL-addressable Space views**: Overlay history, `/settings` route, slug-based routing
- **Redesigned SyntheticMessageBlock**: Markdown rendering, subtle card style, collapsible sections
- **Glass-style chat composer**: Multiline-aware bottom padding
- **Compact task thread**: Config-switchable compact renderer, cleaner agent headers, clickable hidden-message dividers
- **ThreadedChatComposer replaced with ChatComposer** in task view
- **Space chat agent**: Removed edit/write tools for cleaner agent boundaries

#### Performance
- **Background job queue + cache** for artifact git operations
- **Server-side slicing** of `spaceTaskMessages.byTask` for compact view

### Changed
- Replaced Full-Cycle with **Plan & Decompose** built-in workflow
- `report_result` now result-only; completion pipeline is sole status arbiter
- Split `report_result` into audit/approve/submit to end reviewer-loop premature completion
- Reorganized agent task message with injected runtime context
- Native `getContextUsage()` replacing `/context` text parsing
- Migration M86 early-return skips `pending_checkpoint_type` on pre-migrated DBs
- LiveQuery migration for ChatContainer + widened `space-agent-tools` to all Space sessions
- Lazy-load heavy deps, inline workspace selection in chat container, improve `/spaces` page UX

### Fixed

- **Reviewer loop**: Split report_result into audit/approve/submit to prevent premature completion; review-posted-gate falls back to PR comments when formal review is blocked
- **Space communication**: Keep node-agent sessions reachable until task is archived; allow communication until task is archived; @mention routing includes idle agents
- **Space workflow**: Persist `completionActions` and backfill workflow template tracking; gate banners only show after activation
- **Sessions**: Resume SDK sessions across workspace/worktree path changes; session error layout and retry button
- **Runtime**: Node-agent injection invariant + agent-callable restore; model switch stability
- **Mobile/iOS**: Compact Task Agent node on mobile canvas; standardize panel header heights and fix mobile Safari bottom gap
- **Copilot**: Call `client.start()` before caching CopilotClient

### CI

- E2E removed from all automatic CI triggers (workflow_dispatch only)
- Run lint/unit/online tests on push to dev
- Remove broken Microsoft apt repos before `apt-get update`

## [0.9.0] - 2026-04-20

A major release introducing the **Space Workflow System** — a multi-agent orchestration platform with visual workflow editing, channel-based routing, approval gates, and autonomy levels. ~1,145 commits since v0.8.0.

### Added

#### Space Workflow System
- **Visual workflow editor**: Drag-and-drop canvas with DAG auto-layout, zoom/pan controls, multi-select, node/edge config panels, per-slot agent overrides, and SVG edge rendering
- **Channel + Gate topology**: Separated `WorkflowChannel` (routing) and `Gate` (policy) types; unified `channels` column; gate scripts with restricted execution env; gate label/color/script-indicator UI
- **Built-in workflows**: Coding, Coding+QA, Research, Review-Only, and Plan & Decompose (replacing Full-Cycle); workflow template sync with drift detection and confirmation UI
- **LLM-driven workflow selection**: Space chat agent auto-selects workflows for standalone tasks; `suggest_workflow` MCP tool; configurable per-space tiebreaker
- **Task Agent**: First-class node with `send_message`, `list_reachable_agents`, `list_group_members`, `report_done`, `idle`/`save`/auto-gate-write primitives; worktree isolation via `SpaceWorktreeManager`; peer communication tools for node agents
- **Approval gates**: Backend RPCs, canvas/thread inline approval UI, reason-based blocked-task banner, audit trail with `SpaceApprovalSource` tracking
- **Parallel node execution**: Shared gates enable parallel agent runs; iteration detection and capping in `WorkflowExecutor`; cyclic channel support
- **Workflow run artifacts**: Persisted artifacts per run with `GateArtifactsView` and `FileDiffView`
- **Runtime pause/resume**: Lifecycle controls on space overview; Stop/Start runtime button; force-stop stale session groups
- **Autonomy levels**: `supervised` vs `semi_autonomous` per workflow; "X of Y workflows autonomous" selector; autonomy-gated approvals
- **Coding Workflow V2**: Coder↔Reviewer loop hardening with PR-posted review comments and verification; explorer/fact-checker/tester sub-agents for planner, coder, and reviewer roles
- **Completion actions pipeline**: `script`, `instruction`, and `mcp_call` completion actions with audit trail, approval reason tracking, pause/resume flow, and `task_awaiting_approval` events
- **Space Sessions page**: New Sessions list page and tab; full-width task view with agent session navigation; slug-based URL routing; numeric per-space task IDs

#### Neo Agent
- Side-panel AI assistant with `Cmd+J` shortcut, slide-out panel with Chat, Activity, and Confirmation UI
- Query tools (rooms, spaces, workflows, goals, tasks, skills, MCP servers) and action tools (config, messaging, space/workflow, goal/task, Undo)
- Security tier system, `MessageOrigin` tracking, `ViaNeoIndicator` badge, signal-based `NeoStore` with LiveQuery
- Neo settings section and online conversation flow tests

#### Missions (Goal V2)
- **Measurable missions**: Structured metrics with adaptive replanning; metric history time-series
- **Recurring missions**: Cron scheduling with execution identity, manual trigger, and recovery
- **Semi-autonomous mode** for coder/general tasks
- Mission detail page with header, status sidebar, and main content sections; type-specific creation and detail views; "Goal" → "Mission" UI terminology rename

#### Skills & MCP Registry
- Global skills registry UI with per-room enablement overrides; built-in `playwright`, `playwright-interactive`, `chrome-devtools-mcp`, and `fetch-mcp` seeds; async validation via `SKILL_VALIDATE` job queue
- Application-level MCP settings panel with per-room enablement; `AppMcpLifecycleManager`; reactive `mcp.registry.listErrors` RPC
- `db-query` MCP server: scoped read-only SQL access with validation layer

#### References System (`@`-mentions)
- File, folder, task, and goal resolvers with shared reference types
- `ReferenceAutocomplete` component, `useReferenceAutocomplete` hook, `MentionToken` rendering
- `@mention` routing to specific agents in task thread composer; scoped to workflow agents only
- File index service with polling-based cache refresh

#### Short IDs
- Human-readable IDs for tasks and goals (`task-123`, `goal-42`); `ShortIdAllocator` with atomic counter allocation; backfill migrations; short IDs accepted in RPC handlers and URLs with click-to-copy badges

#### Provider & Session
- **GitHub Copilot** as transparent `AgentSession` backend via embedded Anthropic-compatible server
- **Anthropic-compatible HTTP bridge** backed by `codex` app-server
- **GLM-5-Turbo** model support
- Provider-aware session creation, provider-grouped model picker with availability dots, provider badge in session status bar
- Explicit `(modelId, providerId)` pairs for deterministic routing; filter unauthenticated providers from picker
- Graceful degradation on provider unavailability; model switching in TaskView with auto-fallback on rate/usage limits
- OpenAI token refresh/login in settings for Codex
- Native `getContextUsage()` replacing `/context` text parsing

#### Frontend & UI
- **TaskViewV2**: Turn-based conversation view with `TurnSummaryBlock`, `RuntimeMessageRenderer`, `AgentTurnBlock`; client-side pagination; `ReadonlySessionChat` and `SlideOutPanel`
- **LiveQuery migration**: `ChatContainer`, `tasks.byRoom`, `goals.byRoom`, group messages, room skills, and task thread messages migrated to LiveQuery with stale-event guards and reconnect handling
- **Compact task thread**: Config-switchable compact renderer, cleaner agent headers, clickable hidden-message dividers, system:init cards, agent completion state indicators
- **Glass-style chat composer** with multiline-aware bottom padding
- **Mobile polish**: `BottomTabBar` with iOS-style navigation, room-specific bottom tabs, iOS Safari safe-area fix, compact Task Agent node on mobile canvas, redesigned mobile task view header
- **UI overhaul**: Room tab restructure, Agents redesign, visual consistency pass; Button/IconButton/NavIconButton unification; typography + prose refinements; design-tokens module
- **Inbox view**: Direct approve/reject from Inbox without TaskView navigation; semantic status borders; inline reject form
- **Goals editor**: Two-step create wizard, improved cards, metric progress bars, execution history
- **Task UX**: Action dropdown with complete/cancel dialogs, circular progress indicator, reactivate/archive actions, full manual task-status control, `TaskArtifactsPanel`, canvas mode toggle, blocked-reason display
- **`EntityStore<T>`** generic signal-based frontend store pattern; migrated `RoomStore`, `roomSkills`, and global skills
- Agent overlay chat panel, activity members list, workspace history, draft message auto-save with 200k char limit
- Workflow Rules Editor, Custom Agent List and Editor, Space export/import (backend + UI)

#### Backend Infrastructure
- **`ChannelRouter`** with lazy node activation, gate evaluation, and cyclic iteration tracking
- **Job queue** replacing `setInterval`/`queueMicrotask`: `room.tick`, `github.poll`, `session.titleGeneration`, `job_queue.cleanup`, `SKILL_VALIDATE`
- **`ReactiveDatabase`** threaded through managers and repositories; `notifyChange` hooks on `GoalRepository`, `TaskRepository`, `SessionGroupRepository`
- **Named-query registry** with column aliasing and JSON parsing; `liveQuery.subscribe`/`unsubscribe` RPC handlers
- `CompletionDetector` for all-agents-done detection; `NodeExecutionManager` and `node_executions` table
- `AppMcpLifecycleManager` with per-room enablement; room-scoped sessions guarded against missing workspace paths; `defaultPath` propagation and validation
- Live `DaemonHub` event bridging for `room.*`/`goal.*`/`task.*` updates via `StateManager`
- `NotificationSink` interface for Space Agent event injection

### Changed

- **Terminology**: `step` → `node` across storage, runtime, types, and UI; `slot_role` → `agent_name`; `Goal` → `Mission` in UI copy; "Room Agent" → "Coordinator"
- **Transitions removed**: Replaced legacy `WorkflowTransition` with gated channels; removed `advance()` in favor of agent-driven progression; dropped session group tables and `currentNodeId`
- **Task lifecycle**: `failed` state made non-terminal (messages + retry); `archived` status added; `cancelled` → `completed` transition allowed; `needs_attention` auto-revives on new message
- **Lazy loading**: `GoalsEditor`, `RoomAgents`, `RoomSettings`, and `/spaces` page loaded on demand
- **Parallelization**: Daemon unit test shard runner; split rpc online tests into 4 shards; split online space tests and cross-provider tests into 2 jobs each
- **Workflow auto-selection**: Simplified multi-agent space to explicit `workflowId` or AI auto-select only
- Leader gets `create_task`, task management tools, and verifies PR mergeability before `submit_for_review`
- `Config.workspaceRoot` is now optional; `--workspace` flag removed; default DB path with PID lock
- `report_result` now result-only; completion pipeline is sole status arbiter
- Server-side slicing of `spaceTaskMessages.byTask` for compact view

### Fixed

- **Space communication**: Keep node-agent sessions reachable until task is archived; node-agent injection invariant + agent-callable restore
- **Space workflow**: Persist `completionActions` and backfill workflow template tracking; space task review status handling; merge `listGateData` with event updates to prevent race
- **Mobile/iOS**: iOS Safari safe-area gap, bottom tab bar overlap, model dropdown overflow, pointer-event intercepts, `pb-bottom-bar` layout
- **Worktree**: Resolve Task Agent worktree path under `~/.neokai` instead of source repo; artifacts tab uses task worktree path for git diff
- **Sessions**: Resume SDK sessions across workspace/worktree path changes; show stop button in space session composer when agent is running; session error layout + retry button
- **Context**: Refresh context usage after `/compact` completes
- **Runtime**: Recover stuck leaders after rate-limit expiry; clear group rate limit on resume and message send; early return after successful fallback model switch
- **N+1 queries**: Fixed room/task loading queries; added missing DB indexes; parallelized subscriptions; bundled session info into `getGroup`
- **E2E**: Numerous E2E fixes for canvas-based channels, mission terminology, reference autocomplete, gate approval, happy-path pipeline, mobile duplicate overview, workspace selection, pointer events

### CI

- **E2E removed from all automatic triggers** — E2E must now be invoked via `workflow_dispatch` with `run_e2e_only=true`
- Suppressed Node.js 20 deprecation warning in GitHub Actions
- Enabled web tests on PRs to `dev` and fixed 28 pre-existing test failures
- Remove broken Microsoft apt repos before `apt-get update`
- Add `ripgrep` to CI and release sandbox dependencies
- Setup-devproxy composite action with caching; simplified CI by removing intermediate gate jobs

## [0.7.1] - 2026-03-15

### Fixed
- Updated `optionalDependencies` in `npm/neokai/package.json` to reference `0.7.1` platform binaries

## [0.7.0] - 2026-03-14

### Added
- **PR as first-class task data**: PR number, URL, and creation timestamp are now stored on tasks and surfaced in the UI with quick-access buttons in task view and task overview
- **Bypass markers for research/verification tasks**: Workers can now skip git/PR gates for research-only tasks using markers (`RESEARCH_ONLY:`, `VERIFICATION_COMPLETE:`, `INVESTIGATION_RESULT:`, `ANALYSIS_COMPLETE:`) as the first line of their final response — prevents unnecessary PRs for pure analysis work
- **Active session tracking**: Added `activeSession` field on tasks to display real-time working indicators (pulsing badges) without status thrashing when a human injects a message into a running session
- **SDK sub-agent architecture**: Added worker and leader sub-agents to avoid context overflow in long-running tasks; configurable via `room.config.agentSubagents`; built-in Tester sub-agent auto-included for coder agents; leader analysis helpers for read-only tasks; planner plan-writer sub-agent with scope-adaptive file structure
- **Task completion/cancellation UX redesign**: Replaced raw cancel button with a three-dot dropdown menu with `CompleteTaskDialog` and `CancelTaskDialog` modals (confirmation flow, optional summary/reason fields)
- **Stop/terminate sessions from task view**: Amber interrupt button in task view header to interrupt running worker or leader sessions mid-stream without changing task status
- **Dead loop detection**: Levenshtein similarity + count/time-based detection (5 failures / 5 min / 75% similarity) prevents infinite bounce cycles in runtime gates
- **Leader gets room-agent-tools**: Leader agent now has access to task/goal management tools via the `room-agent-tools` MCP server for dynamic plan adjustment

### Changed
- **Task status rename**: `failed` → `needs_attention` for clearer semantic meaning; UI tab labels and localStorage keys updated with backward compatibility
- **Planner workflow**: Planner now correctly creates PR and draft tasks before completing; added planning-specific post-approval workflow where the leader sends the planner back to run Phase 2 instead of merging directly

### Fixed
- **Question handling**: Tasks now pause (stay in `waiting_for_input`) when a worker or leader asks a question via `AskUserQuestion` instead of cancelling or routing to the next agent
- **Worker→Leader routing**: Fixed bug where worker finishes first round but gets stuck without triggering leader; added zombie group detection fix, silent routing failure logging, and `recoverStuckWorkers()` for automatic recovery
- **Real-time task status synchronization**: Fixed 7 room/goal DaemonHub events (`room.task.update`, `room.overview`, `room.runtime.stateChanged`, `goal.*`) not being forwarded to WebSocket clients; added event bridge in `StateManager`
- **State synchronization**: Fixed `submittedForReview` flag not being set on `set_task_status` → `review` transitions, and `resumeWorkerFromHuman` no longer incorrectly changes task to `in_progress` for approvals
- **PR mergeability checks**: Leader now validates PR health (merge conflicts, failing CI) before submitting for human review
- **Duplicate messages after restart**: Fixed race condition where tick loop ran before recovery completed, causing duplicate restart injection messages
- **Model field handling**: Fixed inconsistent model resolution in `buildLeaderHelperAgents` — now uses `resolveModelId`/`resolveProvider` helpers consistently with `buildReviewerAgents`
- **Removed `handoff_to_worker` no-op tool**: Removed legacy compatibility shim from leader agent; updated all prompts and tests
- **Auto-revive failed tasks**: Sending a message to a `needs_attention` task now auto-revives it to `review` status with sessions restored
- **Fail tasks on terminal API errors**: Tasks now fail immediately on terminal API errors instead of bouncing indefinitely

## [0.6.2] - 2026-03-13

### Fixed
- **Configuration**: Bumped patch version for dependency updates

## [0.6.1] - 2026-03-12

### Fixed
- **Configuration**: Fixed kai binary not using ANTHROPIC_BASE_URL from environment and settings.json
  - Preserve user's custom ANTHROPIC_BASE_URL from environment/settings
  - Clear ANTHROPIC_BASE_URL when not user-configured (use default)
  - Preserve all user-configured environment variables from settings.json
  - Improved code clarity and variable naming (renamed `originalBaseUrl` to `userConfiguredBaseUrl`)

## [0.6.0] - 2026-02-?? (date may vary)

### Added
- Enhanced session management and state synchronization
- Improved E2E test reliability with dev proxy

### Fixed
- Various bug fixes and improvements

## [0.5.2] - 2026-02-?? (date may vary)

### Fixed
- Bug fixes and improvements

## [0.5.1] - 2026-02-?? (date may vary)

### Fixed
- Bug fixes and improvements

## [0.5.0] - 2026-02-?? (date may vary)

### Added
- New features and improvements

## [0.4.0] - 2026-01-?? (date may vary)

### Added
- New features and improvements

## [0.3.0] - 2026-01-?? (date may vary)

### Added
- Initial release features
