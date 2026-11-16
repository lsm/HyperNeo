# A request to Neo from a non-worker stays open until Neo closes it

Use shared isolation and cleanup in `../SKILL.md`. This proof boots one fresh
synthetic daemon on an ephemeral loopback port with the job processor stopped,
so no model, provider, browser or external HTTP is used.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/neo-request-todo.ts
```

The helper sends `message.send` with kind `question` to a synthetic Neo
through the daemon's real operation registry, as an in-process session that
works no open todo. Observe `neo-request-todo.json` and the mailbox queue:

- the daemon records one open ask with one approved todo whose title is the
  request's first line and `named.requestFrom` the sender, and the ask's origin
  message is the delivered message;
- Neo does nothing; the real pack sweep (`NeoService.sweepPacks`) tells it about
  that todo again at its 1 h rung;
- after Neo closes that todo, the same request 11 minutes later is rejected
  with `request_closed` and queues no mailbox wake;
- a question from the worker of an open todo records no request todo.

Pass prints `PASS request_todos=1 wakes_at_30m=<n> wakes_at_1h=<n+1>
closed_repeat=rejected`. This does
not show Neo replying, the reply reaching the sender, or a model turn.
