# Prompt Registration Subsystem (design v3)

**Status:** proposal / RFC
**Companion:** `docs/reports/agent-session-prompt-delivery-map.md` (current state)
**v2 → v3:** there is **no privileged/default/manager agent**. All Space agents are equal. A Space may have **zero agents**. Differentiation comes from **capabilities held**, never from identity.

---

## 1. Premise

```
SPACE  =  Agents (0..n, each owns one session)  +  Tasks (each may run a workflow)
```

- **Agents are peers.** None is "the" agent. Whether an agent behaves like a manager, a task
  tracker, or a code reviewer comes from its *instructions*, its *tools*, and the
  *responsibilities* it holds.
- **Zero agents is valid.** A Space with no agents still creates, tracks, and completes tasks.
  Task workers still spawn. Nothing routes to a "manager" that may not exist.
- **No hardcoded handle.** `@space-manager` is not special; it is a handle a template may choose.
  Escalation, review authority, and goal ownership resolve to *whoever holds them* — or to the human.

### 1.1 Consequences for the prompt subsystem

| Before (v2) | After (v3) |
| --- | --- |
| `space.agent.manager` / `space.agent.owner` roles | **one** `space.agent` role |
| role suffix selects doctrine (`.swe`, `.reviewer`) | **capability gate** selects doctrine |
| `buildSpaceChatSystemPrompt` = "You are the Space Manager" | generic `space.agent.*` units + the agent's own instructions |
| escalation target is the literal `space-agent` | escalation resolves to the responsibility holder, else the human |
| `approve_pending_completion` gated on `isDefaultAgent` | gated on the `review_authority` capability |
| goal-outcome fallback → the coordinator agent | fallback → any goal-owner holder, else the human |

### 1.2 Removal manifest (additions for v3)

Everything in v2's manifest (coordinator mode + fleet, ad-hoc member, `space_task_agent`,
`universal_read`/`outside_space`, dead `spaces_global`), **plus the manager itself**:

| Remove | Where |
| --- | --- |
| `getCoordinator` / `getCoordinatorRecord` / coordinator seeding | `storage/repositories/space-long-horizon-agent-repository.ts:95,101,112,133,345` |
| `coordinator.default` template + migration anchor | `agents/long-horizon-agent-templates.ts`, `storage/schema/migrations.ts:8359` |
| **default-agent policy** (locked handle / un-pausable) | `agents/default-agent-policy.ts` (`resolveIsDefaultAgent`, `decideDefaultAgentUpdateAdmission`) |
| `coordinator` kind in agent resolution | `session-resolution/resolve-agent-record.ts:10,20,29` |
| split session provisioning | `runtime/ensure-agent-session.ts:16,48,49` → one `ensureSpaceAgentSession` |
| `space:chat:<spaceId>` coordinator session | `runtime/space-runtime-service.ts:668` (`ensureCoordinatorSession`) |
| privileged actor | `space/actor-registry.ts:75,137` (`coordinatorActor`, exclusion from `agentActors`, reserved handle `coordinator`) |
| coordinator-dependent tools/UI defaults | `tools/space-agent-tools.ts:1392`, `rpc-handlers/space-agent-handlers.ts:605`, `goals/goal-service.ts:110`, `rpc-handlers/space-export-import-handlers.ts` (coordinator-by-handle) |
| hardcoded manager text | `SPACE_MANAGER_HANDLE` usage in `runtime/agent-message-router.ts:364`, `SPACE_CHAT_INTRO`, `LH_COORDINATOR_INSTRUCTIONS` as *the* default |
| identity-based action gating | `actions/space-actions-server.ts` `COORDINATOR_ONLY_ACTIONS` + `isDefaultAgent === true` |

`LH_COORDINATOR_INSTRUCTIONS` survives as an ordinary optional template ("Space Manager") a Space *may* instantiate — it is no longer the default or the fallback.

---

## 2. Diagram M1 — Space model → sessions → profiles (no privileged agent)

