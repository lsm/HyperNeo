# Change decomposition playbook (ADR 0004)

Binding for every decomposition of a feature, refactor, removal, or change
request into tasks/PRs. Reference implementation: the external-events delivery
redesign (issues #3013–#3027).

**The tenets** — the law in eight lines; the sections that follow are their
elaboration:

1. **Nothing is a budget until it is counted.**
2. **The seam decides the size, so the cut must name the seam.**
3. **Build bricks; wire only assembles.**
4. **Growth is stopped, never absorbed in place.**
5. **Deferred cost is scheduled, not removed.**
6. **Re-cut on a new axis or accept the loop.**
7. **The diff is the only witness.**
8. **One purpose, one artifact.**

## Measure before cutting

Slice budgets and slice counts come from reading the code, never from the
description. Before decomposing, inspect the touched files, call sites, and
existing test mass — for a re-slice, measure the mined branch with the three-dot
diff against a freshly resolved `origin/dev` (fetch first; never trust GitHub's
displayed diff). Work against ~300 prod lines per PR and let the count follow:
the count is an output of measurement, never an input. The limit only ever
splits work further; it never justifies bundling — slices are cut by purpose,
never by size-fitting.

A budget is a receipt, not a number. State the count each cap came from —
files, entry surfaces, decision-table rows × fixture cost, ported/harness mass
(measured shapes run ~10 prod / ~18 test per registry entry, ~105–140 harness
lines per standalone suite). A number typed from a description, an epic table,
or a parent's carve is an intention, and intentions run multiples over. Tests
are half of every diff: an uncounted test cap is an unmade budget. Extracts
state net lines (adds − deletes), with gross moves capped separately.

Mine, don't re-derive. When a cancelled task or closed PR holds reviewed
material, cut adopt-don't-redo slices against its frozen head with equivalence
targets — transcription cannot discover machinery; design can.

## The task contract

One issue, one purpose, one task, one PR; promote to an epic and decompose
into children when work outgrows that mapping. A task is not cut until its
contract is complete — an empty field means not ready to dispatch, and no PR
is opened without a task (ad-hoc sessions included):

- **Budgets with receipts** — separate prod and test caps, each from a count
  *(tenet 1)*.
- **File allowlist** — the files the PR may touch, and the adjacent file it
  must NOT touch; crossing it is a re-slice signal, not an edit *(tenet 2)*.
- **Rung and named bricks** — the ladder kind, and every part on `dev` the
  slice composes *(tenets 2–3)*.
- **Pre-declared split trigger** — "split-report if the honest measure
  exceeds X," written before work starts.
- **One deliverable** — a title with an "and" is two slices; an unpriced "or"
  in the task text is an overrun waiting for its branch — the expensive
  alternative always wins *(tenet 8)*.

## The slice ladder

1. **Pin** — characterization tests for existing behavior that must survive.
   Pins are 0-prod by construction. Pin only what survives; never pin what a
   later slice deletes.
2. **Extract** — verbatim moves into pure functions, zero behavior change;
   existing suites pass unmodified. Equivalence pins (new ⟺ old) turn
   semantic changes into reviewable test diffs.
3. **Build** — new pure functions with tests; add ONE direct superpipe
   pipeline per business path where a pipeline fits — additive dead code in
   new files, nothing calls them yet. Hot per-event loops and plain helper
   extractions stay plain functions (ADR 0004 exclusions).
4. **Wire** — integration last: single call-site swaps at the named seam,
   under the pins. A flag only when behavior genuinely changes and needs a
   staged rollout (then flip the default and later remove the flag).
5. **Delete** — removal-only PRs, zero new logic.

## Bricks, not construction-site fabrication

Construction and integration rarely share a diff. Build slices make bricks;
wire slices only assemble pre-built, pre-reviewed parts. Nothing is designed
or manufactured on the construction site.

- A pipeline stage, gate helper, or primitive that is itself complex is its
  own build deliverable — landed additive and unwired, reviewed alone.
- **Pipes before pipelines.** A pipeline slice may COMPOSE existing pure
  functions, but it never writes or changes them: every pure function it
  needs that does not already exist — anything beyond ~10 lines or any
  complex pipe — is built in its own build slice first.
- **Shared types are their own slice.** The shared types that define a
  pipeline's interface land separately, before the pipeline.
- **The RPC is the last step.** After the pipes (pure functions), the shared
  types, and the pipeline that assembles them exist on `dev`, the RPC/handler
  registration — the interface the UI calls — is the final wiring slice.
  A large ported or characterization test suite (>~300 test lines) may be
  its own test-only slice riding after the wiring.
- A **wire** slice is assembly only: single call-site swaps connecting parts
  that already exist on `dev`. If wiring requires writing new complex logic,
  that logic belongs in a separate build slice cut first — a wire slice
  needing a part that isn't on dev is a missing build slice, not an
  improvisation.
- A wire slice wires the **complete** business operation — production is
  never left calling half an operation (e.g. an admission-only pipeline whose
  effects stay imperative in the caller).

## Stop rules and rulings

**A budget breach blocks — at any commit, first or fiftieth.** The gate
measures the cumulative diff against the caps and the file-set against the
allowlist at PR open and every push. Budgets are contracts, not suggestions:
disclosure-and-continue is a violation, not a state, and numbers in a PR body
are not measurements — they go stale; the diff is the only witness.

**Review growth trips a breaker.** Stop and report when a review finding's
fix requires new machinery (new file, module, or pipeline), a third
non-convergent review cycle arrives (owner re-invokes count), or cumulative
growth passes 30% of budget. Never grow in place — the finding becomes its
own slice or an explicit contract amendment.

Stop-and-report arrives with a fixed menu, and only the owner rules — no
agent absorbs its own breach:

- **Bounded absorb** — mispriced-but-fixed cuts ≤~100 lines over cap with a
  measured first commit (owner discretion).
- **Spin to follow-up slice** — the default for machinery-adding findings
  and open-ended review growth.
- **Re-cut** or **kill** — for structural non-convergence.

Test overruns use the same menu: the gate blocks, and the owner may absorb
coverage in one ruling when trimming would lose more than it saves.

**Deferrals create priced successors.** Deferring scope creates, at
deferral time, the named successor task with a measured budget — "cannot be
closed here" without a successor is the same overrun arriving later, with
interest.

## Re-cuts obey the axis law

A re-cut is a fresh measurement plus a **new boundary axis** — deliverable
kind, owner type, or hardening concern. Never re-cut the same monolith along
the same phase/hunk axis: when hardening is intrinsic to the seam, every
phase-cut re-grows it. Inheriting the parent's budget without re-measuring
re-runs the parent's overrun. A second re-cut on the same axis stops the
line: epic re-decomposition, or the honest answer — no slice here.

## Standing rules

- Every PR targets `dev` directly — no stacked branches, no stacked PRs.
  Serial slices are ordered by the dependency chain; rebase if `dev`
  advances mid-work. Never build on a sibling's unmerged branch — squash-
  merged stacks also corrupt size measurement.
- Construction, wiring, and deletion do not share a PR. Exception: a trivial
  build+wire when the call-site swap is a few lines and the diff stays
  within budget — when in doubt, split. Deletion never combines.
- Reuse existing pipelines/gates where they fit; do not rebuild routing or
  decision logic a sibling already owns.
- No polling while waiting: subscribe to PR events and act on deliveries;
  one point-in-time verification read at an actual decision moment is
  allowed; when the next step is "wait for X", end the turn and go idle.
  Post-approval ends at merge + sync + audit + completion — dev-branch CI
  is not yours to watch.
- Time is a budget: ~90 minutes to the human checkpoint; a PR idle ~2 hours
  is stalled — report and either re-plan or block.
- Ops failures (daemon-restart run loss, never-spawned dispatch) are not
  decomposition events — never read zombie churn as re-cut data.

## Where this lives

CLAUDE.md carries the tenets as the always-loaded summary; this file is the
manual; the gate — cumulative diff vs caps and file-set vs allowlist,
checked at PR open and every push — is the enforcement that makes both
credible.
