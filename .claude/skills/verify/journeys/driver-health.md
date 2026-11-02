# Local worker client health

Use SKILL.md's metadata-only wrapper and a fresh evidence directory:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/driver-health.ts
```

The helper owns its daemon, synthetic home, Codex database, application-version
plists and version-only CLI shims. Copilot discovery uses the repository's ACP
fixture; its recorded methods must contain only initialize and session/list.
No account, provider, credential or real worker is used. A synthetic Neo uses
manual mode: real mailbox admission persists notices into its context without
starting a model. Observe those notices through public work.read RPC.

The explicitly enqueued startup health job checks all five local drivers. Then
work.health and work.adapters must expose a missing synthetic Codex database as
unavailable with a concrete reason. Repeated checks and a daemon restart must
leave exactly one unavailable notice in Neo's context. Restoring the database
must produce one recovery notice. Recording the fixture's passed discovery
journey establishes its verified version; a newer fixture version remains ok,
becomes unverified, and produces only one new warning. External database hashes
must remain unchanged. Daily scheduling and a lost notice acknowledgement are
also covered by the focused monitor tests.

For the Settings check, build the web app under the resource guard first. Run
the helper with `--browser /absolute/fresh/control-directory`, read that
directory's browser.json while it is running, open its loopback URL, then Settings > Neo
and inspect Worker client health. It must show client versions, concrete health
reasons, and Codex's Unverified version warning. Save a screenshot and create
browser.json's doneFile after observing the actual page. The helper then exits;
the wrapper preserves evidence and deletes all temporary daemon data.

Retain observed.json, receipts.json, proof.log and cleanup.json. Synthetic client
versions prove the health contract, not native-client compatibility. Only after
an actual installed driver's own verify journey passes may its installed versions
be recorded as verified on the deployed daemon.
