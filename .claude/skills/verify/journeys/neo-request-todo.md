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
  that todo again at its 1 h rung, saying it is a request waiting for Neo's
  answer, not "Write the instruction and start it";
- Neo closes it with the real `neo.todo.done`; the sender's mailbox gets exactly
  one message from Neo naming the request and Neo's reason, and retiring the
  closed todo sends no second one;
- the same request 11 minutes later is rejected with `request_closed` and
  queues no mailbox wake;
- closing a request whose sender session does not exist succeeds, and its
  receipt carries `reply_failed:` for Neo;
- a question from the worker of an open todo records no request todo.

Pass prints `PASS request_todos=1 wakes_at_30m=<n> wakes_at_1h=<n+1> replies=1
reply_failed=shown closed_repeat=rejected`. This does not show a model turn
or the sender session processing the reply.
