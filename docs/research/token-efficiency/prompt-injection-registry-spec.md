# Generic prompt injection registry spec

## Purpose

NeoKai needs compressed output mode, but implementing it as one bespoke append inside `QueryOptionsBuilder` would not scale. Future features will also need prompt additions: safety/approval rules, autonomy policy, workflow gates, language preference, reviewer formats, provider quirks, cost-saving hints, and task-specific contracts.

Recommendation: add a generic, data-driven prompt injection registry/composer. Compressed output becomes the first built-in injection template activated by scoped registry records, not by feature-specific typed fields.

## Goals

- Support prompt additions for all agent sessions: user chat, workers, Space chat, Space task agents, long-term Space agents, and SDK subagents.
- Keep prompt injection deterministic, inspectable, and testable.
- Avoid hardcoded feature enums such as `output-mode | workflow | autonomy` as product surface.
- Separate policy/config from SDK rendering.
- Preserve safety/approval/clarity rules even when output mode is compressed.

## Non-goals

- Do not replace every existing Space prompt builder in the first milestone.
- Do not use Claude Code hooks as primary persistent storage/config.
- Do not rely on SDK `outputStyle` for MVP semantics.
- Do not make compressed mode default-on before measurements prove quality-neutral token reduction.

## Current architecture findings

Subagent deep dive found:

- `QueryOptionsBuilder.build()` is the central SDK `Options` composer for every `AgentSession`.
- `buildSystemPrompt()` maps session config to SDK `systemPrompt`.
- Current prompt forms handled by NeoKai:
  - custom string prompt
  - `{ type: 'preset', preset: 'claude_code', append?: string }`
- Worktree isolation currently appends in the system-prompt builder.
- `SettingsManager.prepareSDKOptions()` writes file-only settings such as SDK `outputStyle` into `.claude/settings.local.json` before SDK startup.
- `outputStyle` is not passed directly as an SDK `Options` field.
- SDK hooks can emit `additionalContext`, but that is event-timed context, not a durable session-start contract.
- SDK subagents do **not** automatically inherit parent `systemPrompt.append`; NeoKai already manually appends worktree isolation to coordinator specialist prompts.
- Space task agents with custom tools can place visible agent behavior into `agents[*].prompt`, not only top-level `systemPrompt.append`.

Conclusion: primary render point should be common session query options, plus a secondary render over `queryOptions.agents[*].prompt` for subagent definitions when an injection should apply to subagents.

## Data model

### PromptInjection

Prompt injection records are data, not feature-specific code paths.

```ts
export type PromptInjectionChannel =
	| 'system.prepend'
	| 'system.append'
	| 'agent.prompt.append'
	| 'user.prepend';

export type PromptInjectionSourceKind =
	| 'builtin'
	| 'settings'
	| 'session'
	| 'space'
	| 'space-agent'
	| 'workflow'
	| 'task'
	| 'runtime';

export interface PromptInjection {
	/** Unique materialized record ID for this scoped instance. */
	id: string;
	/** Stable built-in/template ID, e.g. `neokai.output-mode.compressed`. */
	templateId?: string;
	channel: PromptInjectionChannel;
	priority: number;
	enabled: boolean;
	content: string;
	scope?: PromptInjectionScope;
	source: PromptInjectionSource;
	constraints?: PromptInjectionConstraints;
	createdAt?: number;
	updatedAt?: number;
}

export interface PromptInjectionScope {
	sessionTypes?: SessionType[];
	sessionId?: string;
	spaceId?: string;
	spaceAgentId?: string;
	workflowId?: string;
	workflowNodeId?: string;
	taskId?: string;
	agentName?: string;
	appliesToSubagents?: boolean;
}

export interface PromptInjectionSource {
	kind: PromptInjectionSourceKind;
	ref?: string;
	label?: string;
}

export interface PromptInjectionConstraints {
	requiresNormalProse?: boolean;
	suppresses?: string[];
	maxContentChars?: number;
}
```

### Stable IDs

Use reverse-DNS-like template IDs for built-ins:

- `neokai.output-mode.compressed`
- `neokai.worktree-isolation` (future migration, not MVP)
- `neokai.space-chat.contract` (future migration, not MVP)
- `neokai.workflow.runtime-contract` (future migration, not MVP)

