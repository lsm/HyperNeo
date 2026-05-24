# Generic prompt injection registry spec

## Purpose

NeoKai needs compressed output mode, but implementing it as one bespoke append inside `QueryOptionsBuilder` would not scale. Future features will also need prompt additions: safety/approval rules, autonomy policy, workflow gates, language preference, reviewer formats, provider quirks, cost-saving hints, and task-specific contracts.

Recommendation: add a generic, data-driven prompt injection registry/composer. Compressed output mode becomes the first built-in injection template controlled by typed output-mode settings.

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
	id: string;
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

Use reverse-DNS-like IDs for built-ins:

- `neokai.output-mode.compressed`
- `neokai.worktree-isolation`
- `neokai.space-chat.contract`
- `neokai.workflow.runtime-contract`

User/config records can use generated UUID-backed IDs:

- `user.<uuid>`
- `space.<spaceId>.<uuid>`

## Storage

### Built-in templates

Built-ins live in code as template providers. They produce `PromptInjection` records at runtime when enabled by typed settings.

Reason: compressed output, worktree isolation, and safety contracts need versioned source control and tests.

### User/configurable injection records

Use a dedicated SQLite table for user/config/workflow-driven prompt injection records rather than stuffing arrays into `GlobalSettings` JSON.

Proposed table:

```sql
CREATE TABLE prompt_injections (
	id TEXT PRIMARY KEY,
	scope_type TEXT NOT NULL CHECK(scope_type IN (
		'global', 'session', 'space', 'space_agent', 'workflow', 'workflow_node', 'task'
	)),
	scope_id TEXT,
	channel TEXT NOT NULL CHECK(channel IN (
		'system.prepend', 'system.append', 'agent.prompt.append', 'user.prepend'
	)),
	priority INTEGER NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	content TEXT NOT NULL,
	source_kind TEXT NOT NULL,
	source_ref TEXT,
	constraints TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX idx_prompt_injections_scope ON prompt_injections(scope_type, scope_id, enabled);
```

Benefits:

- Query/audit by scope.
- Enforce size/validation at repository boundary.
- Avoid shallow-merge issues in `global_settings.settings` JSON.
- Easier UI inspection/debug.

### Output mode setting

Keep output mode typed, separate from generic prompt injection records.

```ts
export type AgentOutputMode = 'normal' | 'compressed';
```

Persistence surfaces:

- `GlobalSettings.outputMode?: AgentOutputMode` — user-level default.
- `SessionConfig.outputMode?: AgentOutputMode | null` — per-session override, stored inside session config JSON.
- `AgentSessionInit.outputMode?: AgentOutputMode | null` — creation-time override.
- `Space.outputMode?: AgentOutputMode | null` — optional Space default.
- `SpaceAgent.outputMode?: AgentOutputMode | null` — Space agent override.
- Later: workflow-slot and task-run override.

Recommended defaults:

- App default: `normal`.
- Non-Space sessions: inherit user default, but initial shipped user default should remain `normal`.
- Space agents may opt into `compressed` without changing chat default.

## Resolution model

### Output mode precedence

Highest non-null source wins:

| Precedence | Source |
|---:|---|
| 1 | Task-run/session override |
| 2 | Workflow-slot override |
| 3 | SpaceAgent override |
| 4 | Space default |
| 5 | User-level setting |
| 6 | App default `normal` |

Explicit `normal` overrides inherited `compressed`.

### Prompt injection resolution

`PromptInjectionResolver` produces records from multiple providers:

```ts
interface PromptInjectionProvider {
	resolve(ctx: PromptInjectionContext): Promise<PromptInjection[]> | PromptInjection[];
}
```

Provider examples:

