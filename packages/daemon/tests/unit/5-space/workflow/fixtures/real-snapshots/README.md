# Real persisted-workflow snapshots

Anonymized snapshots of **actual rows** from the production `daemon.db`, used by
`workflow-migration-real-snapshot-replay.test.ts` to prove the load-time
migration is idempotent and never disturbs a deployed `pr_ready` gate.

## Why real snapshots (not synthetic)

The #2303 task's stated risk: *"a bad migration silently breaks deployed
spaces."* A hand-synthesized workflow does not cover the messy shapes that
actually live in production — leftover unreferenced legacy gates, a legacy gate
still wired onto a channel, and `built_in:pr_ready` validators that must ride
through untouched. These fixtures are one representative row per built-in
template that carries hooks/gates in prod.

## What the migration actually does to them: nothing (the no-op)

Investigation against epic #2299 ADR #2 (`built_in` is **kept** as the
named-preset form — there is no newer persisted form) and the live prod DB
showed the #2303 "old `built_in: pr_ready|pr_merged` → new preset form"
migration is a **no-op**:

- The only `built_in` id present in any real workflow is `pr_ready`, and it
  already resolves via the registry #2302 introduced.
- `pr_merged` was never admitted before #2302, so no persisted workflow carries
  it.
- Unregistered ids already fail-closed at dispatch (`hook-executor.ts`) and are
  rejected at admission (`workflow-hook-validation.ts`) — no shim gap to fill.

So this suite delivers the task's hard constraint — *idempotent re-stamp proven
against real snapshots* — without fabricating a transformation or compat shim
(the task's own "don't over-build the shim" + ADR #4 "not byte-for-byte
emulation").

## Sanitization

UUIDs are zeroed to `00000000-0000-4000-8000-000000000000` (the migration
resolves nodes/agents by **name**, not id, so this is semantically inert).
Bulky prompt text (`customPrompt.value`, workflow `instructions`) is trimmed to
a `<trimmed: N chars>` marker. Gate/hook **scripts are kept verbatim** — they are
what the migration reads (`isBuiltInGateShape`, hook-source equivalence) and
contain no secrets (generic `gh`/`jq` bash).

## Regenerating

The snapshots are produced by `../extract-real-snapshots.ts`, which reads the DB
read-only and writes one fixture per built-in template that carries hooks. To
refresh from your local/staging `daemon.db`:

```bash
# From the repo root. Writes into this dir (the in-repo default) so biome can
# format the output under the project config.
bun packages/daemon/tests/unit/5-space/workflow/fixtures/extract-real-snapshots.ts
bun run format   # collapse arrays to match the committed style
```

Then re-run the replay suite; any change in output is a real-behavior delta
worth understanding before it ships.
