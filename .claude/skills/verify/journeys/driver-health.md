# Local worker client health

Use SKILL.md's metadata-only wrapper and a fresh evidence directory:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/driver-health.ts
```

Repeat with `--bundled-codex` after the helper path to exercise a ChatGPT-only
installation with no standalone Codex app. Both layouts must report Codex healthy
and expose the selected desktop bundle version. Standalone precedence is also
covered by the synthetic-home probe tests. Those unit tests supply a portable
version-reader fixture on their isolated PATH so Linux CI needs no macOS tools;
the daemon journey on macOS still exercises the real installed `plutil`.

The helper owns its daemon, synthetic home, Codex database, application-version
plists and version-only CLI shims. Copilot discovery uses the repository's SDK
fixture; its recorded methods must contain only connect, status.get and session.list.
No real account, credential or human worker is used. A synthetic provider stores the dev-proxy key in the fresh database. An ephemeral
local API mock handles any synthetic Neo turns, and external registry MCP servers
are disabled before its binding is created. Real mailbox admission persists
notices into its context. Observe those notices through public work.read RPC.

The explicitly enqueued startup health job checks all five local drivers. Then
work.health and work.adapters must expose a missing synthetic Codex database as
unavailable with a concrete reason. Repeated checks and a daemon restart must
leave exactly one unavailable notice in Neo's context. Restoring the database
must produce one recovery notice. Recording the fixture's passed discovery
journey establishes its verified version; a newer fixture version remains ok,
becomes unverified, and produces only one new warning. External database hashes
must remain unchanged. Daily scheduling and a lost notice acknowledgement are
also covered by the focused monitor tests.

The review regression first records a passed Codex version while no Neo binding
exists. Creating the binding must not deliver its obsolete unverified warning.
Before that verification, direct calls through the real shared MCP invoke
handler must refuse an ordinary worker and an unbound caller claiming the Neo
role, leaving all stored health and pending warnings unchanged. Identity fields
forged in the operation input must not affect admission. Human RPC verification
and a bound Neo MCP session must both remain allowed.
A generic settings RPC then attempts to forge the health records, verified
versions and notice text; all daemon-owned values must remain unchanged while
an ordinary setting still updates. Finally, the helper holds a scheduled
non-forced read while a real forced health RPC arrives. Its reply must show
the new fixture client version, rather than the scheduled run's cached value.

For the Settings check, build the web app under the resource guard first. Run
the helper with `--browser /absolute/fresh/control-directory`, read that
directory's browser.json while it is running. Anonymous pages may read but cannot
run work.health, so pair the browser first: create a human code with
`rpc.ts device.pair.create` against that port and the run's data directory, then
POST it to `/pair` from the page. Keep the code out of evidence. Open the loopback
URL, then Settings > Sessions & Harness, and inspect Worker client health. It must show client versions, concrete health
reasons, and Codex's Unverified version warning. Save a screenshot and create
browser.json's doneFile after observing the actual page. The helper then exits;
the wrapper preserves evidence and deletes all temporary daemon data.
Add `--slow-check` to delay the actual health RPC response by twelve seconds.
Check now must stay pending beyond the default ten-second deadline, then show
the successful status with no timeout alert. Retain slow-check.json and a
screenshot of that result.

Retain observed.json, receipts.json, proof.log and cleanup.json. Synthetic client
versions prove the health contract, not native-client compatibility. Only after
an actual installed driver's own verify journey passes may its installed versions
be recorded as verified on the deployed daemon.
