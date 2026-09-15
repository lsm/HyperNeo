# Reducing the Node Agent Initial User Message

**Status:** research — no code changes proposed in this PR
**Task:** #81 "Research: Reduce node agent initial prompt size by reviewing prompt stacking"
**Author:** Research agent
**Date:** 2026-04-22

## TL;DR

- For the Research → Review workflow that spawned *this* task, the first user
  message delivered to the Research node agent measured **4 963 bytes**
  (builder portion 3 856 B + appended Runtime Execution Contract 1 107 B) —
  about **1 240 input tokens**. The task description dominated at **2 554 B
  (~51%)**, followed by the Runtime Contract at **1 107 B (~22%)** and the
  Standing Instructions at **832 B (~17%)**.
- The brief's premise that "standing instructions are duplicated between the
  system prompt and the user message" does **not** hold for node agent
  sessions in the current code. `buildCustomAgentSystemPrompt` never injects
  `space.instructions` or `workflow.instructions`; only
  `buildCustomAgentTaskMessage` does. (The Task Agent path is different — see
  §4 — but that path doesn't spawn node agents.)
- The real duplication is between **`## Your Role in This Workflow`** (emitted
  by the builder) and **`## Runtime Execution Contract`** (appended by
  `TaskAgentManager.buildNodeExecutionRuntimeContract`). Both sections name
  the node, its role, its outbound channels, and its gates — in two different
  formats. Merging them is the single highest-impact cleanup.
- The Runtime Contract also re-describes every node-agent MCP tool in plain
  text (`send_message({ ... }) — communicate with peers …`). Those same
  tools already ship full descriptions in the MCP tool-schema layer. The
  user-message copy is ~500 B of redundant instruction on every session spawn
  **and** every injected kickoff message.
- The contract still embeds the node UUID (`Node: "Research" (3fee…)`) —
  directly contradicting the design doc comment "Node UUIDs are intentionally
  dropped — they are not useful to the LLM and add noise."
- Recommended trims save roughly **1.2–1.6 KB (~300–400 tokens) per message**
  while preserving every fact the agent actually needs. For a 20-session,
  10-turn workflow that's ≈ 60–80 K input tokens saved per run (before
  prompt caching).

---

## 1. Assembly pipeline (as of `dev @ d21876114`)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  System prompt                                                          │
│    ── Preset "claude_code" (SDK-owned — see @anthropic-ai/claude-agent-sdk)
│    └── append: visiblePrompt =                                          │
│          expandPrompt(customAgent.customPrompt, slot.customPrompt)       │
│        • Space agent persona (e.g. "You are a research specialist…")    │
│        • Workflow slot override (e.g. "You are the Research agent in a  │
│          Research→Reviewer iterative workflow…")                        │
├─────────────────────────────────────────────────────────────────────────┤
│  Tool descriptions (added by SDK, streamed as MCP/tool-schema JSON)     │
│    • Claude Code preset built-ins (Bash/Read/Write/Grep/Glob/…)         │
│    • MCP server "node-agent"   (9 tools — 3.2 KB of descriptions)       │
│    • MCP server "space-agent-tools" (17 tools — 3.3 KB of descriptions) │
│    • MCP server "db-query"     (present on Task Agent; not on nodes)    │
│    • Any enabled skills (plugins + MCP servers per space)               │
├─────────────────────────────────────────────────────────────────────────┤
│  Initial user message (the focus of this research)                      │
│    buildCustomAgentTaskMessage(config):                                 │
│      1. ## Your Task #N   — title / description / priority              │
│      2. ## Runtime Location — worktree + derived PR URL                 │
│      3. ## Your Role in This Workflow                                   │
│           - Node / Peers / Channels / Gates you can write               │
│      4. ## Previous Work on This Goal  (only if summaries supplied)     │
│      5. ## Project Context             (space.backgroundContext)        │
│      6. ## Standing Instructions       (space.instructions +            │
│                                         workflow.instructions)          │
│    THEN TaskAgentManager appends:                                       │
│      7. ## Runtime Execution Contract                                   │
│           Node / Agent / Tools available / Outbound gated channels /    │
│           completion guidance for end-node sessions                     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Code paths confirming the above**

