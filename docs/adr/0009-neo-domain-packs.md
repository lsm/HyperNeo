# ADR 0009: Neo Domain Packs

## Status

Proposed — 2026-10-10. Tracks epic #6230. Agreed between the Neo backend and
daemon-code sessions and approved by the user before any code moves.

## Context

Neo is meant to be a general mechanism: it understands what the human asks
for, drives the available tools and sessions toward that outcome, verifies the
result and tells the human once. Nothing in that loop is specific to software.

In practice the first and most frequent domain is coding, and its specifics
have grown into Neo's core:

| Area | Coding-specific part on `dev` |
|---|---|
| Evidence | `lib/neo/work-prs.ts` (~390 lines): PR links in reports, a `gh` reader, CI and review summary, merge blockers from branch rules, signatures and threads. `neo_work_prs` (m314, m317) and `NeoWorkPrRepository`. `NeoWorkPr` in `shared` and `snapshot.workPrs`. |
| Decisions | `service.ts`: the PR refresh pipeline, done checks that wait while CI runs, the stalled-merge reminder, PR links in the follow pass. |
| Checklist | The `pr_merged` item check kind (m318 CHECK constraint, op schema). |
| Prompts | `neo/work/goal-merge.md`, `done-check-prs-{live,stale,ready}.md`; examples in `system/prompt.md` ("for code usually merged…", "Merged in #6099"); place resolution phrased as git remotes and worktrees; the merge example in `root-rule-save.md`; the `/merg/` regex in `withWorkGoal`. |
| Neo's own reads | `look-up-guard.ts` `NEO_LOOKUP_COMMANDS` (read-only `gh` and `git`). |
| Drivers | Worktree placement (`planWorkPlacement`) and git-remote matching in `work.find`. |

The domain-agnostic core is everything else: asks and their checklists, cards
and their targets, bindings and holders, the done-check, follow-up and reminder
machinery, standing rules, publications and consultations. A legal-review ask
would use all of it unchanged.

Facts from the code that constrain the design:

- `restrictNeoQuery` (`neo/session-policy.ts`) strips SDK plugins, setting
  sources, agents and every MCP server except `hyperneo-operations` from a Neo
  session. The skills registry (`SkillsManager`) and the app MCP registry feed
  worker sessions through `QueryOptionsBuilder`; they never reach Neo.
- The operation registry is one static list built at startup, and
  `check:operation-names` requires every name in `OPERATION_NAMES`.
- `prompts/src/loader.ts` (`buildPromptRegistry`, `fillPrompt`) is pure string
  work. It runs on markdown read at runtime just as well as on bundled imports,
  and `fillPrompt` throws on a missing key.
- ADR 0007: whatever attaches a capability returns its briefing in the same
  value.
- Optional tables guard with `hasTable()`, and all migrations run from one
  numbered sequence.

The user asked for this code to live in a dedicated place under Neo, as an
extensible system: built-in packs plus ones that are easy to add, such as a
legal workflow, which are not loaded by default.

## Decision

### 1. Core owns the loop; packs own a domain

Core keeps asks, checklists and ticking, cards and drivers, the done-check,
follow-up and reminder pipelines, delivery bookkeeping, standing rules,
publications and consultations. It also keeps three things that look
domain-specific but are not packs' to change:

- The lookup allowlist (`NEO_LOOKUP_COMMANDS`). It bounds what Neo's native
  tools may run; a pack that widened it would grant privileges by being
  installed.
