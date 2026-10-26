# All live SDK message writers use the gateway

Follow SKILL.md's isolated environment rules. Body copy is explicitly excluded
until design Order step 4. No real database may be read, copied or trimmed.

The typed inventory rejects direct SDK repository writer references outside the
synchronous units executed by ops:

```bash
bun .claude/skills/verify/sdk-writer-inventory.ts
```

The public-entry proof needs no daemon, HTTP mock, model, GUI or port preflight:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-routing-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-message-routing.ts "$RUN"
```

It creates a fresh synthetic file DB and real worker, seeds fixtures before
making main read-only, then invokes public ensure/activate/retry, Neo intake,
mailbox failure/teardown, fenced status, backfill and generic facade writes.
Side-only bodies remain readable. A storage fault rolls teardown back and
retains the mailbox job. Missing sessions cannot acquire turn-end rows. Named
op requests and reactive changes are recorded. Only `pass: true` in
`evidence/sdk-message-routing.json` is success. Both proofs run in CI tests.
The pending-removal journey separately proves atomic withdrawal on a worker;
AgentSession and driver tests exercise the now-routed cached/uncached callers.

For the visible result, build web, launch an isolated daemon on a free non-8399
port, run doctor, register the local mock provider by RPC, then run
`sdk-save-async.ts` with VERIFY_PORT. Its live query and stored page must both
contain assistant/result rows. Open that synthetic session in the browser and
see the input and mock reply, then open /neo and send a synthetic input. Its
accepted/read state must persist. The plain-text API mock does not prove Neo's
structured public reply tools. Save screenshots and RPC/DB evidence, close the
tab and stop only the daemon/mock owned by this run.
