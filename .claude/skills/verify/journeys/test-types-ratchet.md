# Test type-error cleanup batches

The user surface is `check:test-types`, the per-file compiler gate in the shared
quality command. No daemon, browser or provider is needed for test-only cleanup.
Use pinned Bun from SKILL.md, install frozen dependencies, and run the affected
tests through their package's Vitest command.

After the cleanup, run `bun scripts/check-test-types.ts --write-baseline`. Inspect
the diff: only the batch's file counts may decrease. Then prove the real gate:

```bash
VERIFY_KEEP_RUN=1 bash .claude/skills/verify/with-run.sh \
  bash .claude/skills/verify/test-types-ratchet.sh
```

The helper accepts the tightened baseline, injects one temporary test type error,
requires exit 1 with that file's `REGRESSION ... 0 -> 1`, removes its fixture,
and requires the original successful output again. Evidence is retained under
`RUN/evidence/test-types-{before,rejection,after}.txt`. The helper never rewrites
the baseline. Run the full shared quality command before publishing the batch.
