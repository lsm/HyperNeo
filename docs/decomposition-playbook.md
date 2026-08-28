# Change decomposition playbook (ADR 0004)

Binding for every decomposition of a feature, refactor, removal, or change
request into tasks/PRs. Read this file before cutting any slice; CLAUDE.md
points here. Reference implementation: the external-events delivery redesign
(issues #3013–#3027).

## The slice ladder

1. **Pin** — characterization tests for existing behavior that must survive. Pin only what survives; never pin what a later slice deletes (those tests die with the code).
2. **Extract** — refactor existing logic into pure functions (verbatim moves, zero behavior change); existing suites pass unmodified. Equivalence pins (new ⟺ old classifier, new source ≡ old source) turn semantic changes into reviewable test diffs.
3. **Build** — new pure functions with tests; add ONE direct superpipe pipeline per business path **where a pipeline fits** (per-stage tests) — additive dead code, nothing calls them yet. Hot per-event loops and plain helper extractions stay plain functions (ADR 0004 exclusions).
4. **Wire** — integration last: single call-site swaps. Use a flag only when behavior genuinely changes and needs a staged rollout (then flip the default and later remove the flag); behavior-preserving rewires swap directly under their characterization pins.
5. **Delete** — removal-only PRs, zero new logic.

## Bricks, not construction-site fabrication

Construction and integration rarely share a diff. Build slices make bricks;
wire slices only assemble pre-built, pre-reviewed parts. Nothing is designed
or manufactured on the construction site.

- A pipeline stage, gate helper, or primitive that is itself complex is its
  own **build** deliverable — landed additive and unwired, reviewed alone.
- **Pipes before pipelines.** A pipeline slice may COMPOSE existing pure
  functions, but it never writes or changes them: every pure function it
  needs that does not already exist — anything beyond a couple of lines
  (~10) or any complex pipe — is built in its own build slice first.
- **Shared types are their own slice.** The shared types that define a
  pipeline's interface land separately, before the pipeline.
- **The RPC is the last step.** After the pipes (pure functions), the shared
  types, and the pipeline that assembles them exist on `dev`, the RPC/handler
  registration — the interface the UI calls — is the final wiring slice.
  A large ported or characterization test suite (>~300 test lines) may be
  its own test-only slice riding after the wiring.
- A **wire** slice is assembly only: single call-site swaps connecting parts
  that already exist on `dev`. If wiring requires writing new complex logic,
  that logic belongs in a separate build slice cut first.
- A wire slice wires the **complete** business operation — production is
  never left calling half an operation (e.g. an admission-only pipeline whose
  effects stay imperative in the caller).

## Measure before cutting

Slice budgets and slice counts come from reading the code, never from the description. Before decomposing, inspect the touched files, call sites, and existing test mass — for a re-slice, measure the mined branch with the three-dot diff against a freshly resolved `origin/dev` (fetch first — Space worktrees may lack the ref; never trust GitHub's displayed diff). Work against a size limit (~300 prod lines per PR; tests ride their slice) and let the count follow: if an honest measure says an imagined slice is a multiple of the limit, it is multiple slices — the count is an output of measurement, not an input. The limit only ever splits work further; it never justifies bundling heterogeneous deliverables into one slice — slices are cut by purpose, never by size-fitting. Estimating from a description alone is the known root cause of PR expansion.

## Standing rules for every slice

- One issue, one purpose, one task, one PR. A slice is ONE deliverable — one pipeline, one module, one entry family, one wiring seam, one deletion set. If a slice's title needs a plus sign or a comma between heterogeneous things, it is multiple slices. A non-epic issue maps to exactly one Space task and one PR. When work outgrows that mapping, promote it to an epic (GitHub parent issue) and decompose into child issues — each child is 1:1:1 again. Never attach multiple tasks to a plain issue, and never multiple PRs to one task.
- Every PR targets `dev` directly — no stacked branches, no stacked PRs. Serial slices are ordered by the task dependency chain: each slice branches from updated `dev` after its dependency merges (rebase if `dev` advances mid-work). Never build on a sibling's unmerged branch — squash-merged stacks also corrupt size measurement (the diff double-counts the merged sibling).
- Construction, wiring, and deletion do not share a PR. Exception: a trivial build+wire combination is acceptable when the call-site swap is a few lines and the combined diff stays within the slice budget — when in doubt, split. Deletion never combines with anything.
- No polling while waiting: after opening a PR, subscribe to its events (PR-event subscriptions are part of the workflow contract) and act on deliveries — never poll PR state, CI checks, review comments, or mergeability on a timer or watch loop. One point-in-time verification read at an actual decision moment is allowed. When the next step is "wait for X", end the turn and go idle. This explicitly includes POST-MERGE: the post-approval job ends at merge + sync + audit + task completion — dev-branch CI results are NOT yours to watch; red dev arrives as an event to its owner.
- Time is a budget alongside size: a slice should reach its human checkpoint within ~90 minutes of starting (implementation + bot gate + CI). If its PR sits ~2 hours without merging, blocking, or reaching a checkpoint, the slice is stalled — report status and either re-plan or block; never leave a PR sitting idle. Waiting at the human checkpoint does not count against the slice.
- Every slice carries a **merge contract** in its task/issue description: one line naming what the PR may and may not touch (e.g. "additive dead code, no call-site changes"), plus separate prod and test line budgets (the ~300-per-PR limit is prod lines; tests ride their slice under their own cap). If the diff exceeds the budget or starts mixing phases, stop and report the overrun — in Space-managed work set the task to `blocked`; otherwise flag it in the PR — budgets are contracts, not suggestions.
- Reuse existing pipelines/gates where they fit; do not rebuild routing or decision logic a sibling already owns.
- A review finding whose fix requires new logic beyond the slice contract — a new adapter inside a wire slice, a fidelity shim grown inside a test slice, any new machinery — stops and reports for an owner ruling instead of growing the slice in place; the fix becomes its own slice or an explicit contract amendment.
