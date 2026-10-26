# Home writes through late symlink swaps

Read shared SKILL.md setup first. Run the metadata-only native filesystem proof
with the shared wrapper, once under Bun and once under pinned Deno:

```bash
PROOF=.claude/skills/verify/neo-home-safe-files.ts
bash .claude/skills/verify/proof-run.sh "$EVIDENCE/bun" "$PROOF"
VERIFY_PROOF_RUNTIME=deno bash .claude/skills/verify/proof-run.sh "$EVIDENCE/deno" "$PROOF"
```

The helper changes a leaf or parent in a microtask after a directory handle has
opened. Writes must stay on that handle, leaf replacement/deletion must not follow
a link, and parent-link deletion must fail without changing the outside sentinel.
It also checks exact binary bytes, a document above the ACP text limit, mode
preservation and actual EACCES/ENAMETOOLONG errors. Inspect the saved JSON and logs.
This verifies the native filesystem primitive, not SDK sandbox enforcement.

For the public operation, launch a fresh isolated daemon using shared setup and run:

```bash
bun .claude/skills/verify/neo-home-save.ts <port> "$RUN" write-races
```

The RPC fixture installs an owned Git wrapper after initialization. At `git add`,
after the requested document is written, it swaps either the leaf or its parent
for a symlink and forces add failure. Rollback must leave the outside sentinel
unchanged and retain the original HEAD. The fixture restores the home entry and
original bytes using ordinary file tools and retries: save must succeed and commit
the requested bytes, including on dev before the dirty-home refusal is removed.
Inspect `evidence/neo-home-write-races.json`. No model, provider, real remote or
credentials are used. Stop the owned daemon and preserve evidence before cleanup.

Directory-handle enforcement applies on macOS/Linux, including WSL2, under Bun
and Deno. Native Windows keeps its existing human RPC path; Neo's required SDK
sandbox is unavailable there, so it has no sandboxed-Neo escape path to test.