A scoped activation record still needs its own unique row ID so the same built-in can be enabled at many scopes. Example record IDs:

- `global.neokai.output-mode.compressed`
- `space.<spaceId>.neokai.output-mode.compressed`
- `workflow-node.<workflowId>.<nodeId>.<agentName>.neokai.output-mode.compressed`
- `user.<uuid>` for user-authored content records

## Storage

### Built-in templates

Built-ins live in code as template providers. They produce `PromptInjection` content at runtime when enabled by scoped registry records.

Reason: compressed output and future safety/workflow contracts need versioned source control and tests. MVP ships only the compressed output built-in; worktree isolation and workflow contracts stay on existing code paths until later migration. Activation state still lives in the same `prompt_injections` storage model as user/config records, so future built-ins use the same scoped enable/suppress mechanism.

### User/configurable injection records

Use a dedicated SQLite table for user/config/workflow-driven prompt injection records rather than stuffing arrays into `GlobalSettings` JSON.

Proposed table:

```sql
CREATE TABLE prompt_injections (
	id TEXT NOT NULL PRIMARY KEY,
	scope_type TEXT NOT NULL CHECK(scope_type IN (
		'global', 'session', 'space', 'space_agent', 'workflow', 'workflow_node', 'task'
	)),
	scope_id TEXT,
	-- scope_id must be NULL only for global records and NOT NULL for every scoped record.
	CHECK(
		(scope_type = 'global' AND scope_id IS NULL)
		OR (scope_type <> 'global' AND scope_id IS NOT NULL)
	),
	template_id TEXT,
	channel TEXT NOT NULL CHECK(channel IN (
		'system.prepend', 'system.append', 'agent.prompt.append'
	)),
	-- MVP schema rejects stored user.prepend records until message-level rendering exists.
	priority INTEGER NOT NULL CHECK(priority BETWEEN 500 AND 799),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
	content TEXT,
	CHECK((template_id IS NOT NULL) OR (content IS NOT NULL AND length(content) > 0)),
	source_kind TEXT NOT NULL CHECK(source_kind IN (
		'settings', 'session', 'space', 'space-agent', 'workflow', 'task', 'runtime'
	)),
	source_ref TEXT,
	constraints TEXT CHECK(constraints IS NULL OR json_valid(constraints)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX idx_prompt_injections_scope ON prompt_injections(scope_type, scope_id, enabled);
CREATE INDEX idx_prompt_injections_template ON prompt_injections(template_id, enabled);
```

Benefits:

- Query/audit by scope.
- Enforce size/validation at repository boundary.
- Let scoped records activate built-in `template_id`s without copying built-in prompt content into SQLite.
- Avoid shallow-merge issues in `global_settings.settings` JSON.
- Easier UI inspection/debug.

### Built-in activation records

Compressed output is not a typed product setting. Do **not** add `AgentOutputMode`, `GlobalSettings.outputMode`, `SessionConfig.outputMode`, `AgentSessionInit.outputMode`, `Space.outputMode`, `SpaceAgent.outputMode`, or `WorkflowNodeAgent.outputMode`.

Activation is data in the prompt injection registry. The built-in template ID is stable:

- `neokai.output-mode.compressed`

Enable or suppress that ID with scoped `prompt_injections` records:

| Scope type | Scope ID | `template_id` | Meaning |
|---|---|---|---|
| `global` | `NULL` | `neokai.output-mode.compressed` | User-level default for all matching new sessions. |
| `session` | `<session-id>` | `neokai.output-mode.compressed` | One chat/worker/session override. |
| `space` | `<space-id>` | `neokai.output-mode.compressed` | Space default for Space chat, Space task agents, and agents in that Space. |
| `space_agent` | `<space-agent-id>` | `neokai.output-mode.compressed` | Reusable SpaceAgent override. |
| `workflow` | `<workflow-id>` | `neokai.output-mode.compressed` | Default for every node-agent slot in one workflow template/run. |
| `workflow_node` | `<workflow-id>:<node-id>:<agent-name>` | `neokai.output-mode.compressed` | Workflow-template slot override. |
| `task` | `<task-id>` | `neokai.output-mode.compressed` | One task/run override. |

