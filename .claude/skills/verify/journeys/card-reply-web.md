# Web chat notices open their question cards

Follow shared isolation in `../SKILL.md`. This slice intentionally uses synthetic
DOM/component tests and isolated daemon transport fixtures, with no unattended
GUI/browser automation and no real DB, live daemon or port 8399.

From `packages/web`:

```sh
bunx vitest run src/neo/__tests__/NeoLiveWorkScenes.test.tsx \
  src/neo/__tests__/NeoLivePublicConversation.test.tsx \
  src/neo/__tests__/publication-client.test.tsx \
  src/neo/__tests__/public-conversation.test.ts \
  src/neo/__tests__/NeoAskTodos.test.tsx \
  src/neo/__tests__/NeoLive.test.tsx \
  src/neo/__tests__/useNeoPublications.test.tsx
bun run build
```

The tests render one localized card-reply row without options in chat. They click
the actual public-conversation component through NeoLive's Work callback at both
mobile and desktop media settings, require the owning card to expand, focus and
highlight its question, and expose existing answer controls. Back to chat restores
the previous scroller position. Answered/retired questions show their saved details;
replacements resolve to their current question. Missing, broken or cyclic targets
show explicit unavailable feedback. Repeated clicks focus again; removing an open
target updates the feedback. The reader validates/preserves metadata, coalesced
retarget refreshes keep one sequence/row, and card notices do not infer an answered
human input, even from edit provenance.

For an actual isolated daemon and WebSocket publication contract, from repo root:

```sh
RUN=$(mktemp -d /private/tmp/hn-card-web-proof-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/card-reply-daemon.ts "$RUN"
```

The existing daemon proof uses only synthetic quoted intake/card mutations. Its
web publication reader now retains `cardReply` after edits/replacements, daemon
restart and separate WebSocket page reads. Evidence is `evidence/card-reply.json`.
Its daemon resources close in finally; there is no model turn or browser.

The existing `neo-publication-sdk.test.ts` online fixture also compares the daemon
page with the web reader's complete metadata-preserving result. Run it with the
online Vitest config under a fresh empty HOME/data directory and
`HYPERNEO_TEST_DISABLE_SANDBOX=1` for the loopback transport-only fixture. That
fixture owns its synthetic daemon and HTTP/GitHub stubs; it is not OS sandbox proof.
No daemon runtime or iOS behavior changes in this slice. Pixel layout and native
navigation are not claimed by these non-GUI proofs.