- Placement and git-remote matching, which belong to the driver adapters that
  start work in a folder and were just unified across Codex, Claude and
  HyperNeo (#6170, #6198). Only the prose about worktrees and remotes moves
  into the coding pack's instructions.
- The migration sequence. A pack may own tables and repositories, never a
  migration runner.

A pack owns a domain's knowledge (how work is done and what done means there),
its evidence (how progress is read) and its checks (which checklist items the
daemon can verify itself).

### 2. Layout and naming

- Built-in packs: `packages/daemon/src/lib/neo/packs/<id>/` and
  `packages/prompts/src/neo/packs/<id>/`, bundled and imported like today's
  prompts.
- File packs: `~/.hyperneo/neo-packs/<id>/`, read at startup.
- Pack ids are kebab-case. Kinds a pack defines are pack-qualified
  (`coding.pr_merged`), so one column holds every pack's kinds; kinds core
  defines stay bare.

`packs/` is a container inside `neo/`, not a new top-level subsystem, so the
flat `lib/` rule is unaffected.

### 3. A pack is a set of stage functions

A pack contributes stage functions that core pipelines compose. It has no
lifecycle hooks and no pipelines of its own.

```ts
interface NeoPack {
  id: string;
  describe: string;
  instructions(ask: NeoAsk): string | null;
  readEvidence?(work: NeoWork, report: string | null): Promise<NeoEvidence[]>;
  checks?: Record<string, (item: NeoAskItem, evidence: readonly NeoEvidence[]) => Gate>;
  workerSkills?: string[];
  workerMcpServers?: string[];
}
```

- `describe`: one line, always in Neo's prompt.
- `instructions`: the full domain guidance, pure, in Agent Skills format
  (`SKILL.md` frontmatter `name` and `description`, body on use), so packs
  follow the cross-vendor standard. A built-in pack may vary it by ask; for a
  file pack it is the static `SKILL.md` body, with no templating layer.
- `readEvidence`: the pack's one effect stage. For a card under a live ask,
  core runs the ask's pack's `readEvidence`; for an ask with no pack (every
  ask until slice d, and generic asks after it) it runs every enabled pack's,
  coding first, so PR tracking never lapses for asks opened without a pack. A
  card with no live ask (no ask, or one that has settled) still has its
  evidence read the same way, so its state stays current, but it never wakes
  Neo: delivery waits for a live ask (#6222).
- `checks`: pure gates, one per item kind.
- `workerSkills` / `workerMcpServers`: ids in the existing skills and app MCP
  registries that sessions working on the pack's asks should get. A pack
  references them; it does not ship a second plugin mechanism.

### 4. Evidence and bookkeeping

`NeoEvidence` is an in-memory type: `{ key, state, summary, blockers }`, with
`state` one of `pending`, `waiting`, `ready`, `done` or `failed`. A pack that
needs to persist its reads owns its table: `neo_work_prs` stays, owned by the
coding pack.

Delivery bookkeeping is core's. A new `neo_work_checks` table holds, per card,
the signature of the evidence Neo was last told about, when, and whether a
reminder went out. The signature is canonical: evidence sorted by `key`, with
volatile fields such as read times excluded, so an unchanged state never
re-delivers. A pack's `summary` is part of that signature, so it must be a pure
function of the state it describes (no read times, counts or relative ages);
`blockers` compare as a set. Until the old `neo_work_prs` columns are dropped, writes go to
both, so a rollback reads current state.

The done-check path is one core pipeline: read evidence (effect), a pure
`planDoneCheck(evidence, checks, bookkeeping)` deciding wait, deliver or
remind, then the delivery (effect). A shared evidence table waits until a
second pack needs persisted evidence.

### 5. Each ask names its pack, and loads it on use

Neo's root session handles many asks, and a Neo session gets no skills or file
tools, so pack instructions cannot sit in the system prompt per ask.

- The system prompt carries core rules plus each enabled pack's `describe`
  line, and tells Neo to choose an ask's pack when it opens it.
- `neo.ask.open` takes an optional `pack`: a plain string, checked against the
  enabled packs by a pure admission gate (the operation schema is static). The
  pack is stored on the ask. An ask with no pack is generic.
- `neo.pack.read {id}` returns a pack's instructions: progressive disclosure,
  the step where Agent Skills read a body on use. It returns text only and
  needs no gate. Per ADR 0007, `neo.ask.open` returns the pack's briefing in
  the same value when a pack is set.
- Done-check, follow-up and card notes for a pack's ask embed that pack's
  fragment, once per delivered note and never per reminder, so done-time
  knowledge arrives where it is used without growing every turn.
- When a pack is disabled, asks that already name it keep it; new opens with
  it are refused.

### 6. Enablement

The coding pack is built in and enabled. Other packs, built in or from files,
are installed but disabled until enabled in settings. The ask's `pack` is the
per-ask switch.

### 7. Operations

`neo.pack.read` and the `pack` field of `neo.ask.open` are core: the new
operation gets its entry in `OPERATION_NAMES` like any other.

Built-in packs may contribute operations. They are always registered, so the
catalog, `OPERATION_NAMES` and discovery stay static and checked. Enablement is
a pure admission gate (`{ reason: 'pack_disabled' }`), and a disabled pack's
operations are hidden from discovery. File packs contribute no operations:
their names cannot be declared ahead of time, and the door is reachable by
every agent.

### 8. Trust

Built-in packs are TypeScript in this repository. File packs are knowledge
only in their first version: a static `SKILL.md` plus references to registry
skills and MCP servers. Installing one validates its frontmatter and refuses a
body with unfilled `{{…}}` placeholders, so a bad pack fails at install rather
than in a live turn. They never run code inside the daemon. Evidence from file
packs is deferred; when it comes, it arrives through MCP tools, out of
process.

## Alternatives considered

- **Packs as skills in `SkillsManager`.** Rejected. That registry is SDK
  plugin directories for worker sessions, and Neo deliberately takes none.
- **A generic `lib/plugins` subsystem.** Deferred. There is no second consumer:
  Space agents already have the skills registry and agent definitions.
- **A generic evidence table now.** Deferred. It would be shaped by its one
  producer and still need the `NeoWorkPr` projection for the UI.
- **Pack hooks or in-process code, in the style of Claude Code mods.**
  Rejected. Hooks are where pipelines drift back into imperative code, and
  in-process third-party code runs with the daemon's privileges.
- **Packs that widen Neo's lookup commands.** Rejected: privilege escalation
  by install.

Survey of comparable systems (October 2026):

| System | Unit | Activation |
|---|---|---|
| Claude Code | Plugins: skills, subagents, hooks, MCP, LSP, monitors; mods are JS hooks modules | User, project or local scope; skill descriptions always in context, bodies on use |
| Codex | Skills (`SKILL.md`) packaged as plugins with MCP, hooks and browser extensions | `/plugins` toggles; progressive disclosure |
| Agent Skills | Cross-vendor `SKILL.md` folders with scripts and references | Name and description at startup, body on activation |
| Gemini CLI | Extensions: manifest, context file, TOML commands, MCP | Context file every session |
| Goose | Extensions (MCP) and recipes (instructions, required extensions, parameters) | A recipe enables its extensions |
| OpenHands | `AGENTS.md` plus skills | Keyword, file path, or the agent's choice |
| Cursor, Kiro | Rules and steering files | Always, file glob, description, manual |

Every one separates knowledge (markdown), capabilities (tools over MCP) and
lifecycle code, discloses knowledge progressively, and gives activation an
explicit trigger. For Neo the natural trigger is the ask's pack, chosen when
the ask opens, much like a Goose recipe.

## Consequences

- Neo's core prompt loses the coding examples, and coding guidance arrives
  with coding asks. This can change routing and done-check behaviour, so the
  prompt split ships only after a before/after run on the eval set.
- A second domain needs no core change: a knowledge-only pack is markdown plus
  an enable switch. The first second pack, life admin, is built in instead,
  because it reads evidence and has a check; it still needs no core change.
- `pr_merged` becomes `coding.pr_merged`, which needs a migration of the m318
  constraint and existing rows.
- Delivery bookkeeping moves out of `neo_work_prs`. The old columns are copied,
  written alongside the new table until slice g, then dropped, so a rollback
  before g still reads current state.

## Migration

One PR per rung (ADR 0004 ladder):

| # | Slice | Owner |
|---|---|---|
| a | Pin: already covered by `neo-work-prs`, `neo-driver-work` and `neo-done-check` tests | — |
| b | Extract: move `work-prs.ts`, `NeoWorkPrRepository`, `goal-merge.md` and `done-check-prs-*.md` into `packs/coding/`, verbatim | daemon-code |
| c1 | Core `neo_work_checks` table, migration and repository; bookkeeping copied and dual-written, coding still the only producer | Neo backend |
| c2 | `NeoEvidence`, `NeoPack`, the coding pack implementing it, core pipelines wired through it | Neo backend |
| d | Prompt split: core plus coding fragment, `neo.ask.open {pack}`, `neo.pack.read`; gated on the eval | Neo backend |
| e | Second pack: life admin (`docs/design/neo-life-admin-pack.md`), shipped disabled; the enable setting; the file-pack loader | first free |
| f | `pr_merged` to `coding.pr_merged`, with its migration | Neo backend |
| g | Delete the copied `neo_work_prs` columns | Neo backend |

The daemon ticking merged items (#6194) and PR attribution (#6186) wait for c2
and land inside the coding pack.

## Open items

- The eval set for slice d and who runs it is the user's call.
- File-pack evidence through MCP tools, and its schema.
- Whether a pack's worker skills attach automatically when a card under its
  ask starts, or only when Neo names them.
- Pack defaults per concern, and standing rules scoped to a pack.

## References

- ADR 0004 — superpipe pipelines; packs are stage functions inside them.
- ADR 0006 — the operations door that pack operations go through.
- ADR 0007 — capability briefings; `neo.pack.read` and `neo.ask.open` return
  the briefing for the pack they attach.
- Epic #6230 — this ladder. Epic #6002 — asks driven to outcomes.
- Claude Code plugins and mods: https://code.claude.com/docs/en/plugins/overview
- Codex skills: https://developers.openai.com/codex/skills
- Agent Skills specification: https://agentskills.io
