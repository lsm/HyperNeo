# Chat and todo inline paths may contain spaces (#8940)

Use shared metadata-only isolation and resource setup in SKILL.md. The helper
seeds only a fresh synthetic database/workspace and exercises the real resolver,
immutable registration and byte reads; no provider or credential is needed.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/preview-inline-spaces.ts
```

Both stored chat and todo text name `notes.md` and `My notes.md`. Each exact
reference must register and read all synthetic bytes, with stable retries.
Symlinks, traversal, missing files, unmentioned existing files and shell syntax
must be refused. A command-looking span is a single literal filename, never an
instruction or a source of argument paths. Inspect inline-spaces.json/proof.log.

For an isolated daemon WebSocket proof, pass --rpc before the disposable run:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/rpc-evidence-directory \
  .claude/skills/verify/preview-inline-spaces.ts --rpc
```

That mode uses the actual operation.invoke door on an ephemeral loopback daemon,
refuses ports 8399/8499 and stops owned resources in finally. If the listener
cannot start, report the RPC mode blocked even if native operation capture
passed. Never restart the live daemon or weaken its worker policy to run this.
