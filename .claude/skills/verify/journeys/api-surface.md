# Stable API surface snapshot

Use SKILL.md's metadata-only resource guard and isolated proof wrapper. No model,
browser or external service is required. The helper owns an ephemeral daemon and
synthetic HOME/database, refuses external HTTP and GitHub, and closes its workers
and socket. Never inspect or restart the live daemon for this journey.

Run `bun run api:surface` in the checkout and retain its operation/event counts.
Run it again and compare api-surface.json hashes: identical source must yield
identical bytes. Run `bun run check:api-surface`; it must pass without rewriting
any file. Run `bun run test:api-surface` for added-field drift refusal, missing
operation detection, transform fingerprint changes and direct/constant/template/
bridge event extraction. CI runs these tests and the drift check through make check.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/api-surface.ts verify
```

The actual RPC operations.list must match every committed operation and every
OPERATION_NAMES entry. Compare operations.describe input/result JSON Schemas for
the discovery, task, messaging, Neo and worker-inspection examples against the committed snapshot,
and require real system.health success. The event list must be sorted, unique and
contain the documented state/Neo methods. Event names are statically extracted;
this proof does not claim to emit every server event.

Retain api-surface.json evidence, proof.log and wrapper exit status. Require exit
zero, verified/resourcesStopped and no closed-database errors; the wrapper saves
evidence before removing temporary data. Zod nodes without JSON Schema equivalents
carry explicit markers and transform fingerprints, not false validation guarantees.
No generated client or API compatibility policy belongs to this PR.

After the daemon-owned merge, run the generator/check and RPC journey from the
merged containing build, and obtain owner deployment/build evidence. A preceding
served build is pending rollout, not a successful deployment. Only after merge
and deployment write the requested persistent PR result document.