Normal/default behavior is absence of an enabled compressed-output record, or a narrower suppressing record with `constraints.suppresses: ['neokai.output-mode.compressed']`. This same model generalizes to future safety, autonomy, language-preference, and workflow-contract injections.

Recommended defaults:

- App default: no compressed-output record.
- User-level compressed output should be opt-in via a global record.
- Space default is a Space-scoped record, not a column on `spaces`.
- SpaceAgent default is a Space-agent-scoped record, not a field on `SpaceAgent`.
- Workflow-slot override is a workflow-node-scoped record, not a field on `WorkflowNodeAgent`.

## Resolution model

### Scope precedence

The injection resolver should use generic scope precedence, not output-mode-specific code. For the same injection ID or suppress target, narrower scope wins:

| Precedence | Scope |
|---:|---|
| 1 | Task |
| 2 | Session |
| 3 | Workflow node/slot |
| 4 | Workflow |
| 5 | SpaceAgent |
| 6 | Space |
| 7 | Global/user |
| 8 | App default: no record |

Task scope wins over session scope because a task/run override is narrower than the long-lived session that may execute it. Workflow-node scope wins over workflow scope because a slot override is narrower than a workflow-wide default. MVP implementation can ship active scopes incrementally, but the resolver contract should cover the full order above. Provenance should record the winning activation/suppression source and all suppressed candidates.

### Space default inheritance

Space default compressed output is stored as a `prompt_injections` row:

```sql
-- Conceptual row; exact insert uses repository helpers.
id = 'space.<space-id>.neokai.output-mode.compressed'
template_id = 'neokai.output-mode.compressed'
scope_type = 'space'
scope_id = '<space-id>'
channel = 'system.append'
priority = 650
enabled = 1
source_kind = 'space'
source_ref = '<space-id>'
```

No `ALTER TABLE spaces ADD COLUMN output_mode` migration is needed.

Repository/API behavior:

- `SpaceRepository` does not persist output mode on the `spaces` row.
- Space settings UI creates, enables, disables, or suppresses scoped `prompt_injections` records.
- SpaceAgent create/update does not copy inherited Space behavior into the agent row.
- If a Space-scoped compressed-output record exists and a new SpaceAgent has no Space-agent-scoped record, sessions for that agent inherit the Space record dynamically.
- If the Space record is later disabled/suppressed, agents without narrower records follow the new Space behavior; agents with Space-agent-scoped records keep their explicit behavior.

Space UI:

- Space settings: compressed output selector backed by scoped records (`Default`, `Compressed`, `Normal/suppress`).
- `Default` means no Space-scoped record; broader global/app behavior applies.
- `Compressed` enables `neokai.output-mode.compressed` at `scope_type = 'space'`.
- `Normal/suppress` creates or enables a Space-scoped suppressing record when a broader global record would otherwise compress output.
- Agent editor uses same pattern at `scope_type = 'space_agent'`.

### Workflow and workflow-slot override

Workflow templates should not add `WorkflowNodeAgent.outputMode`. Workflow-wide compressed output is represented as workflow-scoped prompt injection metadata that materializes to `scope_type = 'workflow'` records. Per-slot compressed output is represented as workflow-node-scoped metadata that materializes to `scope_type = 'workflow_node'` records.

Recommended workflow template shape:

```ts
interface WorkflowNodeAgent {
	agentId: string;
	name: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	customPrompt?: WorkflowNodeAgentOverride;
	promptInjectionRefs?: string[];
	// ...existing slot fields
}
```

`promptInjectionRefs` references template-owned injection definitions by ID, for example `neokai.output-mode.compressed`. Workflow-level refs create `scope_type = 'workflow'` records keyed by `workflowId`. Node-agent refs create `scope_type = 'workflow_node'` records keyed by `(workflowId, workflowNodeId, agentName)`.

Persistence/import/export:

- Workflow JSON preserves `promptInjectionRefs` or equivalent scoped injection metadata, not `outputMode`.
- Built-in workflow templates reference compressed output at workflow scope when every slot should share it, or workflow-node scope when a slot should intentionally differ from inherited workflow/SpaceAgent/Space/global behavior.
- Export format includes prompt injection refs/records for workflow and node-agent scopes; import validation accepts only known built-ins or safe user/config records.
- Drift hashing includes workflow and slot prompt injection refs/records so template changes to output behavior are detected.

Runtime mapping:

- Workflow-scoped records are resolved when launching any node execution session in that workflow.
- Workflow-node scoped records are resolved when launching the node execution session for that slot.
- Task scope wins over session scope; both win above workflow-node and workflow scopes. Use them for one-off runs that need full prose even if the workflow defaults compressed.
- Workflow-node scope wins over workflow scope, and workflow scope wins over SpaceAgent scope. This lets a workflow template make all slots compressed, then make one slot normal/suppressed, without mutating reusable SpaceAgent defaults.
- The scoped activation applies to matching node agent sessions and SDK subagents spawned inside them via the compressed injection's `appliesToSubagents` behavior; workflow-node scope does not apply to sibling node agents or future sessions for the same SpaceAgent outside this workflow slot.

### Prompt injection resolution

`PromptInjectionResolver` produces records from multiple providers:

```ts
interface PromptInjectionProvider {
	resolve(ctx: PromptInjectionContext): Promise<PromptInjection[]> | PromptInjection[];
}
```

Provider examples:

- `BuiltinOutputModeInjectionProvider`
- `BuiltinWorktreeInjectionProvider` (future migration, not MVP)
- `DatabasePromptInjectionProvider`
- `SpacePromptInjectionProvider`
- `WorkflowPromptInjectionProvider`
- later: `RuntimeHookPromptInjectionProvider`

Context:

```ts
interface PromptInjectionContext {
	session: Session;
	globalSettings: GlobalSettings;
	space?: Space;
	spaceAgent?: SpaceAgent;
	workflowRun?: SpaceWorkflowRun;
	workflowNode?: WorkflowNode;
	workflowNodeAgent?: WorkflowNodeAgent;
	task?: SpaceTask;
}
```

## Composition rules

### Validation

Reject or disable invalid records:

- Missing `id`.
- Duplicate `id` after provider merge; duplicates are invalid and must not be precedence-resolved in MVP.
- Unsupported `channel`.
- `scope_id` missing for any non-global `scope_type`; global records must use `scope_id = NULL`.
- `content` empty or above configured max size when `template_id` is absent.
- `template_id` references an unknown built-in.
- User-authored content record tries to use reserved built-in ID prefix `neokai.` as row `id`.
- User/config source tries to use protected priority band.

### Priority bands

Documented bands keep ordering stable:

| Band | Range | Use |
|---|---:|---|
| Base runtime | 0–99 | SDK/base/session invariants |
| Safety/approval | 100–199 | destructive action, security, approval clarity |
| Workspace | 200–299 | worktree/current directory constraints |
| Autonomy/workflow | 300–399 | gates, channels, terminal actions |
| Agent/task role | 400–499 | persona, task contract, role behavior |
| User custom | 500–599 | user-authored prompt additions |
| Output style | 600–699 | compressed/normal prose formatting |
| Hints | 700–799 | low-priority preferences |

Use one direction consistently. Recommended composer sorts by ascending `priority`, then `id`, so lower bands appear earlier and output style appears late enough to shape wording without preceding safety policy.

Persisted user/config/workflow records are schema-limited to non-protected bands `500–799`. Built-in providers may emit protected lower-band records from code, but the user/config table must not persist them.

### Conflict handling

- If any active injection has `requiresNormalProse`, output-mode compressed injection is suppressed for that render.
- Any injection can list `suppresses: ['neokai.output-mode.compressed']`.
- Built-in safety/approval injections must not be suppressible by user-configured output-style injections.
- Duplicate row IDs are never resolved by priority in MVP. Treat duplicates as invalid, suppress all records with that row ID for the render, log the conflict, and expose it in `suppressed` provenance. Multiple rows may share a `template_id`; scope precedence decides which activation/suppression for that template applies.

### Provenance

Composer returns both text and metadata:

```ts
interface ComposedPromptInjections {
	byChannel: Record<PromptInjectionChannel, string>;
	byChannelEntries: Record<PromptInjectionChannel, PromptInjection[]>;
	agentPromptEntries: PromptInjection[];
	applied: Array<{ id: string; source: PromptInjectionSource; priority: number }>;
	suppressed: Array<{ id: string; reason: string }>;
}
```

