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

The helper first saturates ErrorManager's recoverable SYSTEM/UNKNOWN throttle
bucket, then reports the terminal episode with MessageDeliveryTerminalTurnError,
the base class used by the governor's QueryFailureCapError. Terminal identity must
survive structured error creation so throttling cannot suppress the Neo wake.
The original consumer-only baseline also fails this saturated-throttle schedule.

Observe failed status and the original error, one wake for repeated notifications
of the same episode, and the original error in Neo's stored incoming message.
After a hard-reset-shaped episode replacement, the old terminal event must not
create another wake. Baseline status says done and there is no wake.

Retain observed.json, proof.log and the wrapper exit status. Cleanup closes the
service, recipient and database; the wrapper removes the disposable home/data.
This proves operation output and durable recipient input. It does not verify
network transport, browser rendering, provider failures or model consumption.

## Real governor-to-Neo integration

After the #9093 producer has landed, run the shared governor helper's consumer
mode through the same isolated wrapper:

```sh
bash .claude/skills/verify/proof-run.sh <absolute-fresh-evidence-dir> \
  .claude/skills/verify/query-failure-governor.ts consumer
```

This starts a real daemon on an ephemeral non-8399 port and throws a fake error
from SDK query start through the real message.send RPC. It first saturates that
worker's actual ErrorManager throttle bucket. The real governor must start only
three failed queries with its existing backoff, persist failed and the original
error together, and emit matching terminal evidence. The public work.status RPC
must report failed with that error, and the real mailbox processor must store
exactly one Neo input containing it. The scripted SDK distinguishes the worker
from Neo by their separate fixture workspaces and confirms one recipient start.
Explicit recovery through session.resetQuery must not add another failure wake.
External model behavior and browser rendering remain unverified. Preserve query-failure-governor.json,
proof.log and the wrapper exit status, including daemon cleanup.
