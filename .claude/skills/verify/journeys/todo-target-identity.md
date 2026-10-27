# Todo targets resolve before they are stored

Use the shared setup in SKILL.md and the metadata-only proof wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/todo-target-identity.ts
```

The helper owns a real daemon on an ephemeral port, a fresh HOME and synthetic
database. It registers no provider and starts no worker or model turn. Through
the production MCP handler, adding send and bind targets using a uniquely
resolvable HyperNeo session prefix must store the full ID. An unknown prefix
with start:true must be refused before creating a todo or delivery input.
The separate neo.todo.bind door must also resolve a prefix to the full ID;
an unknown rebind must fail while retaining the previous worker reference.
The saved observed.json contains actual replies and stored target rows.

Focused neo-todo-target tests also cover Codex references, owning-daemon and
adapter isolation, ambiguous prefixes, incomplete discovery and exact IDs.
Both source adapters filter ID prefixes before per-place and archived-history
limits; the Codex reader carries that filter through its existing DB worker.
Those fixtures replace work lookup; they do not prove external Codex discovery.
A listener startup failure leaves this real-daemon journey unverified. Retain
its log and exit status; the wrapper saves evidence and deletes synthetic data.
