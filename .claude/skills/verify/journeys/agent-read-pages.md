# Read card links with an agent credential

Use the shared resource guard and isolated proof wrapper in SKILL.md.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/agent-read-pages.ts
```

The helper first runs the existing four-entrypoint card Markdown journey. Every
server must accept the agent credential on GET /ask/synthetic.md and refuse it
on ten other route/method combinations before public handlers, preflight, assets
or WebSocket upgrade. The embedded build-time asset fixture is synthetic. All
servers and the real development Vite server stop before the next phase.

The second phase reopens that synthetic database on an isolated daemon. Check
that agent-read.credential is owner-only and contains its credential and bound
daemon origin together. Its token differs from local-rpc.credential.
The real `hyperneo read <link>` command must print the card without a session
identity. An anonymous request must receive 401 with the command hint. An actual
agent WebSocket attempt must fail, while a human WebSocket can still read the card.
Start a second synthetic HTTP server on another origin. The local CLI must reject
its card-shaped URL with an origin error and zero requests to that server.

Generate a remote agent code through the existing CLI. Redeeming it must return
403 until the human approves through RPC. The resulting agent credential reads
the card and is refused on /ws. Save the pairing response's origin and credential
as an owner-only JSON file in a separate synthetic remote client data directory.
Its real CLI read must succeed for the issuer, reject the second origin and leave
the collector request count at zero. Revoke both remote and local agent devices through
human RPC. Both reads must become 401, and the CLI must fail. Restart the daemon
against the same synthetic data. Startup must reuse the existing agent file and
keep its revocation effective while atomically binding its metadata to the new
listener origin. The human credential must still work.

Inspect observed.json for the four-server results, agent-read.json for the CLI,
pairing, revocation and restart results, agent-cleanup.json and proof.log. No raw
credential or pairing code is saved in those receipts. The wrapper saves the
evidence and immediately deletes every proof's temporary HOME and data.

The pre-change isolated baseline returns 401 without a `hyperneo read` hint.
The committed security contracts also fail before the implementation because
agent devices, their separate file and the CLI command do not exist, and operation
admission cannot handle that kind. Run the pairing, Markdown and CLI test modules
with their package Vitest configurations, then the full repository check.

For a remote agent, the human uses the existing pairing flow with kind agent,
approves the pending code on an already paired human device, and redeems it with
POST /pair from the remote client. Keep the returned credential in that client's
owner-only agent-read.credential JSON file with both `credential` and `origin`
in its configured data directory. The CLI validates the link origin against that
same file before any request, then reads the card and refuses redirects. It never falls back
to local-rpc.credential. No credential belongs in a link.

For concurrent-startup credential ownership, run the same wrapper with
`agent-credential-ownership.ts`. It starts two real daemon processes with separate
synthetic databases and a shared data directory. The second startup must preserve
the first daemon's origin binding. The first CLI read must still print the card,
and the second daemon must reject the first credential with 401. Inspect
ownership.json and both cleanup receipts. The focused credential-creation tests
also pause a temporary-file rewrite to prove a fresh published file stays readable,
and verify that a dead descriptor owner permits a later origin rebind.

For simultaneous startup, run `agent-credential-startup-race.ts` with the same
wrapper. It pauses the first real descriptor publication immediately before its
rename, starts a second daemon on a separate synthetic database and then releases
the first writer. The contender must leave the pending ownership claim intact,
the winner's actual CLI must read the card, and the contender must reject that
token with 401. Inspect startup-race.json, both daemon cleanup receipts and
race-cleanup.json. The pause changes only syscall scheduling at the publication
boundary. Credential issuance, HTTP admission and CLI reading use production code.