```
┌─────────────────────────────────────────── SPACE ───────────────────────────────────────────┐
│                                                                                             │
│   AGENTS (0..n)                                        TASKS (0..n)                         │
│   ┌───────────────────────────────┐                    ┌──────────────────────────────────┐  │
│   │ agent A   instructions/tools  │                    │ task 42                          │  │
│   │ agent B   instructions/tools  │                    │   └─ workflow run                │  │
│   │ agent C   …                   │                    │        ├─ node: Swe   ── session │  │
│   │ (none)    ← valid             │                    │        ├─ node: Review ─ session │  │
│   └───────────┬───────────────────┘                    │        └─ node: QA     ─ session │  │
│               │                                        │   post-approval       ─ session │  │
│               │ 1:1 session                            └──────────────┬───────────────────┘  │
└───────────────┼─────────────────────────────────────────────────────┼───────────────────────┘
                │                                                     │
                ▼                                                     ▼
     context { spaceId, agentId }                        context { spaceId, taskId, workflowRunId,
                │                                                  nodeId, agentName }
                │                                                     │
                └──────────────────────┬──────────────────────────────┘
                                       ▼
                          ┌──────────────────────────┐
                          │   classifySession(facts) │      NO branch on "is this the manager"
                          └────────────┬─────────────┘      NO branch on "is this ad-hoc"
                                       ▼
                          ┌──────────────────────────────────────────────────┐
                          │              SessionProfile                      │
                          │   roleId : space.agent | space.task.worker | …   │
                          │   capabilities:                                  │
                          │     mcpServers  [space-agent-tools, …]           │
                          │     responsibilities [escalation? review? …]     │
                          │     holdings    [goals? schedules? subs?]        │
                          └────────────┬─────────────────────────────────────┘
                                       │  (single source of truth)
                        ┌──────────────┴──────────────┐
                        ▼                             ▼
              CAPABILITY ATTACH              PROMPT RESOLUTION
              (servers/tools/skills)         (units gated by capabilities)
```

**Equality is structural:** the classifier never asks "is this the manager"; the plan is the
same for every `space.agent`; only capability-gated units differ.

---

## 3. Diagram M2 — Capability-gated plans (how one `space.agent` plan serves all agents)

```
                     PromptPlan: space.agent            (identical for every agent)
        ┌──────────────────────────────────────────────────────────────────────────────┐
        │ ALWAYS (unconditional units)                                                 │
        │   space.agent.identity        "You are an agent in Space <name>."            │
        │   space.agent.surface         typed tool doctrine (space-agent-tools)        │
        │   space.agent.dispatcher      doctrine.dispatcher            [cap: dispatch] │
        │   space.agent.autonomy        fragment{spaceLevel}                           │
        │   space.agent.escalation      fragment{escalation holders|null}              │
        │   space.agent.artifacts       artifact + task-lifecycle rules                │
        │   space.agent.subagents       Task/TaskOutput policy                        │
        ├──────────────────────────────────────────────────────────────────────────────┤
        │ CAPABILITY-GATED (included iff the capability is held by THIS agent)          │
        │   space.agent.goalOwner       [cap: holds.goals]       ← was always applied   │
        │   space.agent.scheduling      [cap: holds.schedules]   ← was always applied   │
        │   space.agent.taskTriage      [cap: responsibilities.task_owner]              │
        │   space.agent.reviewAuthority [cap: responsibilities.review]                  │
        │   space.agent.eventHandling   [cap: holds.subscriptions]                      │
        │   space.agent.forge           [cap: holds.forge_scopes]                       │
        ├──────────────────────────────────────────────────────────────────────────────┤
        │ LAYERED (per agent, by unit id)                                              │
        │   L3  agent.instructions        template default OR user-authored             │
        │   L4  space.instructions        space-wide policy                             │
        │   L5  runtime/experiment                                                      │
        └──────────────────────────────────────────────────────────────────────────────┘

  Agent B (owns goals)        → gets space.agent.goalOwner
  Agent C (plain)             → does NOT get goal doctrine
  Space with zero agents      → no space.agent plan is ever resolved
```

This is the direct implementation of "all Space agents are equal": **identity selects nothing;
held capability selects everything.** Today the owner-review contract and scheduling guardrail are
appended to *every* long-term agent whether or not it owns a goal or a schedule
(`session-resolution/agent-session-config.ts:93`).

---

## 4. Diagram M3 — Responsibilities replace the manager

```
  ┌────────────────────────────────────────────────────────────────────────────┐
  │  Responsibility resolver:  responsibility → holders[]  (0..n)              │
  │                                                                            │
  │   'escalation'        ── explicit agent assignment ──┐                     │
  │   'task_owner'        ── @role:<responsibility>  ────┤→ ActorRef[]         │
  │   'goal_owner'        ── ownershipPatterns/labels ───┘                     │
  │   'review_authority'                                                       │
  └───────────────────────────────┬────────────────────────────────────────────┘
                                  │
                  holders.length ─┴─┬──────────────┬──────────────────────
                          > 0       │            = 0
                                    ▼              ▼
                    ┌────────────────────────┐  ┌──────────────────────────────┐
                    │ EscalationFragment     │  │ EscalationFragment           │
                    │  { holderHandle }      │  │  { holderHandle: null }      │
                    │ renders:               │  │ renders:                     │
                    │  send_message(target:  │  │  "No agent holds escalation  │
                    │   "@<handle>", …)      │  │   in this Space. Surface the  │
                    └────────────────────────┘  │   blocker to the human        │
                                                │   operator and stop."         │
                                                └──────────────────────────────┘

  Prompt text therefore contains  {{actor:escalation}}  — never  "space-agent".
  The same fragment feeds:
     · space.agent.escalation                (agent sessions)
     · workflow.worker.runtimeContract       (task sessions; replaces WORKFLOW_ESCALATION_TARGET)
     · node-agent send_message permittedTargets + error strings
     · agent-message-router guidance text
```

