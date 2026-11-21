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
2. **Component** — the first directory under `src/` (after `lib/`). Files directly under `src/` belong to the package-root component, whose key is `package/` with an *empty* area (displayed as `space/`, heading `package root`); today that holds `space.get` and `space.list` in `packages/space/src/space-read-operations.ts`. A directory literally named `(root)` would be an ordinary area, not this bucket. Today: `neo` (79), `connections` (17), `agents` (16), `drivers` (13), `tasks` (13), `evolution` (13), `pairing` (12), `session` (11), `goals` (7 in daemon, 10 in space), and so on — 34 components in total.
3. **Route** — one line per operation: name plus a link to the source file. Duplicate names keep the existing `variant` field. Each line is directly followable with `system-map where <name>` for table, event and cross-package links, which the map does not duplicate.

The same package + component rule is a pure function of a file path; both drill levels and PR-touch marking below call it.

### PR-touch marking

`--diff <base>` (bare `--diff` defaults to `origin/dev`, matching `impact --diff`) marks what a pull request touches, at two granularities:

- **Component marks** come from applying the same path grouping to *every* changed source file — the changed paths `impact --diff` reads, filtered by `isSource`. A PR that only changes `packages/daemon/src/lib/neo/project-save.ts` (a pipeline file with no route row; the `neo.project.save` row lives in `lib/neo/operations.ts`) still marks the `neo` component. Deleted files mark their component the same way. Every file that passes `isSource` has a package and a component by construction, possibly the package root; non-source changes (scripts, docs) mark nothing, because the map is a route map.

**Reading paths from Git.** Both path-reading calls — `ls-files` in `readRepositorySources` and `diff --name-only` for marking — run as `git -c core.quotePath=false … -z` and split the output on NUL bytes. Default Git quoting would wrap a path like `packages/space/src/café/route.ts` in C-style quotes, making it fail `isSource` and silently drop its component; with `core.quotePath=false` and NUL delimiting, names with spaces, quotes, backslashes or non-ASCII bytes arrive exactly. A path containing an actual newline still fails `isSource` (its `.` does not cross a newline) and is excluded — that is the only loss, and it is the same for every reader.
- **Route marks** stay exact-file: a route line shows `(touched)` only when its own file changed.

No second notion of "changed files" is introduced.

**Components with zero routes.** With `--diff`, the component set is the union of route-bearing components and components of changed source files. A touched component with no route rows — `web/components` from a change to `packages/web/src/components/CommandAutocomplete.tsx`, or a component whose last route this PR deletes (the changed file still yields the key) — appears in the index as `— 0 routes (touched)` and as a section heading with no route lines. Without `--diff`, only route-bearing components appear. Zero-route components never appear without a touch mark, so they cannot accumulate stale clutter.

### Output

Markdown to stdout. Redirect to a file, read it in a terminal or an editor. Generated fresh from the working tree on every run, so it cannot go stale and is never committed.

A compact component index comes first — one line per component with its route count, a `(touched)` marker when marked, and an anchor link into the list below — so the overview is one screen; the full route lists follow.

Anchors are explicit and package-qualified, because GitHub derives heading anchors from the full heading text (counts and touch markers would destabilize them). Every section starts with `<a id="..."></a>`, where the id is a fixed encoding of the component key `package/area` — nothing is allocated, so an id can never depend on which other components exist: keep `[a-z0-9]` bytes of the key as-is and encode every other byte of the original UTF-8 path — uppercase letters included — as `_` plus two hex digits (`_` itself is always an escape introducer, so the encoding is injective and case-sensitive paths stay distinct). `daemon/agents` becomes `daemon_2fagents`, `space/Root` becomes `space_2f_52oot` (not `space_2froot`), and a real `space/root` (`space_2froot`) or `space/root-2` (`space_2froot_2d2`) can never collide with it or move it. The package root's empty area encodes to just the separator escape — `space/` becomes `space_2f` — an id no real area can produce, since every real area contributes at least one byte after the `/`; so a directory literally named `(root)` (`space_2f_28root_29`) gets its own section and cannot alias the root bucket. Index links target those ids; an id changes only when a component is renamed or moves. The ids are opaque; readers click the index, they do not type fragments.

**Label escaping.** Component names are file-system text, not Markdown. Every ASCII punctuation character in a component name is backslash-escaped wherever the name is displayed — index labels, headings, route lines — so a component like `a]b`, `a[b` or `x](#imaginary)` cannot end its link early, redirect it, or inject emphasis; GitHub honors backslash escapes for ASCII punctuation. Link *targets* need no escaping: the encoded ids contain only `[a-z0-9_]`. Route names (`neo.ask.doneTodos` and peers) pass through the same escaping; their punctuation is dots, which are safe, but the rule is uniform.

Trimmed real example of the shape:

