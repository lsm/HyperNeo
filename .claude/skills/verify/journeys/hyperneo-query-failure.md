# A terminal query-failure episode is visible and wakes Neo

Use SKILL.md's shared isolated metadata-only setup and proof wrapper:

```sh
TMPDIR=<existing-writable-temp-dir> bash .claude/skills/verify/proof-run.sh \
  <absolute-fresh-evidence-dir> .claude/skills/verify/hyperneo-query-failure.ts
```

The listener-free helper uses a migrated disposable database, real work.status
operation, HyperNeo discovery, ErrorManager, NeoService, mailbox handler, and a
real manual-mode recipient AgentSession. It persists the governor's agreed
queryFailureEpisode terminal shape, then emits ErrorManager's session.error.
No governor retry policy is implemented or tested here; that belongs to #9093.

Observe failed status and the original error, one wake for repeated notifications
of the same episode, and the original error in Neo's stored incoming message.
After a hard-reset-shaped episode replacement, the old terminal event must not
create another wake. Baseline status says done and there is no wake.

Retain observed.json, proof.log and the wrapper exit status. Cleanup closes the
service, recipient and database; the wrapper removes the disposable home/data.
This proves operation output and durable recipient input. It does not verify
network transport, browser rendering, provider failures or model consumption.
