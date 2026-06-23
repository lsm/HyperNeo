# Architecture Refactor PR Evidence Template

Use this template for every implementation PR in the architecture refactor Goal/Forge scope.

## PR Summary

- PR:
- Branch:
- Phase: `foundation` | `shadow` | `bridge` | `switch` | `cleanup` | `enforcement`
- Target architecture gate:
- Milestone:
- Commit after merge:

## Scope

- Objective:
- In scope:
- Out of scope:
- Compatibility surface preserved:
- Compatibility surface added:
- Compatibility surface removed:

## Release Safety

- User-visible change:
- Migration risk:
- Rollback path:
- Old path availability:
- New path default state: disabled | shadow | bridged | switched | cleanup
- Destructive changes: none | described below

## Validation

```bash
bun run check
bun run architecture:file-size-report -- --changed-from origin/dev
```

- Targeted tests:
- Manual validation:
- CI:
- Database migration validation:
- Web/UI screenshot or parity evidence:

## Compatibility Evidence

- Legacy RPC aliases preserved:
- Fabric contracts added:
- MessageHub bridge behavior:
- Event/outbox behavior:
- Client read-model behavior:
- SDK/runtime capability impact:
- Config/extension precedence impact:

## File-Size Evidence

- New source files over 300 lines:
- New source files over 500 lines:
- Touched allowlisted oversized files:
- Split follow-up created:

## Forge Record

- Evidence attached:
- Episode needed:
- Lesson promoted:
- Next proposals:

## Review Notes

- Open risks:
- Reviewer decisions needed:
- Deferred cleanup:
