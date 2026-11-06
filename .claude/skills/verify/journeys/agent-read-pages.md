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
that agent-read.credential is owner-only and different from local-rpc.credential.
The real `hyperneo read <link>` command must print the card without a session
identity. An anonymous request must receive 401 with the command hint. An actual
agent WebSocket attempt must fail, while a human WebSocket can still read the card.

Generate a remote agent code through the existing CLI. Redeeming it must return
403 until the human approves through RPC. The resulting agent credential reads
the card and is refused on /ws. Revoke both remote and local agent devices through
human RPC. Both reads must become 401, and the CLI must fail. Restart the daemon
against the same synthetic data. Startup must reuse the existing agent file and
keep its revocation effective. The human credential must still work.

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
owner-only agent-read.credential file in its configured data directory. The CLI
uses that file, validates the card URL and refuses redirects. It never falls back
to local-rpc.credential. No credential belongs in a link.
