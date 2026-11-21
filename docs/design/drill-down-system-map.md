# Drill-down system map

Part of #10814.

## Problem

The strict route report proves every operation is named (`bun scripts/pipeline-verdict-report.ts --strict` on current dev: 271 routes, all `named`, 0 unreadable), but it is a flat JSON list. When planning a change you cannot see the system's shape: which components exist, which entry points each owns, where their code lives, or which components a pull request touches.

Goal, from the human: an easy-to-read overview of the main components, drillable from large to small to detail, that stays current as code changes.

## What exists today (verified on dev `535cf0ace2`)

- `bun scripts/pipeline-verdict-report.ts --strict` prints one row per operation: `{ file, name, verdict }`. `reportPipelineVerdicts` is an exported function already imported by tests and `pipeline-strict-compare.ts`.
- `bun scripts/system-map.ts where <name>` lists who defines, uses, calls, reads or writes an operation, RPC method, event or table.
- `bun scripts/system-map.ts impact --diff [base]` lists name-linked files outside a plan, from `git diff --name-only --merge-base <base>` filtered by `isSource`.

## Design

One new subcommand, generated on demand, no stored index, no service:

```
bun scripts/system-map.ts map [--diff <base>]
```

### Drill levels

All three levels derive from existing report rows; nothing is classified by hand.

1. **Package** — the `packages/<pkg>` segment of `file`. Today: `daemon` (237 routes), `space` (34).
2. **Component** — the first directory under `src/` (after `lib/`). Today: `neo` (79), `connections` (17), `agents` (16), `drivers` (13), `tasks` (13), `evolution` (13), `pairing` (12), `session` (11), `goals` (10+7 across daemon and space), and so on.
3. **Route** — one line per operation: name plus file path. Duplicate names keep the existing `variant` field. Each line is directly followable with `system-map where <name>` for table, event and cross-package links, which the map does not duplicate.

### PR-touch marking

`--diff <base>` marks what a pull request touches. It computes changed source files exactly as `impact --diff` does today (`git diff --name-only --merge-base <base>` filtered by `isSource`), intersects them with each component's file set from the report, and prefixes touched components and routes with `*`. No second notion of "changed files" is introduced.

### Output

Markdown to stdout. Redirect to a file, read it in a terminal or an editor. Generated fresh from the working tree on every run, so it cannot go stale and is never committed.

Trimmed real example of the shape:

```markdown
# System map — 271 routes, 271 named, 0 unreadable

## daemon — 237 routes

### *neo — 79 routes (touched)
- `*` `neo.ask.doneTodos` — packages/daemon/src/lib/neo/ask-entries.ts
- `neo.conversation.read` — packages/daemon/src/lib/neo/conversation-read-operation.ts

### connections — 17 routes
- `gmail.search` — packages/daemon/src/lib/connections/google-read-operations.ts

## space — 34 routes

### evolution — 13 routes
- `evolution.scope.owner.set` — packages/daemon/src/lib/agents/assign-agent-operation.ts
```

(`evolution.scope.owner.set` really does live under `daemon/src/lib/agents/`; the map reports where code is, not where the name suggests it should be.)

### Implementation sketch

In `scripts/system-map.ts`: a `map` case in `main` that calls the exported `reportPipelineVerdicts` with `readRepositorySources` (the same wiring `pipeline-verdict-report.ts` uses as a script), groups rows by the two path segments, sorts by descending route count then name, and prints the Markdown above. Estimated under 80 lines including the diff marking, which reuses the existing `git` helper.

## Test plan

Unit test in `scripts/system-map.test.ts` style, on fixture sources (as `pipeline-verdict-report.test.ts` already does): grouping counts per package and component, `--diff` marking only components whose files the diff touches, stable output ordering, and the summary line matching the row count. `bun run check` passes.

## Non-goals

- No web service, daemon endpoint or committed artifact. The command prints; consumers redirect.
- No new link analysis. Tables, events and RPC links stay behind `where`, one command away from every route line.
- No coverage of surfaces without operations (static web pages, docs). The map covers what the route report covers.

## Open questions

1. **Viewing surface.** Generated Markdown (this design) is the smallest step; a page in `packages/web` rendering the same JSON would give clickable drill-down and PR-diff highlighting in the browser, at the cost of a route and a component in the web app. Markdown first, web page only if the terminal view proves too cramped.
2. **Line numbers.** The report carries file paths only. The analyzer already computes definition offsets, so adding a `line` field is a small extension that would make every route line editor-clickable. Worth it?
3. **Grouping key.** Components come from file paths. Operation-name prefixes (`neo.*`, `goal.*`, `work.*`) are an alternative read of the same list and mostly agree, but paths cover every route and double as the code location. Prefixes could become a secondary index later; not in v1.
4. **Ratchet behavior.** Should `map --diff` exit non-zero when a touched route's verdict is not `named`? On current dev that state is impossible and the strict report already gates it, so v1 stays informational.
