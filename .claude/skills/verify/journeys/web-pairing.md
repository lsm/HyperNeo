## Browser pairing waits for Allow without resubmitting

Read SKILL.md shared isolation rules. The non-GUI proof below owns an actual
`NODE_ENV=test` daemon on an ephemeral non-8399 port, fresh HOME/data/DB, a local
CLI approver and the actual bundled PairPage running in a DOM. It uses real
HTTP and authenticated WebSocket RPC, with no provider, browser GUI, real home
or credentials file. Codes/credentials stay in memory.

```bash
RUN=$(mktemp -d /private/tmp/hn-pairing-wait-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/pairing-wait.ts verify "$RUN"
```

Observe the rendered waiting message after one submit and a real `403
awaiting_approval`. Allow from a separate authenticated client. Without another
click or code entry, the same component retries and shows `This browser is
paired.`; its real responses are `[403, 200]`. The resulting browser identity can
read `device.list`, and the code fragment is absent from the URL. An unpaired
client cannot read pending codes or Allow itself. A second flow's Stop waiting
aborts retries: approving that code later does not redeem it in this browser.
Stopping a wait does not invalidate the code for other holders.

`before` mode on the pre-fix revision reproduces the original stop after 403.
The helper keeps only statuses and safe rendered text in
`evidence/observed.json`, bundles only source code, and closes the component,
DOM, sockets and daemon in finally. Keep red and green evidence. Component
contracts also cover offline/background pause, unmount cleanup, invalid/used
codes and rate-limit wording. This DOM/HTTP proof is not real-browser visual or
native iOS integration proof; label those unverified without an attended run.

For attended browser checks only, build the web bundle, then use the existing
`web-pairing.sh` / `web-pairing-view.mjs` with the human present, never an unattended
GUI test. At 1280 and 390 check the form, invalid/expired/already-used message,
waiting status and Stop waiting. Have another paired client Allow the code and
watch automatic completion. Check the HttpOnly, SameSite Strict cookie, no raw
credential in browser JSON, no code in daemon logs and no fragment after submit.
Mask every live code in captures. Never port 8399 or the live daemon.