| Section | File | Function | Notes |
| --- | --- | --- | --- |
| System prompt | `packages/daemon/src/lib/agents/custom-agent.ts` | `buildCustomAgentSystemPrompt` / `createCustomAgentInit` | `systemPrompt.append = customAgent.customPrompt + slot.customPrompt`. No `space.instructions` here. |
| User message (body) | `custom-agent.ts` | `buildCustomAgentTaskMessage` | Renders sections 1–6. Soft-warns at 4 096 B (see §2). |
| Runtime contract (section 7) | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` | `buildNodeExecutionRuntimeContract` | Invoked in the kickoff block at ~line 942 and concatenated with `\n\n`. |
| MCP tool descriptions | `packages/daemon/src/lib/space/tools/node-agent-tools.ts` | `createNodeAgentMcpServer` (tool literals ~lines 1053–1170) | 9 tools for node sessions. |
| MCP tool descriptions | `packages/daemon/src/lib/space/tools/space-agent-tools.ts` | (tool literals ~lines 1023–1260) | 17 tools attached to *every* session in a Space (including node agents — see `space-runtime-service.attachSpaceToolsToMemberSession`). |

> **File-name note.** The task brief referenced
> `packages/daemon/src/lib/space/runtime/node-agent-manager.ts` and
> `packages/daemon/src/lib/space/agents/node-agent-tool-schemas.ts`. Neither
> path exists. The authoritative files are
> `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (manages both
> Task Agent and node-agent sub-session lifecycle) and
> `packages/daemon/src/lib/space/tools/node-agent-tool-schemas.ts`.

## 2. Measured byte breakdown (task #81 kickoff)

Reconstructed from the user message this research session received and
verified against `buildCustomAgentTaskMessage` + `buildNodeExecutionRuntimeContract`.

| Section | Bytes | % of full message |
| --- | ---: | ---: |
| `## Your Task` header + title | 106 | 2.1% |
| Task **Description** body | 2 554 | 51.5% |
| Task **Priority** line | 20 | 0.4% |
| `## Runtime Location` | 166 | 3.3% |
| `## Your Role in This Workflow` | 174 | 3.5% |
| `## Standing Instructions` (space only) | 832 | 16.8% |
| `## Runtime Execution Contract` (appended) | 1 107 | 22.3% |
| **Total user message** | **4 963** | 100% |
| ↳ builder output only (sections 1–6) | 3 856 | 77.7% |

Approximate token cost: **≈ 1 240 input tokens** (at the ~4 B/token rule of
thumb for English).

### Constant vs. variable

| Section | Grows with | Constant per session? |
| --- | --- | --- |
| Task description | operator-supplied text | No — dominates for research/long tasks |
| Runtime Location | 1 line + PR URL | Yes |
| Your Role | # of peers / channels / gates | ~nearly constant for a given workflow |
| Previous Work | # of prior tasks in the goal | Grows with goal history (currently unused — see §3.D) |
| Project Context | `space.backgroundContext` | Yes per space |
| Standing Instructions | `space.instructions` + `workflow.instructions` | Yes per space |
| Runtime Contract | # of outbound gated channels, end-node extras | ~constant for a given node |

