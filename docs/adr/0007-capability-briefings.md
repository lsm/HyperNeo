# ADR 0007: Capability Briefings

## Status

Proposed — 2026-09-18. Tracks epic #4778. Grows out of #4772, where a Space
agent holding the operations tool did not know it was in a Space, could name
`hyperneo-operations` when asked and still concluded it had no task-management
capability, and refused a direct instruction to call `task.create` for lack of
documentation. Nothing was broken in the sense of throwing: the capability was
attached correctly, and the sentences explaining it were assembled somewhere
else entirely.

## Context

A session's runtime context is assembled from two independent places.

Capabilities are attached by `QueryOptionsBuilder.build()`
(`packages/daemon/src/lib/agent/query-options-builder.ts`), which decides the
MCP servers a session gets: the operations server on every session, plus
`agent-memory` and `db-query` for Space sessions via
`SpaceRuntimeService.attachSpaceToolsToMemberSession`, plus the app registry
and its enablement overrides.

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

This is not a missing prompt. It is a structural property: **attaching a
capability and explaining a capability are separate code paths with separate
owners, and nothing fails when they disagree.** Any fix that adds the missing
sentences to one more call site preserves the property and buys one bug.

The same shape will recur as the door grows. There are 112 operations across
fourteen families, and a session's registry is resolved per role by
`resolveSpaceMcpSessionPolicy`. Each new family that assumes the agent has been
told something adds another way for the two halves to drift.

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

### 6. Contributions are pure functions

A contribution is a function of the attached capabilities and the session
scope, with no I/O. The assembled context for a session kind can then be
asserted in a unit test, which is not possible today without booting a session.

This is what makes the invariant enforceable rather than aspirational:

> every attached MCP server contributes a briefing

as a test, in the same spirit as `check:operation-names`. #4772 becomes a CI
failure rather than something exploratory QA finds.

The invariant needs qualifying for one category. The built-in servers are ours
and can carry authored briefings. App-registry servers are whatever the user
configured, and nobody on this side can write prose for an arbitrary
third-party server — it already describes itself through its own tool
descriptions. Whether those servers are exempt, get a briefing derived from
their advertised tools, or contribute only a generated line naming the server
is open, tracked as #4791, and this decision will be restated once it is
settled. It must be settled before the contract test is written, since it
determines what the test can assert.

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
5. **Wire — remaining servers** — settle what a third-party server contributes
   (#4791), then `agent-memory` and `db-query` (#4783), then the contract test
   (#4792).
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
- What an app-registry server contributes, given that nobody here can author
  prose for a third-party server. Tracked as #4791; blocks the contract test.
- Whether non-Space sessions get a scope contribution at all, or whether the
  absence of scope is itself the correct signal.

## References

- ADR 0006 — the operations door these briefings describe.
- #4772 — the defect that motivated this.
- Epic #4778 — the implementation ladder.
