# Source File Size Ratchet

The architecture refactor should reduce hidden ownership. File size is not the architecture, but it is a useful warning signal when a PR is turning a boundary into another catch-all module.

## Policy

- Target new and actively refactored source files at 300 lines or less, including comments.
- Do not add a new production source file over 500 lines.
- Do not grow an allowlisted production source file beyond its baseline line count.
- When touching an allowlisted file, either keep the line count flat/shrinking or name the split follow-up in PR evidence.
- Broad enforcement starts advisory. Mandatory checks should land only after migrated surfaces have stable subpaths and adapters.

## Scope

Initial ratchet scope is production source under `packages/*/src`.

It excludes tests, `__tests__`, specs, generated declaration files, package demos, scripts, and e2e files. Those files still need cleanup eventually, but blocking architecture PRs on test/demo debt would make the refactor less releasable.

## Commands

Full current report:

```bash
bun run architecture:file-size-report
```

Changed-file report for PR evidence:

```bash
bun run architecture:file-size-report -- --changed-from origin/dev
```

Machine-readable report:

```bash
bun run architecture:file-size-report -- --json
```

The baseline lives in [file-size-ratchet.json](file-size-ratchet.json). The allowlist is not approval to grow those files; it is a maximum current-state baseline with a named split follow-up.

## Current Baseline

- Production source files scanned: 695.
- Files over the 300-line target: 249.
- Files over the temporary 500-line hard ceiling: 134.
- Largest clusters:
  - storage schema and repositories: M3 UoW/outbox split;
  - Space runtime, task agent, workflow tools, and managers: M9 runtime decomposition;
  - RPC handlers and live query handlers: M2/M4 fabric bridge and first vertical slice;
  - web Space UI, stores, and visual editor: M8 read models and UI design-system track;
  - shared type barrels and MessageHub types: M1 shared boundaries;
  - agent/provider/session execution code: M7 Agent Runtime boundary;
  - `packages/ui` headless primitives: parallel UI design-system track.