> **Soft limit.** `USER_MESSAGE_SOFT_LIMIT_BYTES = 4 096` in `custom-agent.ts`.
> Importantly, the limit is evaluated on the *builder* message (3 856 B for
> task #81) — **before** the 1 107 B Runtime Contract is appended. So the
> real on-the-wire message has been materially above 4 KB in production
> without tripping the warning. This is worth fixing alongside any trim
> (§3.H).

### MCP tool description overhead (for context)

Not part of the 4 963 B user message, but shipped on every SDK request:

| MCP server | # tools | Description bytes (text only) |
| --- | ---: | ---: |
| `node-agent` | 9 | 3 238 |
| `space-agent-tools` | 17 | 3 332 |
| Claude Code preset built-ins | ~15 | 4–6 KB (not measured here) |

Each tool's JSON input schema is additionally serialised by the SDK — a
further ~100–300 B per tool.

## 3. Redundancy, verbosity, and conditional-inclusion findings

### A. "Your Role" and "Runtime Execution Contract" restate the same facts

Both sections are emitted on every kickoff. Side-by-side (task #81, abridged):

```text
## Your Role in This Workflow                  ## Runtime Execution Contract
- Node: Research                               Node: "Research" (3fee9b9e-…)
- Peers: Review                                Agent: "research"
- Channels from this node: Review              Tools available:
  (Research → Review)                            - send_message(…) — …
- Gates you can write:                           - save_artifact(…) — …
  research-ready-gate (PR Ready)                 - …
                                               Outbound gated channels:
                                               - Gate "research-ready-gate" for
                                                 channel "Research" -> "Review"
                                                 - Include in send_message data:
                                                   • pr_url (string) — check: exists
```

- **Node name** — duplicated (once bare, once quoted with UUID).
- **Channel "Research → Review"** — duplicated (Unicode arrow vs. ASCII arrow).
- **Gate `research-ready-gate`** — duplicated (label vs. field schema).

The two sections were added in separate iterations (the Role section was
introduced after the Runtime Contract). The comment atop `buildCustomAgentTaskMessage`
reads "Node UUIDs are intentionally dropped — they are not useful to the LLM
and add noise", but the appended contract still emits them.

### B. Tool tables duplicate MCP tool descriptions

```
  - send_message({ target, message, data? }) — communicate with peers; when a channel is gated, `data` is automatically merged into the gate
  - save_artifact({ type, key?, append?, summary?, data? }) — persist typed data to the artifact store. …
  - list_artifacts({ nodeId?, type? }) — list artifacts for the current workflow run
  - list_peers / list_reachable_agents / list_channels / list_gates / read_gate — discovery
  - restore_node_agent({ reason? }) — self-heal fallback: …
```

Each of those tools is *already* described in the MCP server factory
(`node-agent-tools.ts` lines 1053–1170, measured at **3.2 KB of descriptions**),
which the SDK surfaces to the model as authoritative tool schemas. Embedding
a compressed re-list in the user message doesn't add the schema info (the
model already has it) — it only adds a suggestion of when to use each tool.
The same guidance could live once in the system prompt or be dropped entirely
now that the canonical MCP text was upgraded in the 2025-10 series of
node-agent PRs.

### C. `restore_node_agent` appears three times

In a single node agent's context, `restore_node_agent` is:

1. Registered on `node-agent` with a 456-byte description.
2. Re-registered on `space-agent-tools` with a 353-byte description (this is
   intentional — §3 of `node-agent-mcp-loss-root-cause.md` — so the recovery
   primitive survives if `node-agent` is lost).
3. Mentioned in the user-message Runtime Contract as a bullet.

#1 + #2 are justified by the belt-and-braces recovery story. #3 is pure
duplication of #1.

### D. `Previous Work on This Goal` is *always* skipped in the node-agent path

`TaskAgentManager.createNodeSubSession` (lines 803–813, 929–941 of
`task-agent-manager.ts`) calls `resolveAgentInit` and `buildCustomAgentTaskMessage`
**without ever passing `previousTaskSummaries`**. The section is emitted only
by callers that do — there are none in the current tree. So for node agent
kickoff the bullet list is dead code; either:

- Wire up `previousTaskSummaries` from the goal history (desirable for
  continuity — but a separate feature), or
- Drop the parameter entirely from `CustomAgentConfig` and the factory
  signature to remove a trap-door for future bloat.

### E. Standing Instructions can silently carry both space and workflow copies

`buildCustomAgentTaskMessage` lines 215–223 concatenates
`space.instructions` and `workflow.instructions` under a single
`## Standing Instructions` header separated by `\n\n`. For Spaces that also
attach a workflow with `instructions` set, both blocks are emitted verbatim
with no deduplication. We do not have a deduplication pass or a
content-hash check. This is a latent footgun rather than an active
regression for Task #81 (the Research Workflow has no
`workflow.instructions`).

### F. Task Agent system prompt vs. node agent system prompt

Worth calling out because the brief suggested cross-prompt duplication:

- **Task Agent session** (`buildTaskAgentSystemPrompt`): renders
  `space.backgroundContext` and `space.instructions` **in the system
  prompt** (§346–348), and does NOT re-emit them in the initial user
  message (`buildTaskAgentInitialMessage`). ✅ No duplication.
- **Node agent session** (`buildCustomAgentSystemPrompt` +
  `buildCustomAgentTaskMessage`): the system prompt is purely the agent's
  persona + the slot customPrompt; `space.instructions` / `space.backgroundContext`
  only appear in the user message. ✅ No system/user duplication.

So the brief's "standing instructions appearing in both system prompt and
user message" concern applies to *neither* code path today — but also means
there is no obvious "delete the duplicate" win hidden here.

### G. Slot customPrompts are append-only, never de-duplicated against the agent persona

