## Copilot owned history and discovery (worker slice 5)

Run from the worktree root, with a fresh run and free loopback port:

```bash
RUN=$(mktemp -d /private/tmp/hn-copilot-history-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/copilot-history-find.ts 9386 "$RUN"
```

The actual isolated daemon's public `operation.invoke` door drives the pinned
SDK against synthetic framed-JSON-RPC and ACP processes. Evidence stays in
`$RUN/evidence/observed.json`. All stored synthetic data and evidence are retained;
cleanup closes only the helper's socket/daemon and confirms its SDK fixture PIDs
have exited. No GUI, account, credentials, provider or human session is used.

Observe:

- `work.read` for an owned session returns user, tool-start, tool-result and
  assistant text, stable prefixed message IDs and no duplicate assistant record.
  Unknown events do not become visible messages. After daemon restart the same
  history is readable without `session.create`, `session.resume` or `session.send`.
- `work.find` lists a completed owned session once as done despite a fresh ACP
  timestamp, and permission-blocked work once as needs_you despite an old ACP
  timestamp. Twenty-five additional owned duplicates cannot hide the external
  session behind ACP's 20-item place window: ownership exclusion happens before
  that window. External discovery retains its existing age heuristic and never
  calls ACP load/prompt/cancel. External send remains not_found.
- History pages read at most 256 KiB from the known owned CLI transcript, return
  up to 21 entries and clip each entry to 4,000 characters with textComplete:false.
  Cursor continuation reads older entries. A partial final line is ignored and
  marks history incomplete. Rotating the fixture transcript invalidates its old
  cursor with reply_unavailable; the preserved original is kept alongside it.
  Receipt-bound work.status still returns the original complete report.

The process suite also checks UTF-8 at a bounded source window, oversized and
malformed records, same-inode truncation, missing anchors, final-path symlink
refusal, project grouping versus execution directory, uncertain accepted work,
Space filtering, and owner loss. Owner-unavailable summaries retain last-known
status with an explicit watchHint; uncertain later acceptance is queued, never
borrowed completion. A queued summary does not prove input was consumed or work
started. Receipt evidence retains that distinction.

Owned listing reads directory batches of 64, scans at most 4,096 entries and
loads the 200 most recently modified ownership records, then applies existing
place/text filters and the 20-work-per-place window. Concurrent directory scans
share an in-flight read; ACP retains its existing in-flight/60-second listing
reuse. This is a bounded discovery window, not exhaustive search or a retention
policy. Old ownership still suppresses ACP duplicates even outside that window.
No ownership, receipt or transcript files are deleted. `around` searches only
the current bounded byte window; an unlocated anchor reports reply_unavailable.
Clipped history is a preview; full final reports remain receipt-bound, and
history availability never proves turn completion.

Real CLI 1.0.105 / SDK 1.0.28 compatibility and the CLI's native persistence
layout, real account authentication/entitlement/quotas/billing, tool execution,
Desktop/IDE live visibility and GUI handover remain unverified. The helper
impersonates the pinned runtime, including its COPILOT_HOME session-state event
log. It performs no real Copilot call or credential-file access. The adapter only
reads known owned transcripts; it never edits the CLI's own store or adopts an
external session. Shared SKILL.md and journey discovery remain unchanged.

Review regressions have separate helper modes, each requiring a fresh run:

```bash
for MODE in search peek external-failure boundary emoji; do
  RUN=$(mktemp -d /private/tmp/hn-copilot-find-review-XXXXXX)
  mkdir -p "$RUN/home"
  env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
    NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
    bun .claude/skills/verify/copilot-history-find.ts 9386 "$RUN" "$MODE"
done
```

- `search`: an older external title match survives twenty-five newer sessions in
  the same place, because text reaches ACP filtering before the result window.
- `peek`: after starting synthetic held work, the fixture withholds ping replies.
  Browsing find must send no ping/shutdown, leave its ownership record byte-for-byte
  unchanged and retain the live PID. Releasing the fixture gate and sending a
  follow-up must complete the original receipt; browsing never stops the worker.
- `external-failure`: after restart, a cold ACP list fails explicitly. The stored
  owned result remains discoverable as done, with a watchHint saying external
  discovery is unavailable and the list contains owned work only. No resume occurs.
  If no owned results are available either, find retains its adapter-unreachable
  failure rather than presenting an apparently successful empty list.

- `boundary`: a visible assistant turn straddles the 256-KiB leading boundary,
  followed by an entire window of unknown records. The first page is empty; its
  cursor must re-read the skipped leading line, and the next page must expose the
  stable turn ID with explicit text clipping. Receipt-bound status remains intact.
  Process cases also cover windows of deltas, subagent and malformed records, plus
  strict cursor progress over an oversized line so empty pages cannot loop.
- `emoji`: a turn whose 4,000th UTF-16 unit is the first half of an emoji is
  clipped to the 3,999 whole characters before it (textComplete:false), so the
  preview never ends in half a surrogate pair or a replacement character.
