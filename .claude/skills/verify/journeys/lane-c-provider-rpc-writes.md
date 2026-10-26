# Provider RPC persistence on the writer

Run `lane-c-provider-rpc-writes.ts` in a fresh synthetic run with Bun and Deno,
NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data, under env -i.
No provider turn, HTTP mock, UI, real credentials or live restart is needed.
The helper owns an ephemeral daemon port and rejects port 8399. It seeds only
disabled synthetic providers with authType=none and stops its own job processor.

Drive providers.create/update/setDefault/test/delete over the real WebSocket.
The main connection rejects all provider-record INSERT/UPDATE/DELETE statements.
The baseline records each failure; the fixed path must persist configuration,
default selection and health, delete the requested provider, and preserve the
remaining record. An explicit synthetic credential value is sent only over RPC
into the test database, never in the environment. That update must strip saved
discovery while keeping unrelated configuration. A synthetic credential-store
failure must delete the just-created provider before returning its error.

Save evidence/provider-rpc-writes.json. The helper restores its temporary
credential-store failure hook, closes transport/daemon in finally and immediately
removes synthetic data, workspace and home after saving evidence. Use the shared
proof-run wrapper to retain evidence and remove the remaining temporary run.

This slice covers provider-record SQL in these RPCs and their cache invalidation.
Credential-store SQL, startup imports, custom-endpoint synchronization, provider
network effects, contention, large bodies, worker death and latency are not proved.
