# Definite refusals permit retry; lost acknowledgements do not

Use SKILL.md's metadata-only in-process wrapper. Run the two modes separately,
checking resource guards before each:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/codex-refusal-evidence .claude/skills/verify/worker-question-answer-refusals.ts codex
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/remote-refusal-evidence .claude/skills/verify/worker-question-answer-refusals.ts remote
```

Both modes own a fresh daemon, HOME/data/DB, refusing gh/open shims and a ps shim
that reports no Desktop process. There is no model, provider, fixed HTTP port,
credential, real app or native state. The helper owns every native/remote peer.

In codex mode the production adapter connects to a synthetic Unix app-server.
Its typed JSON-RPC invalid-request response names this thread's active writer
and confirms that turn/start accepted no input. The response has a prefix and
suffix around the active-writer phrase; typed error and invalid-request code
validation remain required. Answer a worker card through
neo.question.answer: it must stay pending/needs-human, with a released claim.
The real work.send RPC control must expose notSent true. Change only the peer's
response to accept, make the owned driver-refresh job due, and run one tick.
Exactly one input must be accepted; the card becomes accepted and the todo doing.
A matching completion lets the app-server connection unsubscribe and close.

In remote mode attach a reserved, closed loopback endpoint through daemon.attach,
then answer a card bound to that synthetic daemon. No operation request was sent:
the registry's typed pre-connection failure must survive as notSent true through
work.send, with no contradictory may-have-been-delivered guidance. Uncertain
post-dispatch failures retain that guidance. The claim clears but the hold remains.
Start only that peer and reattach the same endpoint to clear the existing connection-failure cooldown;
this is not a claim that ordinary recovery bypasses its one-minute cooldown.
The real refresh handler must then accept exactly one input and resume the todo.

Keep refused.json, observed.json, proof.log, run-status.json and cleanup.json.
The helpers stop all owned resources and remove native/daemon data in finally;
the wrapper saves evidence outside its disposable run and removes it. Unit
contracts use real sockets to distinguish an explicit refusal or pre-connect
failure from a connection lost after dispatch, which must remain uncertain.
No error-text match or age-based settlement is treated as proof of non-delivery.