- `BuiltinOutputModeInjectionProvider`
- `BuiltinWorktreeInjectionProvider`
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
	task?: SpaceTask;
	effectiveOutputMode: AgentOutputMode;
}
```

## Composition rules

### Validation

Reject or disable invalid records:

- Missing/duplicate `id` after provider merge.
- Unsupported `channel`.
- `content` empty or above configured max size.
- User/config source tries to use reserved built-in ID prefix `neokai.`.
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

### Conflict handling

- If any active injection has `requiresNormalProse`, output-mode compressed injection is suppressed for that render.
- Any injection can list `suppresses: ['neokai.output-mode.compressed']`.
- Built-in safety/approval injections must not be suppressible by user-configured output-style injections.
- Duplicate IDs: highest-priority source wins only if source is allowed to override; otherwise fail closed and log.

### Provenance

Composer returns both text and metadata:

```ts
interface ComposedPromptInjections {
	byChannel: Record<PromptInjectionChannel, string>;
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
	composed.byChannel['agent.prompt.append']
);
```

### System prompt rendering

Support existing NeoKai shapes:

- `undefined` → create append string when needed.
- `string` → prepend/append joined with double newline.
- `{ type: 'preset', preset: 'claude_code', append }` → merge into `append`.

Do not expand to SDK `string[]` in MVP unless needed.

### Subagent rendering

Apply `agent.prompt.append` to `queryOptions.agents[*].prompt` when scope says `appliesToSubagents`.

Reason: SDK subagents do not inherit parent `systemPrompt.append`.

Avoid blindly applying all system injections to all subagents. Some layers are parent-only.

### SDK hook rendering

Hooks are not MVP transport for standing injections. They may later provide dynamic event-specific records:

- pre-tool safety context
- post-tool result compression hints
- session-start diagnostics

Use hook output as runtime provider data, not as persistent source of truth.

### SDK `outputStyle`

The SDK type defs expose `outputStyle?: string` in settings and result metadata shows `output_style` / `available_output_styles`. NeoKai already writes file-only `outputStyle` via `SettingsManager.prepareSDKOptions()`.

For MVP:

- Keep NeoKai `outputMode` typed and first-class.
- Render compressed semantics via explicit prompt injection.
- Do not depend on SDK `outputStyle` because it is settings-file driven and not guaranteed to match NeoKai safety/clarity contract.
- Later, optionally map `outputMode: 'compressed'` to a compatible SDK output style if custom styles become reliable.

## Built-in compressed output injection

Provider emits this only when `effectiveOutputMode === 'compressed'` and not suppressed:

```json
{
	"id": "neokai.output-mode.compressed",
	"channel": "system.append",
	"priority": 650,
	"enabled": true,
	"source": { "kind": "builtin", "ref": "outputMode", "label": "Compressed output mode" },
	"scope": { "appliesToSubagents": true },
	"content": "## Output style\n\nWhen outputMode is `compressed`, be terse and action-first.\n\n- Drop filler, pleasantries, hedging, and recap prose.\n- Prefer fragments and bullets over paragraphs.\n- Report only: result, blocker, changed files, verification, next required action.\n- Keep code blocks, identifiers, paths, URLs, commands, and exact errors unchanged.\n- Use normal clear prose for security warnings, irreversible actions, approval requests, and multi-step instructions where compression could create ambiguity.\n- Do not reduce review thoroughness, test expectations, or tool diligence."
}
```

Open question: use `system.append` only, or also `agent.prompt.append` for all subagents? Recommendation: renderer should create a subagent-channel copy when `scope.appliesToSubagents` is true, so subagents receive equivalent output style without relying on parent prompt inheritance.

## API and UI

### Debug endpoint

Add endpoint to preview effective prompt injections for a session/task:

```ts
promptInjections.preview({ sessionId }) -> {
	effectiveOutputMode,
	applied,
	suppressed,
	byChannelPreview
}
```

This is critical for support and prompt-order debugging.

### Settings UI

- Global output mode default: `Normal` / `Compressed`.
- Advanced prompt injections list later:
  - scope
  - enabled
  - priority
  - content preview
  - provenance

### Session UI

- Per-session output mode toggle at create/session settings.
- Shows inherited source: `Default: Normal from global settings`.

### Space UI

- Space default output mode.
- Agent editor override: `Default` / `Normal` / `Compressed`.
- Task-run advanced override later.

## Implementation plan

### Task 1 — Prompt injection core

- Add shared types for `PromptInjection`, channels, source, constraints.
- Add `PromptInjectionResolver`, `PromptInjectionComposer`, `PromptInjectionRenderer` under `packages/daemon/src/lib/agent/prompt-injections/`.
- Add built-in provider support but only worktree/output-mode templates initially.
- Integrate renderer in `QueryOptionsBuilder` after session-specific query options are assembled and before cleanup.
- Apply supported channels to top-level `systemPrompt` and `agents[*].prompt`.
- Add unit tests for ordering, suppression, rendering shapes, subagent append behavior.

### Task 2 — Output mode config

- Add `AgentOutputMode` shared type.
- Add `GlobalSettings.outputMode` with default `normal`.
- Add `SessionConfig.outputMode` and `AgentSessionInit.outputMode`.
- Resolve effective mode with precedence and provenance.
- Add compressed output built-in provider.
- Tests for global/session precedence and compressed prompt presence/absence.

### Task 3 — Space overrides

- Add `Space.outputMode` and `SpaceAgent.outputMode` if product wants Space-level control immediately; otherwise start with SpaceAgent only.
- Add migrations/repository/RPC serialization.
- Thread overrides into session creation for Space chat, long-term agents, workflow node agents, and Space task agents.
- Tests for precedence: task/session > workflow slot > SpaceAgent > Space > user > app.

### Task 4 — UI

- Settings UI global default.
- Session creation/session settings toggle.
- Space/Agent editor override.
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
10. At least one pair each with `thinkingLevel: 'none'` and `'low'`.

Record output tokens, input tokens, quality rubric, ambiguity/safety issues. Require >=50% median output-token reduction without quality regression before changing defaults.

## Risks

- Prompt bloat if too many injections stack. Mitigate with max content size and preview.
- Conflicting instructions. Mitigate with priority bands and suppression rules.
- Subagent divergence. Mitigate with explicit `agent.prompt.append` rendering and scope flags.
- Hidden behavior. Mitigate with provenance/debug endpoint.
- SDK changes. Mitigate by keeping renderer isolated from policy/config.

## Open decisions

1. Should prompt injection records be exposed to users in MVP, or remain built-in/internal until output mode ships?
2. Should Space default output mode ship with backend core, or wait for Space UI work?
3. Should `worktree-isolation` move into the generic injection system immediately, or remain existing code until after compressed mode proves the path?
4. Should workflow runtime contracts become injections later? Likely yes, but not MVP.

## Recommendation

Build generic prompt injection infrastructure first. Keep compressed output as the first consumer, implemented as a built-in injection template controlled by typed `outputMode` settings. Render via top-level `systemPrompt` append and scoped subagent prompt append, not Claude Code hooks or SDK `outputStyle`.
