# ADR 0007: Capability Briefings

## Status

Proposed — 2026-09-18. Amended 2026-09-18 after #4791's investigation and the
merge of #4793 and #4804; the amendments are marked in §Context, decisions 1,
5 and 6, and §Open items. Tracks epic #4778.

Grows out of #4772, where a Space agent holding the operations tool did not
know it was in a Space, could name `hyperneo-operations` when asked and still
concluded it had no task-management capability, and refused a direct
instruction to call `task.create` for lack of documentation. Nothing was broken
in the sense of throwing: the capability was attached correctly, and the
sentences explaining it were assembled somewhere else entirely.

## Context

A session's runtime context is assembled from two independent places.

Capabilities are attached by `QueryOptionsBuilder.build()`
(`packages/daemon/src/lib/agent/query-options-builder.ts`), which decides the
MCP servers a session gets: the operations server on every session, plus
`agent-memory` and `db-query` for Space sessions via
`SpaceRuntimeService.attachSpaceToolsToMemberSession`, plus the app registry
and its enablement overrides (session > space > default — despite what CLAUDE.md
still says, room scope is not read by the resolver; see #4802).

The prose that explains those capabilities lives in `packages/prompts` and in
agent definition records, and reaches the model through a different path —
`buildCustomAgentTaskMessage` (`packages/daemon/src/lib/agents/custom-agent.ts`)
injects runtime location, role, prior goal work and standing instructions when
a task is assigned.

A session started from an agent's card never walks the second path. It gets
every tool and none of the explanation. The agent's own role text
(`packages/prompts/src/agents/long-horizon/task-manager.md`) is rendered in the
web UI, which makes the gap invisible to a person looking at the screen — the
role is right there, and the model has never seen it.

**Amended.** The mechanism above is not quite what #4793 found, and the
difference matters for rung 1's baseline. `buildAgentSessionConfig` *does*
append the agent's instructions and contracts; `SessionLifecycle.create` then
builds `session.config` from a hardcoded field list that omits `systemPrompt`,
so the text was assembled correctly and silently discarded (#4794 tracks the
allowlist, which drops six other fields including `disallowedTools`). So there
were two independent holes: role text built and dropped, and Space identity
never written anywhere. The structural claim below is unaffected — if anything
a silent drop between two owners is a sharper example of it.

This is not a missing prompt. It is a structural property: **attaching a
capability and explaining a capability are separate code paths with separate
owners, and nothing fails when they disagree.** Any fix that adds the missing
sentences to one more call site preserves the property and buys one bug.

The same shape will recur as the door grows. The operation catalog already runs
to well over a hundred names across fourteen families and gains more most
weeks, and a session's registry is resolved per role by
`resolveSpaceMcpSessionPolicy`. Each new family that assumes the agent has been
told something adds another way for the two halves to drift.

`OPERATION_NAMES` in `packages/shared/src/types/operation-names.ts` is the
record of truth for the current count, and `check:operation-names` keeps it
honest. This document deliberately does not restate the number: a count written
into prose is stale on the next `defineOperation`, which is the same failure
mode decision 3 exists to prevent.

## Decision

### 1. A capability carries its own briefing

Whatever attaches a capability returns the attachment and its briefing as one
value. Not a lookup table keyed by server name, and not a parallel registry —
the same object, constructed together.

```ts
interface CapabilityContribution {
  readonly server: McpServerAttachment;
  readonly briefing: string;
}
```

The property this buys is that a capability with no briefing is not
representable. A subsystem cannot attach a tool and forget to explain it,
because there is no value it can return that omits the explanation.

**Amended.** `McpServerAttachment` did not exist when this was written; #4804
defines it, and the contribution type, in
`packages/daemon/src/lib/briefings/contribution.ts`. Later rungs use those
rather than introducing a second pairing shape. Decision 6 supersedes the shape
shown above with a discriminated union; the property it buys is unchanged.

**Briefing text stays in `.md` files.** `briefing` holds resolved text, not
prose authored in TypeScript. The authored copy lives in `packages/prompts`
alongside the rest of the prompt material and is imported with
`with { type: 'text' }` — the attribute is mandatory, since Bun silently
renders attribute-less `.md` imports to HTML. A subsystem's briefing file sits
with that subsystem's other prompts so ownership is visible in the tree.

What this ADR changes is which code path is responsible for delivering the
text and who owns it, not where the text is written. Prompts remain
markdown, reviewable as prose, diffable as prose.

### 2. Scope contributes separately from capability

Two distinct facts were missing in #4772: what the agent could do, and where it
was. They have different owners and different lifetimes. A capability briefing
belongs to the subsystem owning the door; a scope briefing belongs to the
context the session runs in and states the Space, the role, the workspace and
the agent's own standing instructions.

Capabilities change when servers are enabled or disabled. Scope is fixed when
the session is created. Keeping them separate keeps each owned by the code that
knows the answer.

### 3. The dynamic half is derived, never written

A briefing that lists operation names rots on the next `defineOperation`. The
authored half — a markdown file, per decision 1 — states the shape of the door:
that the agent acts through `invoke`, and that `operations.list` and
`operations.describe` answer what is available. The specific half is derived at
assembly time from the registry actually resolved for this session, so a
briefing states the caller's real scope without anyone maintaining a list.

The split follows what changes and when. Prose a human writes and reviews stays
in `.md`; facts the system already knows are read from the system, never
transcribed into the prose where they can go stale.

`operations.describe` remains the documentation of record. A briefing points at
it and must not restate it.

### 4. Briefings describe; they never grant

Authorization lives in handlers and admission stages, never in prompts. That
rule predates this ADR and this ADR makes it easier to break, because every
subsystem now has a prose channel into the model.

A briefing that says the agent may do something the gate refuses is worse than
saying nothing: it produces confident wrong behaviour instead of a question.
Briefings describe how to find out what is permitted. Typed rejections teach the
boundary, as ADR 0006 already requires them to.

### 5. Assembly is ordered and budgeted

One assembler composes the contributions in a stable order — scope first, then
capabilities — and enforces a total budget.

Exceeding the budget is an error, never a truncation. Silent truncation would
reintroduce the exact failure this ADR exists to remove: a model missing
context that the system believes it sent.

**Amended.** The same argument applies at the other end, so the assembler also
rejects an empty authored briefing and a repeated server name or scope facet. A
blank briefing is an unexplained capability spelled differently, and a silently
collapsed duplicate is a contribution the system believes it sent. The type
cannot rule out `''`, so the assembler does.

### 6. Contributions are pure functions

A contribution is a function of the attached capabilities and the session
scope, with no I/O. The assembled context for a session kind can then be
asserted in a unit test, which is not possible today without booting a session.

This is what makes the invariant enforceable rather than aspirational, as a
test in the same spirit as `check:operation-names`.

**Amended.** The invariant was first written as "every attached MCP server
contributes a briefing". That cannot hold, and the reason is not a detail.
There is no MCP client in this repo — no client construction, no transports, no
stored tool inventory. For an app-registry server the daemon holds a connection
config and nothing else, so at prompt-assembly time it cannot know that
server's tools. The proof is in the builder: to restrict tools for a Space
session all it can emit is a whole-server wildcard, `name__*`. If it knew tool
names it would list them.

Nor would a briefing add anything. `strictMcpConfig: true` means the SDK
connects each attached server and gives the model every tool as
`mcp__<server>__<tool>` with the server's own description and schema. A derived
briefing would be a lossy paraphrase of verbatim data. That is decision 3
applied consistently rather than a carve-out from it: `operations.describe` is
the record of truth for our door, and **the tool definitions are the record of
truth for a third-party server**.

Two further reasons not to generate prose about them. The daemon knows a server
is configured and enabled, never that it is *available* — connection status is
post-connect — so any sentence asserting the agent "has" server X may be false
when X fails to start, which is decision 4's confident-wrong-behaviour in our
own voice. And a third-party server's description, and even its name, are
attacker-influenced strings; moving them into the system prompt promotes text
this repo treats as data into the highest-trust channel.

So the invariant is three clauses, each testable:

> **(a) Accounting.** The set of server names in `queryOptions.mcpServers` and
> the set of names in the session's capability contributions are equal in both
> directions.
>
> **(b) Origin.** A server that is *first-party* — one we construct in-process,
> namely `hyperneo-operations`, `agent-memory` and `db-query` — must have an
> `authored` contribution whose text resolves from a `.md` file and is
> non-empty. Every other attached server has a `self-describing` contribution,
> which carries no briefing text.
>
> **(c) Reservation.** No app-registry or skill-wrapped server may attach under
> a first-party name.

The three names are written out above rather than referenced by symbol, because
two similarly-named sets exist and mean nearly opposite things. Binding to the
wrong one inverts both clauses.

`packages/daemon/src/lib/mcp/built-in-servers.ts` holds the first-party set and
is the module to use. Its `BUILT_IN_MCP_SERVERS` is deliberately private; the
exported surface is `isBuiltInMcpServer(name, config)`, which also requires the
attachment to be an in-process `sdk` server with an `instance`, so a registry
row cannot satisfy it by taking the name. Reuse that predicate rather than
comparing names.

`BUILTIN_MCP_SERVERS` in `packages/daemon/src/lib/builtins.ts` is unrelated
despite the near-identical name: third-party servers such as `fetch-mcp` and
`chrome-devtools` that HyperNeo ships as convenient defaults. Those are
`self-describing` like any other third-party server, and clause (c) does not
restrain them — a bundled `fetch-mcp` may of course use its own name.

The contribution type is a discriminated union, not an optional field:

```ts
type CapabilityContribution =
  | { kind: 'authored'; server: McpServerAttachment; briefing: string }
  | { kind: 'self-describing'; server: McpServerAttachment };
```

The discriminator must be positive on both sides. If `self-describing` were a
catch-all default, a new built-in server would fall into it silently and the
invariant would stop biting — the #4772 failure mode exactly. "No briefing" has
to be a state a reviewer sees, never one reached by forgetting. Decision 1's
property survives: a capability with no contribution is still not
representable.

Clause (c) is not hypothetical. `computeEffectiveMcpServers` resolves a name
collision by renaming *ours*, so a registry row named `hyperneo-operations`
takes the name our own authored prose tells agents to call (#4801).

## Consequences

Every session kind gets the same treatment by construction, including ones that
do not exist yet, because the assembler does not enumerate session kinds.

The cost is a prose channel per subsystem, and prose grows. The budget in
decision 5 and the record-of-truth rule in decision 3 are the controls; both
need review discipline that a test cannot supply.

Characterization tests come first. Nobody can currently state what reaches the
model for a given session kind, so there is no baseline to refactor against.

## Migration

The ladder in CLAUDE.md, one PR per rung:

1. **Pin** — characterization tests recording what reaches the model today for
   each session kind (agent card, ad-hoc member, workflow worker, direct task
   worker, non-Space session), split into the attached servers (#4779) and the
   injected text (#4787). The two have different failure modes; the text is
   where #4772 went wrong.
2. **Build** — the contribution type and ordered assembler (#4780), then the
   budget (#4788), reachable but not yet wired.
3. **Wire — operations** — the authored `.md` briefing (#4781), then the
   registry-derived listing (#4789). This is the #4772 path and the first to
   prove the seam.
4. **Wire — scope** — Space identity and role (#4782), then agent standing
   instructions (#4790), which come from the agent record rather than the
   session policy and replace the `buildCustomAgentTaskMessage` injection for
   session context.
5. **Wire — remaining servers** — `agent-memory` and `db-query` (#4783), then
   the contract test (#4792). What a third-party server contributes is settled
   by decision 6 and no longer a step here; #4791 records the investigation.
6. **Delete** — the scattered injection sites, once nothing reads them (#4784).

The contract test sits at the end rather than with the seam that defines it:
the invariant cannot bite until servers actually contribute, so writing it at
rung 2 would assert something nothing yet does.

The point fix for #4772 lands before this and is expected to be superseded by
rung 3. It is a stopgap for a broken core path, not the first increment.

## Where briefings must not be used

- To grant, imply or describe permission — see decision 4.
- To duplicate `operations.describe` — see decision 3.
- To carry per-task instructions. A briefing describes standing context for the
  session; task content stays on the task.
- To work around a missing capability. If an agent needs something it cannot
  do, the answer is an operation, not a sentence.
- As a reason to move prompt text out of `.md` and into TypeScript. The seam
  owns delivery, not authoring.

## Open items

- Whether a briefing may vary by caller role beyond the derived registry
  listing, or whether role differences belong entirely in the scope
  contribution.
- Whether the budget is global or per contributor, and what the limit is. Needs
  measurement against real sessions at rung 1. Tracked as #4788.
- Whether non-Space sessions get a scope contribution at all, or whether the
  absence of scope is itself the correct signal.
- Whether `self-describing` carries a short generated line naming the server or
  no text at all. #4791's evidence favours no text, since the daemon cannot
  know the server is reachable and the name is attacker-influenced, but this is
  a judgement rather than something the code forces.

Closed by #4791's investigation: what an app-registry server contributes. See
decision 6 — the answer changed the invariant rather than carving an exemption
from it.

Resolved by #4804 while building the seam: two contributions claiming the same
server or scope facet is an error, not a last-one-wins merge. If a later rung
ever generates a contribution that an authored one should override, that rung
has to revisit this rather than rely on ordering.

## References

- ADR 0006 — the operations door these briefings describe.
- #4772 — the defect that motivated this.
- Epic #4778 — the implementation ladder.