Unresolved references are a **declared policy**, not a crash: `{ kind:'actor', id:'escalation',
onUnresolved:'human' }`. Contrast today, where the text hardcodes `space-agent` and depends on
`normalizeReplyTargetHandle()` mapping it onto `@space-manager` — which is meaningless in a Space
that has no manager.

---

## 5. Diagram M4 — Zero-agent Space (first-class path)

```
 Space created with zero agents
        │
        ├─ human creates task via UI / API  ──────────────────────────────┐
        │                                                                 ▼
        │                                                      TaskAgentManager.spawn
        │                                                      classifySession → space.task.worker
        │                                                      resolvePromptPlan(space.task.worker)
        │                                                        · node doctrine        (always)
        │                                                        · dispatcher doctrine  (if attached)
        │                                                        · runtime contract     (always)
        │                                                        · escalation fragment  → holders=[] → HUMAN
        │                                                                 │
        │                                                                 ▼
        │                                                      worker session runs, reports
        │                                                      save_artifact / approve_task / submit_for_approval
        │
        ├─ completion needs sign-off → escalation resolves to holders=[] → human queue  ← no manager needed
        ├─ goal outcome wake        → goal_owner holders=[] → human queue               ← no manager needed
        └─ human adds an agent later → ensureSpaceAgentSession(spaceId, agentId)
                                        · role space.agent
                                        · capabilities = whatever that agent holds
                                        · prompt plan = capability-gated (M2)

 INVARIANT: no code path may assume an agent exists. Every "route to the space's agent"
            resolves through the responsibility resolver with a human fallback.
```

---

## 6. Roles after v3 (final)

```
SessionKind
├── chat.default                  plain chat (non-space)
├── space.agent                   ★ ALL Space agents — one role, capability-gated
├── space.task.worker             node agent session inside a task's workflow run
├── space.task.post_approval      merge/cleanup session
├── github.router | github.security
└── helper.*                      workflow selector, title gen, limit classifier
```

Note the removal of role *suffixes* too: `space.task.worker.swe` is replaced by the coarse role
plus capability tags (`slot.implement`, `slot.review`, `slot.qa`) that gate doctrine and select
dispatcher hot-actions — so `ROLE_HOT_ACTIONS['coder']` free-text lookup disappears along with the
`swe`/`coder` split.

### 6.1 The one open product decision: the human channel

Once no session is "the manager", the current `space:chat:<spaceId>` has no owner. Two options:

- **Option A (recommended): no privileged chat session.** The human addresses whichever agent they
  want (each agent has exactly one session, `space:<spaceId>:agent:<agentId>` — already the case).
  A zero-agent Space is operated entirely from the UI (tasks + agent CRUD). The "Space Manager"
  experience becomes: *create a manager agent from a template if you want one.*
- **Option B: a `space.chat` role that is explicitly not an agent** — a human console session with
  the space surface and no identity/ownership. Compatible with v3 (it is a `chat.*` role, not an
  agent), but it must not be described as "the Space Manager".

Option A is the cleanest expression of "all agents are equal"; Option B can be added later without
reintroducing a privileged agent.

---

## 7. Unchanged from v2 (still the core)

- **Four channels**: system prompt · kickoff message · MCP tool descriptions · skills.
- **Pipeline** `classifySession → SessionProfile → resolvePromptPlan` with stages:
  plan select → capability gate → layers → fragments → ref interpolation → order+budget → provenance.
- **Bidirectional guarantee** (CI-fatal):
  - (A) no orphan capability — every attached capability has a covering unit;
  - (B) no phantom doctrine — every unit's `requires` is satisfied by the profile;
  - (C) every `{{tool|actor|mcp|skill}}` ref resolves (with declared `onUnresolved` policies).
- **Data vs code split**: prompts/plans/capabilities are data; classification and resolution are
  pure functions; only adapters touch I/O.
- **CI gate ladder**: registry-integrity → role-coverage → capability-refs → doc-truth → budget →
  golden-hashes → matrix-snapshot.
- **`optional: true` is exceptional**; the default is required.

---

## 8. Migration order (revised)

