# Mailbox TTL expiry through database workers

Run `lane-b-mailbox-expiry-writer.ts` with Bun and Deno in a fresh synthetic run
under env -i, NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data.
The helper owns an ephemeral non-8399 daemon. It temporarily observes only its
own processor creation/registration and restores both observers, then stops and
awaits all those processors before seeding. No delivery can start a model turn.
No provider, credentials, HTTP mock, UI or live daemon is involved.

Seed one processing and one pending expired mailbox input, a fresh input, a
foreign-lane input, corrupt data and a completed input. Advance only the owned
pending sweep's due time. Tick the daemon's actual registered expiry processor,
retaining its normal failure materialization/publication callback. Deny all SQL
from the expiry loop, handler and new commands on the main connection.

The actual sweep must complete with expired=2 and exactly one future successor.
The two public message.status RPC results must be failed; the fresh input stays
queued. Foreign, corrupt and completed rows must be retained, retries unchanged,
and the old expired processing lease fenced. Health RPCs bracket the path. The
baseline must fail on forbidden main SQL; Bun/Deno fixed runs must record zero.

Focused tests cover strict TTL, cursor paging, callback receipt/rollback ordering,
candidate revalidation and successor persistence when scanning fails. Save
evidence/mailbox-expiry-writer.json before deleting owned temporary data.
Startup's legacy seed helper, UI, provider turns, real worker death, contention
and large-payload latency are outside this proof.
