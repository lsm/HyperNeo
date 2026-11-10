# Space web surfaces through the extension registry

The web shell reaches Space only through `lib/web-extensions.ts`; `client.tsx`
registers Space. While Space is registered, every Space entry point must look
and behave as before.

Static check (fails on a shell file that imports a Space module directly):

```bash
.claude/skills/verify/web-shell-space-imports.sh
```

Browser check against an isolated test daemon (no model turns, no keys, never 8399).
Build web for HEAD first:

```bash
cd packages/web && bun run build && cd ../..
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX") && rmdir "$RUN"
.claude/skills/verify/web-extension-space.sh "$RUN" 9397
```

It creates one synthetic space over RPC, then in a headless browser:
the Spaces home lists it, New Space opens the Create Space dialog, ⌘K finds the
space and opens it, and the space overview plus the side-panel detail render
(`space-overview-dashboard`, `Space navigation` with `space-detail-goals`). No page errors. Evidence:
`$RUN/evidence/web-extension-space.json`, `spaces-home.png`, `space-overview.png`.

The helper authenticates RPC and the browser with only the isolated daemon's
owner credential; no anonymous owner connection or live credential is used.
