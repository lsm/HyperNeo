# Publication pages execute as one DB command

Use isolation and resource guards from SKILL.md. This helper needs no model or
HTTP mock; its daemon owns a fresh HOME/data/TMPDIR and ephemeral non-8399 port.
GitHub and external HTTP are refused. No simulator or credentials are used.

```sh
python3 .claude/skills/verify/lane-a-publication-page-db-run.py bun verify
python3 .claude/skills/verify/lane-a-publication-page-db-run.py deno verify --executable "$DENO"
```

DENO names an existing cached runtime. The runner preserves evidence and removes
all synthetic daemon data, including failed runs. It runs the checked-out code;
reproduce the original failure from the regression commit in its own worktree.
Before mode does not replace source files.

The public WebSocket publication.read RPC first encounters a corrupt stored row
while the legacy public-conversation identity is uninitialized. Decoding must
fail without committing the identity. The baseline commits the identity before
reporting failure. Two repaired concurrent reads initialize one identity and
return the same authored bytes, including the full Unicode verbatim reply hash.
Forward, newest, earlier and empty pages preserve their cursor semantics and
exclude a foreign conversation. Bound Neo MCP callers read the same page;
unbound callers and a binding removed before queued command admission are refused.
Restart retains the page. No card-reply write or core ask flow is exercised.

Instrument publication, binding and public-conversation SQL on the main
connection only while RPC/MCP reads run; fixtures and assertions are excluded.
Fixed runs require zero target SQL. Existing lazy conversation initialization
makes this one writer command, so admission, initialization and decode share a
commit boundary. No external effects occur in it. Timings/JSON byte sizes do
not isolate queue, SQL or clone cost. No full conversation/GUI, latency, RSS,
WAL or whole-daemon SQL absence claim is made.