`expandPrompt(customAgent.customPrompt, slot.customPrompt)` simply joins
with `\n\n`. Operators therefore often repeat the persona in the slot
prompt (compare `seed-agents.ts` "You are a research specialist…" with
`built-in-workflows.ts` Research slot "You are the Research agent in a
Research→Reviewer iterative workflow…"). We cannot guarantee a free trim
without data — but we should add a comment + a dev-mode warning when the
overlap exceeds, say, 200 B. This is the same tooling pattern used for the
user-message soft limit.

### H. The 4 KB soft-limit check ignores the appended Runtime Contract

Already mentioned in §2. The warning therefore misses the case that
motivated this task (a builder output of 3 856 B + 1 107 B contract = 4 963 B
on the wire, no warning). At minimum we should:

1. Measure the final message (builder + contract) before warning, or
2. Move the contract *into* the builder so there is exactly one assembly
   site (and one measurement).

## 4. Concrete recommendations, ranked by bytes saved per message

Byte estimates are relative to the measured task #81 kickoff (4 963 B). The
"When" column explains whether the saving applies to every node session or
only to specific shapes.

| # | Recommendation | Est. savings | When it applies | Risk |
| --- | --- | ---: | --- | --- |
| R1 | **Merge `## Your Role` and `## Runtime Execution Contract`** into a single section emitted *inside* the builder. Keep Role's bullet format, keep Contract's gate-field table, drop redundant node name/UUID/tool list. | ~500–700 B | Every node session | Low — no loss of information; needs tests for existing Role snapshot asserts and all "Outbound gated channels" uses. |
| R2 | **Delete the "Tools available" bulleted list** from the Runtime Contract. The SDK already ships canonical MCP descriptions. Keep the end-node guidance about `approve_task` / `submit_for_approval` (it's behavioural, not schema-overlapping) but in one sentence rather than two bullets. | ~350–450 B | Every node session | Low — tool availability is enforced by the MCP server; the model will still see schemas. Requires a regression test that Research and Coder nodes still handoff on first turn. |
| R3 | **Drop the node UUID** from the merged section (R1). Already the stated intent of the design doc for the builder; the contract currently violates it. | ~40 B | Every node session | None — UUID was explicitly called out as noise. |
| R4 | **Compress tool-name bullets in the Runtime Contract for end nodes** to the completion guidance only. The end-node paragraph at lines 2016–2026 of `task-agent-manager.ts` re-lists `save_artifact` + `approve_task` / `submit_for_approval` despite both already being in the earlier bullet list. Keep one behavioural sentence. | ~250–350 B | End-node sessions only | Low — the two sentences differ only in framing (one lists, one sequences). |
| R5 | **Drop the dead `previousTaskSummaries` code path** from `CustomAgentConfig` / `buildCustomAgentTaskMessage` *or* wire it to the actual goal history. Right now it's a dormant section that future callers could unknowingly balloon. | 0 B today, unbounded if wired naïvely | Node sessions in goal-linked workflows | Medium — if we keep the parameter we should also cap each summary to e.g. 300 B. |
| R6 | **De-duplicate `space.instructions` and `workflow.instructions`** before concatenation. Simple normalised-whitespace compare; if identical, render once. If not, collapse shared leading/trailing paragraphs. | 0–800 B | Spaces with overlapping instructions | Low — pure content-equality check. |
| R7 | **Trim `space.backgroundContext`** to N × 1 KB (configurable; default 1 KB) before rendering, logging a warn when trimming happens. Most `backgroundContext` usage today fits within 1 KB; the guard prevents a wiki paste from silently bloating every spawn. | variable | Spaces with large backgroundContext | Medium — the cap must be configurable on the Space; otherwise operators are surprised. Best to pair with a UI indicator. |
| R8 | **Fix the soft-limit check** to measure `builderMessage + runtimeContract` (or fold the contract into the builder per R1) and raise the threshold to 6 KB post-merge. Today's 4 KB limit silently mis-measures. | 0 B (observability only) | Dev environment | None. |
| R9 | **Add a dev-mode log when `expandPrompt` joins two prompts that share ≥ 200 chars of trigram overlap** (R7-style guard for persona/slot overlap). | 0 B (observability only) | Dev environment | None. |

### Total savings envelope

Applying R1 + R2 + R3 + R4 to task #81:

- Runtime Contract shrinks from **1 107 B → ~250–400 B**.
- Role section shrinks from **174 B → 0 B** (merged into Contract).
- Net user message size: **≈ 3 400–3 500 B** (down 1.4–1.6 KB, ~30% cut).

Applying R1–R4 to a typical "small" task description (say, 400 B
description, no backgroundContext): message falls from **~2 800 B → ~1 500 B** —
almost halved. That matters because small tasks are the most
session-spawn-heavy (handoffs, re-activations) and the prompt-caching hit
rate is lowest right at spawn.

## 5. What stays the same

For every recommendation above:

- **Behavioural contracts are preserved.** The gate-field table (e.g.
  `pr_url (string) — check: exists`) stays — it tells the agent *what
  payload keys to include in `send_message.data`*, and that fact is not
  derivable from the MCP schemas.
- **End-node completion guidance stays**, because whether `approve_task`
  is unlocked for the *current* space + workflow combination (autonomy
  level math) is runtime-only and not in the MCP schema.
- **Operator content stays.** `space.instructions`, `space.backgroundContext`,
  `workflow.instructions`, `task.description` are the knobs operators
  control; we only add (opt-in) caps, we do not silently rewrite them.
- **Tools stay registered.** We are removing *duplicate mentions*, not
  tools.

## 6. Implementation notes for the follow-up coding task

- Changes are isolated to two files:
  - `packages/daemon/src/lib/agents/custom-agent.ts`
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
- Existing tests with snapshots of the user message / runtime contract
  need updating. A quick scan with `rg 'Runtime Execution Contract|Your Role in This Workflow'` returns only `task-agent-manager.ts`; snapshot tests, if any, live under `packages/daemon/tests/unit/**`.
- The **end-node branch** in `buildNodeExecutionRuntimeContract` must keep
  two distinct shapes depending on `approveUnlocked` — the test coverage
  for both branches should be preserved when R4 collapses the restated
  bullets into a single sentence.
- The soft-limit fix (R8) should measure the *on-the-wire* message, i.e.
  move the warning into `TaskAgentManager.createNodeSubSession` right
  before `injectMessageIntoSession(kickoffMessage)`, or return the
  contract + builder length as a struct from `buildCustomAgentTaskMessage`.

## 7. Open questions

1. **Should the Runtime Contract live in the system prompt instead of the
   user message?** Pros: cache-friendly (system prompt is a stable
   prefix). Cons: the contract contains per-node-execution state (current
   gate fields), which is dynamic. A middle ground is to split it into a
   stable "node + tools" slice (system prompt) and a dynamic "gate
   payloads for this send" slice (user message). Beyond the scope of this
   task, but worth flagging.
2. **Do we need `list_peers` *and* `list_reachable_agents` as two MCP
   tools?** They overlap heavily (~750 B of description). A combined
   `list_neighbors` with optional filters would save 300–400 B on *every*
   session, including the Task Agent. Worth a follow-up.
3. **Should `space-agent-tools` be trimmed from node-agent sessions?** Of
   the 17 tools, at least `list_workflows`, `get_workflow_detail`,
   `suggest_workflow`, `change_plan`, `retry_task`, `cancel_task`,
   `reassign_task`, `approve_completion_action`, `approve_gate` arguably
   do not belong on worker/node sessions. Attaching them surfaces
   ~3 KB of additional MCP description text per node session. This is
   outside the user-message scope but a bigger ticket than the
   user-message trim.

## 8. Methodology

- Reconstructed the task #81 initial user message from the exact template in
  `buildCustomAgentTaskMessage` and the template in
  `buildNodeExecutionRuntimeContract`, using the actual values pasted into
  this session's task header (title, description, priority, workspace path,
  node/peer/channel/gate metadata, standing instructions).
- Measured byte counts using `Buffer.byteLength(s, 'utf8')` in a Bun
  script; numbers in §2 are exact, not estimates.
- Cross-checked wiring by reading:
  - `packages/daemon/src/lib/agents/custom-agent.ts`
  - `packages/daemon/src/lib/space/agents/task-agent.ts`
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
  - `packages/daemon/src/lib/space/tools/node-agent-tools.ts` /
    `node-agent-tool-schemas.ts` /
    `task-agent-tool-schemas.ts` /
    `space-agent-tools.ts`
  - `packages/daemon/src/lib/agents/seed-agents.ts`
  - `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`

## 9. Sources

- Code in this worktree at commit `d21876114`.
- `CLAUDE.md` §"Space Agent User Message Anatomy" (documents the intent of
  `buildCustomAgentTaskMessage` and the 4 KB dev-mode warning).
- `docs/research/node-agent-mcp-loss-root-cause.md` (explains the
  `restore_node_agent` duplicate registration rationale referenced in §3.C).