Expose this in debug/session metadata, not in model prompt.

## Rendering model

Keep SDK-specific rendering isolated.

```ts
const injections = await resolver.resolve(ctx);
const composed = composer.compose(injections);
queryOptions.systemPrompt = promptRenderer.applyToSystemPrompt(
	queryOptions.systemPrompt,
	composed.byChannel['system.prepend'],
	composed.byChannel['system.append']
);
queryOptions.agents = promptRenderer.applyToAgentPrompts(
	queryOptions.agents,
	composed.agentPromptEntries
);
const userPrependEntries = composed.byChannelEntries['user.prepend'];
```

Composer must retain per-injection metadata, not only joined strings. Composer owns subagent copy generation: `agentPromptEntries` includes explicit `agent.prompt.append` records plus composer-generated copies of records whose scope has `appliesToSubagents: true`. Renderer consumes `agentPromptEntries` as-is and must not create additional subagent copies. This keeps one component responsible for copy generation and prevents double-appends.

`user.prepend` must not silently no-op. MVP behavior: compose and expose `user.prepend` entries in preview/provenance, but do not allow stored records on that channel until a concrete message-rendering path exists. If enabled later, renderer must prepend it to the first user message submitted to the SDK query stream or to task-init messages before enqueueing.

### System prompt rendering

Support existing NeoKai shapes:

- `undefined` → create append string when needed.
- `string` → prepend/append joined with double newline.
- `{ type: 'preset', preset: 'claude_code', append }` → keep the preset object and merge both `system.prepend` and `system.append` into `append`, with prepend text placed before append text inside the appended block. This is the only representable MVP shape that preserves Claude Code preset semantics and still applies prepend content in default sessions. Record provenance note `system.prepend.rendered-inside-preset-append` because the content is after the SDK preset, not before it.

Do not expand preset prompts to SDK `string[]` in MVP because doing so would drop Claude Code preset semantics and dynamic sections. If true before-preset prepend becomes required later, add SDK support or materialize the full preset prompt explicitly.

### Subagent rendering

Apply `agent.prompt.append` entries to `queryOptions.agents[*].prompt`. Composer must preserve entry scope and source metadata so renderer can distinguish:

- records explicitly authored for `agent.prompt.append`
- composer-generated subagent copies of `system.append` records with `scope.appliesToSubagents === true`
- parent-only `system.append` records that must not reach subagents

Reason: SDK subagents do not inherit parent `systemPrompt.append`, and joined channel strings lose the scope metadata required for deterministic subagent targeting. Renderer only applies entries provided by the composer; it does not inspect `system.append` entries to create its own copies.

Avoid blindly applying all system injections to all subagents. Some layers are parent-only.

### User prepend rendering

`user.prepend` is reserved for future message-level injections. MVP schema and repository validation must reject stored `user.prepend` records because no renderer applies them to the SDK message stream yet.

When implemented, `user.prepend` must be applied at message enqueue/build time, not in `systemPrompt`, and must be covered by tests that prove it reaches user chat messages and Space task-init messages. Until then, keeping the channel reserved but invalid prevents silent no-op configuration.

### SDK hook rendering

Hooks are not MVP transport for standing injections. They may later provide dynamic event-specific records:

- pre-tool safety context
- post-tool result compression hints
- session-start diagnostics

Use hook output as runtime provider data, not as persistent source of truth.

### SDK `outputStyle`

The SDK type defs expose `outputStyle?: string` in settings and result metadata shows `output_style` / `available_output_styles`. NeoKai already writes file-only `outputStyle` via `SettingsManager.prepareSDKOptions()`.

For MVP:

- Do not add NeoKai `outputMode` typed fields.
- Render compressed semantics via scoped prompt injection records.
- Do not depend on SDK `outputStyle` because it is settings-file driven and not guaranteed to match NeoKai safety/clarity contract.
- Later, optionally map active `neokai.output-mode.compressed` injection to a compatible SDK output style if custom styles become reliable.

## Built-in compressed output injection

Provider emits this only when resolver finds an enabled `neokai.output-mode.compressed` activation record that is not suppressed by a narrower or higher-priority applicable record:

