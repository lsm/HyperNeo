## Claude Desktop inbox delivery across paired daemons

Run from the repository root on a host with the pinned Bun and dependencies.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/paired-claude-inbox-reply.ts
```

Two isolated loopback daemons use fresh homes and databases. A synthetic Claude
Desktop peer uses the real inbox socket and records the received input in its
transcript. No provider or model mock is used.

The first remote `work.send` has no reverse attachment. Its refusal must name
the missing reply daemon, and the peer must receive zero frames. Pair the
reverse route under an alias that differs from the sender's OS hostname. Neither
daemon has a reply ID set in its environment. Restart both daemons with their
saved attachments. The next send must write exactly one inbox frame and return
a matching transcript-confirmed receipt. A reply on the private socket must
reach the sender's mailbox through that same paired route.

Keep `observed.json`, `proof.log` and `run-status.json`. This verifies the daemon
RPC, authenticated forwarding, inbox socket and mailbox. Live Desktop rendering
and a model-generated reply require an attended check.
