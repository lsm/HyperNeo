# Encrypted credential writes off main

Run `lane-c-credential-store-writes.ts` under the shared proof-run wrapper for
Bun, and the equivalent isolated Deno run. It requires NODE_ENV=test, a fresh
HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data under env -i. The helper asserts
the effective key directory is inside its synthetic run before booting. Never
provide a credential value through the environment. No real credentials, model,
provider network, UI, keychain or live daemon is involved.

The ephemeral non-8399 daemon first seeds synthetic voice and Exa credentials
through settings.global.update. Guard all credential-record writes on main, then
replace the voice value and remove the Exa value through the same real WebSocket
RPC. Replies must remain redacted, hasApiKey flags must reflect the commits,
the replacement must decrypt correctly from the test database, and deletion
must leave the other ciphertext intact. AES-GCM IV/tag sizes remain unchanged.
The baseline must fail with forbidden main SQL; fixed Bun/Deno runs must pass
with zero target main writes.

Evidence is evidence/credential-store-writes.json, containing only settings,
booleans and byte counts. The helper closes its resources in finally, saves
evidence, then immediately removes its synthetic home/workspace/data; the wrapper
removes the remaining temporary run after retaining evidence.

Schema creation remains startup-ownership work. Credential reads, encryption/key
lookup and filesystem behavior are unchanged. This does not prove real keychain
fallback, network effects, contention, worker death or large-body latency.