```json
{
	"id": "space.<space-id>.neokai.output-mode.compressed",
	"templateId": "neokai.output-mode.compressed",
	"channel": "system.append",
	"priority": 650,
	"enabled": true,
	"source": { "kind": "builtin", "ref": "neokai.output-mode.compressed", "label": "Compressed output" },
	"scope": { "appliesToSubagents": true },
	"content": "## Output style\n\nWhen the compressed output injection is active, be terse and action-first.\n\n- Drop filler, pleasantries, hedging, and recap prose.\n- Prefer fragments and bullets over paragraphs.\n- Report only: result, blocker, changed files, verification, next required action.\n- Keep code blocks, identifiers, paths, URLs, commands, and exact errors unchanged.\n- Use normal clear prose for security warnings, irreversible actions, approval requests, and multi-step instructions where compression could create ambiguity.\n- Do not reduce review thoroughness, test expectations, or tool diligence."
}
```

Subagent behavior is resolved for MVP: compressed output must reach SDK subagents. Composer should create an `agent.prompt.append` copy when `scope.appliesToSubagents` is true, so subagents receive equivalent output style without relying on parent prompt inheritance. Renderer should only apply composer-provided `agentPromptEntries`.

## API and UI

### Debug endpoint

Add endpoint to preview effective prompt injections for a session/task:

```ts
promptInjections.preview({ sessionId }) -> {
	applied,
	suppressed,
	byChannelPreview,
	activeBuiltins: ['neokai.output-mode.compressed']
}
```

This is critical for support and prompt-order debugging.

### Settings UI

- Global compressed-output toggle backed by `scope_type = 'global'` records.
- Advanced prompt injections list later:
  - scope
  - enabled
  - priority
  - content preview
  - provenance

### Session UI

- Per-session compressed-output toggle at create/session settings, backed by `scope_type = 'session'` records.
- Shows inherited source, e.g. `Default: compressed from Space` or `Default: normal from app default`.

### Space UI

- Space settings compressed-output selector backed by `scope_type = 'space'` records.
- Agent editor override backed by `scope_type = 'space_agent'` records.
- Workflow editor slot override backed by `scope_type = 'workflow_node'` records.
- Task-run advanced override backed by `scope_type = 'task'` records.

## Implementation plan

### Task 1 — Prompt injection core

- Add shared types for `PromptInjection`, channels, source, constraints.
- Add `PromptInjectionResolver`, `PromptInjectionComposer`, `PromptInjectionRenderer` under `packages/daemon/src/lib/agent/prompt-injections/`.
- Add built-in provider support for the compressed output template only. Keep worktree isolation on the existing code path in MVP.
- Integrate renderer in `QueryOptionsBuilder` after session-specific query options are assembled and before cleanup.
- Apply supported MVP channels to top-level `systemPrompt` and `agents[*].prompt`; retain per-entry scope metadata for subagent rendering; reject stored `user.prepend` records at schema and repository layers until message-level rendering exists.
- Add unit tests for ordering, duplicate row-ID suppression, scoped-ID validation, template-ID activation, unsupported-channel rejection, rendering shapes, subagent append behavior with mixed parent-only/subagent-targeted records, and `user.prepend` schema/repository rejection.

### Task 2 — Compressed output built-in activation

- Add `BuiltinOutputModeInjectionProvider` for `neokai.output-mode.compressed`.
- Add repository helpers to create/enable/disable/suppress scoped records for built-in injections.
- Resolve scoped activation/suppression with generic precedence: task > session > workflow-node > workflow > SpaceAgent > Space > global > app default.
- Tests for global/session/Space/SpaceAgent/workflow/workflow-node/task scope precedence and compressed prompt presence/absence.

### Task 3 — Space, agent, and workflow scoped records

- Add Space settings behavior that manages `scope_type = 'space'` records; no `spaces.output_mode` migration.
- Add SpaceAgent editor behavior that manages `scope_type = 'space_agent'` records; no `SpaceAgent.outputMode` field.
- Add workflow behavior that preserves prompt injection refs/records in workflow templates and materializes `scope_type = 'workflow'` records for workflow-wide defaults/suppression.
- Add workflow-node slot behavior that preserves prompt injection refs/records in workflow templates and materializes `scope_type = 'workflow_node'` records.
- Add task-run/session override records when task-run options are implemented.
- Tests for inheritance edge cases: Space compressed + agent no record inherits compressed; SpaceAgent suppress overrides Space compressed; changing Space record affects agents with no narrower records; workflow-node compressed applies only to that slot and its SDK subagents.