```
 1. drop coordinatorMode (config + setting + RPC + web UI)          ── ✅ landed
 2. drop the coordinator subagent fleet + prompts/coordinator/*      ── ✅ landed
 3. drop ad-hoc member path (role, attach fns, callsites)            ── blocked on §6.1
 4. introduce classifySession + SessionProfile (no behaviour change) ── ✅ landed + first consumer
 5. unify ensureCoordinatorSession/ensureLongHorizon → ensureSpaceAgentSession
 6. replace getCoordinator/default-agent-policy with the responsibility resolver
 7. collapse plans: space.agent (capability-gated) + space.task.worker
 8. switch builders → resolvePromptPlan, one role at a time
 9. turn on capability-refs + doc-truth in CI
10. drop space_task_agent / universal_read / outside_space / spaces_global
11. delete coordinator.default template + migration anchors; keep "Space Manager" as an
    optional user-instantiable template
```

Steps 1–3 are pure deletions and can land independently of the subsystem work.

### 8.1 Landing log

**Steps 1–2.** `coordinatorMode` removed from `SessionConfig`, settings, `session.coordinator.switch`
and `query-options-builder`; `lib/agent/coordinator/*` and `prompts/src/coordinator/*` deleted.

**Duty resolution (prerequisite for steps 5–6).** `lib/session-profile/duties.ts` owns
declaration → holder resolution (`escalation`, `goal_owner_fallback`, `review_authority`) with a
human fallback arm. The task runtime contract's escalation line and the goal-owner fallback now
resolve through it instead of naming a manager; `coordinator_fallback` → `fallback`.

**Step 4, landed with its first consumer.** `lib/session-profile/classify.ts` is the single decision
point:

```
  SessionFacts ──classifySession──▶ SessionProfile { kind, sessionId, spaceId, taskId, agentId,
                                                      capabilities[] }
```

`SessionKind` = `chat.default` | `space.chat` | `space.agent` | `space.member` |
`space.task.postApproval` | `space.task.worker` | `space.task.legacy`.
`SessionCapability` names MCP requirements (`mcp.*`) and tool surfaces (`surface.*`), so required
servers and attach decisions derive from one table instead of seven hand-written branch bodies.
`space-mcp-session-policy.ts` is now an adapter: it gathers the I/O facts (node-execution ownership,
task → space, canonical agent session id) and maps the profile onto the policy. The policy exposes
`kind`; its legacy `role` field is gone.

Transitional and deliberate: `SpaceMcpSessionRole` survives in the same module as the **dispatcher
vocabulary** (`DISPATCHABLE_ROLES`, `ROLE_ACTION_FAMILY_ALLOWLIST`, `callerRole`) and is untouched by
this step; `space.member` is the bucket the ad-hoc removal (§6.1) deletes; `space.chat` exists
because the console session still exists.

Verified for step 4: `bun run typecheck`, `bun test tests/unit/1-core/session-profile`,
`bun test tests/unit/5-space` (5960 pass), `bun run lint`, `check:no-comments`, `format:check`, `knip`.

**Prompt units, landed with their first consumer.** `lib/session-profile/prompt-plan.ts` holds the
unit registry and the composer:

```
  PROMPT_UNITS   space.agent.instructions
                 space.agent.goalOwner    [cap: holds.goals]
                 space.agent.scheduling   [cap: holds.schedules]
                 space.agent.escalation   [cap: responsibilities.escalation]

  resolvePromptPlan({ profile, … }) → PromptPlan { entries[], text, unresolved[] }
```

`SessionCapability` gained the declared half (`holds.goals`, `holds.schedules`,
`responsibilities.escalation`), and `classifySession` merges them from `SessionFacts.declaredCapabilities`
onto the kind-derived surface: **kind selects the surface, declared capability selects the doctrine.**

First consumer is `session-resolution/agent-session-config.ts`, which used to append the owner/review
contract and the scheduling guardrail to *every* long-horizon agent (`agent-session-config.ts:93`)
whether or not it owned goals or a schedule. It now composes the append from the plan and declares
capabilities from the agent's template: goal ownership from `ownershipPatterns[target=goal]`,
schedules from `reminderDefaults`/`suggestedEventSubscriptions`, escalation from `duties`. Left
deliberately conservative: a `templateKey` that no longer resolves (retired/`migration.*` keys) keeps
both contracts, because a migrated agent's real holdings are unknown; a template-less (custom) agent
gets no default doctrine.

Still open for a later slice: declared capabilities come from the *template*, not from live holdings
(goals actually owned, reminders actually created) — the adapter that reads those needs repository
access in the config builder, which is step 7 territory alongside the plan collapse.
