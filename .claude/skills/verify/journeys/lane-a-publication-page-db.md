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

The `bun-verify` directory is the pre-fix RPC failure committed before the fix;
its five target SQL statements include the partial identity insertion. The first
fixed run `bun-verify-1` passed rollback but stopped on the fixture's refusal
assertion: MCP adds explanatory text after `human_only`. It is retained as
incomplete. The corrected assertion checks the reason key and preserves the full
reply; `observed.json.proofBinding.runs` names the final passing pair.

The current application commit and complete packages/scripts trees, helper blobs
and successful run heads are bound in observed.json. After that commit, change
only this journey and its evidence folder. Audit before pushing:

```sh
bun --no-install --no-env-file .claude/skills/verify/lane-a-publication-page-proof-binding.ts HEAD
```

The final pair was refreshed after adopting the existing typed repository command
interface and merging dev with the stage-target reader. The shared registry keeps
both append-only entries; operations.ts did not conflict and retains only its
granted call-site change. No SQL baseline change was made. Previous passing
bindings remain historical; only proofBinding identifies the final candidate.

The latest binding was refreshed after merging dev with the inventory readers
and turn-vector writer. Only the first registry import conflicted; both imports
are retained, with this slice's import at the end of the import block. Against
dev, the registry diff remains exactly the granted import and appended entry.
operations.ts merged cleanly and retains only the granted factory-call change.
Both fresh runtime proofs identify the merged application commit; historical
passing pairs are not evidence for the new candidate.
