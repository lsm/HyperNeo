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
- the real `neo.snapshot` keeps `named.requestFrom` on that request todo and
  sends `named: null` for the ordinary worked todo, so clients can hide
  internal requests;
- Neo does nothing; the real pack sweep (`NeoService.sweepPacks`) tells it about
  that todo again at its 1 h rung, saying it is a request waiting for Neo's
  answer, not "Write the instruction and start it";
- Neo closes it with the real `neo.todo.done`, which queues one
  `neo.request.reply` job; running that job (the job processor is stopped, so
  the helper runs it) delivers through `message.send`. The sender's mailbox
  gets exactly one message from Neo naming the request and Neo's reason, Neo's
  conversation reader holds exactly one outbound answer, and retiring the
  closed todo queues no second one;
- the same request 11 minutes later is rejected with `request_closed` and
  queues no mailbox wake;
- closing a request whose sender session does not exist succeeds; its reply
  job is rejected and wakes Neo with "did not reach session";
- a question from the worker of an open todo records no request todo.

Pass prints `PASS request_todos=1 wakes_at_30m=<n> wakes_at_1h=<n+1> replies=1
answers=1 reply_failed=woke_neo closed_repeat=rejected snapshot_marker=request_only`. A remote requester is
covered by unit tests with a stubbed attached-daemon forwarder. This does not show a model turn
or the sender session processing the reply.