```markdown
# System map — 271 routes, 271 named, 0 unreadable

- [daemon/agents](#daemon_2fagents) — 16 routes (touched)
- [daemon/connections](#daemon_2fconnections) — 17 routes
- [daemon/neo](#daemon_2fneo) — 79 routes (touched)
- [web/components](#web_2fcomponents) — 0 routes (touched)
- [space/](#space_2f) — 2 routes (package root)
- [space/evolution](#space_2fevolution) — 13 routes

## daemon — 237 routes

<a id="daemon_2fagents"></a>
### agents — 16 routes (touched)
- `evolution.scope.owner.set` — [assign-agent-operation.ts](packages/daemon/src/lib/agents/assign-agent-operation.ts)

<a id="daemon_2fconnections"></a>
### connections — 17 routes
- `gmail.search` — [google-read-operations.ts](packages/daemon/src/lib/connections/google-read-operations.ts)

<a id="daemon_2fneo"></a>
### neo — 79 routes (touched)
- `neo.ask.doneTodos` (touched) — [ask-entries.ts](packages/daemon/src/lib/neo/ask-entries.ts)
- `neo.project.save` — [operations.ts](packages/daemon/src/lib/neo/operations.ts)

## web — 0 routes

<a id="web_2fcomponents"></a>
### components — 0 routes (touched)

## space — 34 routes

<a id="space_2f"></a>
### package root — 2 routes
- `space.list` — [space-read-operations.ts](packages/space/src/space-read-operations.ts)

<a id="space_2fevolution"></a>
### evolution — 13 routes
- `evolution.episode.create` — [episode-operations.ts](packages/space/src/evolution/episode-operations.ts)
```

Every index link in the sample above was rendered through GitHub's Markdown API and resolves to exactly one emitted anchor (the renderer prefixes raw ids with `user-content-` uniformly; comparing after that strip, all six links match and no id repeats).

(`evolution.scope.owner.set` really does live under `daemon/src/lib/agents/`; the map reports where code is, not where the name suggests it should be.)

### Strict and diff semantics

`map` reuses the report script's exact wiring: `readRepositorySources(cwd, true)` (tracked plus untracked sources) with `countPipelineRoutes(input, true, sources)`. Analysis failures throw and the command exits non-zero, same as `bun scripts/pipeline-verdict-report.ts --strict`. `--strict` selects the resolution mode and emits verdicts; it does not itself enforce the ratchet — regressions stay gated by `scripts/pipeline-strict-compare.ts <base-dir> <head-dir>`, which this design does not change. `--diff` only selects marking; it never changes route resolution.

### Implementation sketch

In `scripts/system-map.ts`: a `map` case in `main` that calls the exported `reportPipelineVerdicts` with `readRepositorySources` (the same wiring `pipeline-verdict-report.ts` uses as a script), groups rows by the two path segments, sorts by descending route count then name, prints the component index (explicit package-qualified anchors, zero-route touched components included with `--diff`) and then the route lists, and — with `--diff` — marks components from the grouped diff files and routes by exact file match. Estimated around 100 lines, reusing the existing `git` helper and `isSource` filter.

## Test plan

Unit test in `scripts/system-map.test.ts` style, on fixture sources (as `pipeline-verdict-report.test.ts` already does): grouping counts per package and component, package-root placement for src-level files, the component index matching the lists below it, `--diff` marking a component whose changed file has no route row (helper-only change), a touched component with zero routes appearing as `0 routes (touched)` with an empty section and never appearing without `--diff`, anchor ids being a pure injective function of the component key and staying identical when counts, touch markers or the set of other components change (fixture: the package root `space/`, plus `space/root`, `space/root-2`, `space/Root` and a directory literally named `space/(root)` encode to five distinct ids — empty area → `space_2f`, uppercase escaped — and adding `space/root-3` changes none of them), index labels for `a]b`, `a[b` and `x](#imaginary)` rendering with their links intact to their own targets (verified through GitHub's Markdown API), changed paths containing non-ASCII bytes, spaces and quotes surviving the NUL-delimited git read and marking their components while a newline-containing path is excluded, and every index link resolving to exactly one emitted anchor, exact-file route marks, stable output ordering, and the summary line matching the row count. `bun run check` passes.

## Non-goals

- No web service, daemon endpoint or committed artifact. The command prints; consumers redirect.
- No new link analysis. Tables, events and RPC links stay behind `where`, one command away from every route line.
- No coverage of surfaces without operations (static web pages, docs). The map covers what the route report covers.

## Open questions

1. **Viewing surface.** Generated Markdown (this design) is the smallest step; a page in `packages/web` rendering the same JSON would give clickable drill-down and PR-diff highlighting in the browser, at the cost of a route and a component in the web app. Markdown first, web page only if the terminal view proves too cramped.
2. **Line numbers.** The report carries file paths only. The analyzer already computes definition offsets, so adding a `line` field is a small extension that would make every route line editor-clickable. Worth it?
3. **Grouping key.** Components come from file paths. Operation-name prefixes (`neo.*`, `goal.*`, `work.*`) are an alternative read of the same list and mostly agree, but paths cover every route and double as the code location. Prefixes could become a secondary index later; not in v1.
