# Tracker mirror foundation

Run the metadata-only proof wrapper with Bun 1.4.2.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/tracker-foundation.ts
```

The helper owns its HOME, DB and two successive daemons on ephemeral ports. It
registers no provider and makes no model turn. A fake gh stores an external item
marker. The first daemon writes creating through the registered gateway, creates
that item, then is killed before binding. The second daemon reads the durable
facts, finds the marker, and binds the original ref through the gateway. It must
print createCount=1 and recoveryExit=0. It also checks title-only bodies, a persisted
parent link that produces no repeat, and exclusion of closed mirror rows. Retain
observed.json, recovery.json and review-fixes.json.

This slice proves the construction APIs and storage. Automatic sweep wiring is
exercised in the following slice. The tracker is synthetic. The helper stops its
recovery daemon, and the wrapper removes its synthetic data.