### Task 4 — UI

- Settings UI global compressed-output toggle.
- Session creation/session scoped toggle.
- Space settings scoped toggle.
- Space Agent editor scoped toggle.
- Workflow editor node-agent slot scoped toggle.
- Task-run advanced scoped toggle.
- Debug preview endpoint or panel.

### Task 5 — Measurement

Run paired normal/compressed tests across:

1. User chat architecture/code question.
2. User chat command/debug answer.
3. Ad-hoc worker code lookup.
4. Space Coder bug fix.
5. Space Reviewer PR review.
6. Space Research doc task.
7. Space QA failure report.
8. SDK subagent exploration receipt.
9. Safety/approval destructive operation.
10. At least one pair each with `thinkingLevel: 'off'` and `'think8k'`.

Record cumulative output tokens, cumulative input tokens, quality rubric, ambiguity/safety issues. Sum SDK `usage.input_tokens` / `usage.output_tokens` across all result turns in each run, or use equivalent session-level cumulative usage metadata. Require >=50% median output-token reduction without quality regression before changing defaults.

## Risks

- Prompt bloat if too many injections stack. Mitigate with max content size and preview.
- Conflicting instructions. Mitigate with priority bands and suppression rules.
- Subagent divergence. Mitigate with explicit `agent.prompt.append` rendering and scope flags.
- Hidden behavior. Mitigate with provenance/debug endpoint.
- SDK changes. Mitigate by keeping renderer isolated from policy/config.

## Decisions

### 1. User-authored prompt injection records

Decision: keep arbitrary user-authored prompt injection records internal/not exposed in MVP.

MVP exposes safe controls that create scoped records for known built-ins, matching the implementation plan:

- global compressed-output activation/suppression
- per-session compressed-output activation/suppression
- Space compressed-output activation/suppression
- SpaceAgent compressed-output activation/suppression
- workflow compressed-output activation/suppression
- workflow-node compressed-output activation/suppression
- task compressed-output activation/suppression
- debug preview of applied/suppressed injections

Reason: arbitrary prompt content creates prompt-order, priority, safety, and support risk before the registry has proven behavior. The registry should exist internally as infrastructure first. Expose CRUD for custom prompt injections only after built-ins, provenance, suppression, validation, and debug preview are stable.

### 2. Space default compressed output

Decision: cover Space-level default in the spec, but implement it as a Space-scoped prompt injection record rather than as `Space.outputMode`.

Reason: Space defaults are useful bulk policy, but adding feature-specific columns repeats the same design problem for every future injection. A Space-scoped `neokai.output-mode.compressed` record gives the same behavior while keeping activation generic, inspectable, and reusable for future injections.

### 3. Worktree isolation migration

Decision: keep existing worktree-isolation code path for MVP; do not move it into the registry immediately.

Reason: worktree isolation is safety-critical and already wired in several places, including subagent prompt mutation. Moving it while adding compressed output increases regression risk. The registry should support a future `neokai.worktree-isolation` built-in, but first consumer should be low-risk output style. Migrate worktree isolation later after prompt injection renderer has tests and runtime mileage.

### 4. Workflow runtime contracts

Decision: workflow runtime contracts should become prompt injections later, but not MVP.

Reason: workflow contracts involve gates, channels, terminal actions, and review loop semantics. They are higher priority than output style and carry correctness risk. Keep existing workflow prompt paths until the registry supports priority bands, provenance, and suppression well. Then migrate contracts incrementally so workflow prompt assembly becomes inspectable and reusable.

## Recommendation

Build generic prompt injection infrastructure first. Keep compressed output as the first consumer, implemented as a built-in injection template activated by scoped `prompt_injections` records. Render via top-level `systemPrompt` append and scoped subagent prompt append, not Claude Code hooks, typed `outputMode` fields, or SDK `outputStyle`.
