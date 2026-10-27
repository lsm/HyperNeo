# Shared CJK card and message search

Use SKILL.md's resource check and disposable proof-run.sh wrapper. Run one job
at a time; neither helper uses the live daemon, a real database or credentials.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/cjk-search-upgrade.ts
```

The helper seeds an actual isolated daemon, closes it, and changes only that
synthetic database to the legacy unicode61/detail=column indexes with the m462
marker absent. Two fresh daemon processes then upgrade and restart it. Both
neo.ask.search and message.search must find the old Chinese row with 构建版 and
构建. Compare content values, FTS integrity, schema and the unchanged applied
marker across restart. Database row prototypes vary between Bun and Deno; the
saved snapshots compare JSON values. The wrapper must exit zero and remove its
synthetic data after owned resources close. Run with Bun and pinned Deno using
SKILL.md's VERIFY_PROOF_RUNTIME selection. Use neo-card-search-rpc.md for the
additional file/memory, literal wildcard and title-only scope contracts.

For the changed web search box, build packages/web first under the shared
resource check, then run:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/cjk-search-web.ts
```

Supply NODE_PATH and VERIFY_BROWSER using SKILL.md's browser setup. This helper
serves the fresh web build and owns its daemon on free ports. It uses a valid
hexadecimal session id accepted by the main router, opens quick search and
types 构建. At 390 and 1280 pixels, the real RPC reply must contain only the
message title match, the UI must display that result and the title-only scope
notice, and the page must have no horizontal overflow or browser errors. Browser
HTTP and WebSocket routes allow only the owned frontend's port. Inspect
browser.json and both screenshots; failure screenshots and diagnostic text are
retained when a page assertion fails. A browser launch failure remains unverified.

These proofs exercise the public daemon and web surfaces. They do not establish
that a deployed phone has found an unloaded old card; that acceptance check
remains after rollout.
