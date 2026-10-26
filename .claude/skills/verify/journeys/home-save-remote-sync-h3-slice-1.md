### Home save remote sync (H3 slice 1)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-sync.ts <port> "$RUN" after`.
The helper seeds a synthetic Git identity and a local bare remote plus peer clone,
then configures only that test home's origin/upstream. No GitHub, credentials or
network remote is used; keep the verify gh stub first on the daemon's PATH.

The real save RPC must fetch the peer's new file, publish a protected fast-forward
and push the requested document.
It then sets remote.pushDefault to an unrelated local bare repo: another save
must still update only origin, leaving the unrelated repo without any heads.
Then both peers commit conflicting versions of another document: save must
return conflict without rebasing the original home, retain the local bytes/HEAD, leave the index
clean and never write the pending file. The helper explicitly resolves only its
synthetic fixture with a merge preserving the local version before continuing;
the product never chooses a conflict resolution.

A synthetic receive-pack failure then forces push_failed. Its local commit must
remain intact and be named in the refusal. Removing that fixture setting and
retrying must push the same commit without another commit. Evidence:
`evidence/neo-home-sync-after.json`. Use `before` on the test-only commit in a
separate fresh run: it records a local save that neither pulled nor pushed.
The helper next saves with a synthetic credential-like commit message: it must remain local without moving the remote head. It discards only that unpublished synthetic commit before the independent binary probe. It then commits synthetic credential-like bytes in a binary file locally: the next save must refuse remote publication while leaving the remote head unchanged. Publication scans include raw commit messages/metadata and per-parent merge patches, treating binary blobs as text with the long-supported -m -p -a flags. Focused contracts also cover secrets introduced only in a merge resolution. Stop with `stop.sh` afterwards. Focused contracts additionally cover local-only
homes, failed pulls, dirty input, a paused human rebase, links introduced by a
pull, and confirmed document/decision-log pushes. No GUI or model is exercised.

For rebase ownership, use another fresh isolated run and execute
`bun .claude/skills/verify/neo-home-sync-faults.ts <port> "$RUN" race after`.
A synthetic upload-pack pauses fetch; while it waits, the helper starts a real
human-owned interactive rebase and edits at its stop. Save must refuse without
aborting that rebase, changing HEAD/status or losing the edit. Sync fetches first
and rebases only in its newly owned temporary worktree. Cleanup removes that
candidate only; it never aborts or resets the original home. Existing conflict
contracts still require original files, HEAD and clean status to remain unchanged.

For deadline/queue recovery, run the same helper with `deadline after` in another
fresh run. Alternatively, the RPC-only launcher owns a fresh synthetic HOME,
DB and daemon without building the web or starting a model fixture:

```bash
bash .claude/skills/verify/neo-home-deadline.sh "$RUN" after 9397
```

Upload-pack stays pending until the daemon's actual 30-second network deadline;
its process group must stop and save returns a timeout. With read-once-per-wake
sync, a queued human read then makes its own fresh fetch and must also time out,
without returning stale local text. Each network attempt must finish within 33 s
of becoming active, with both requests settling within 65 s total; HEAD/status stay unchanged. The helper auto-releases
its synthetic transport at 65 seconds so a broken deadline cannot hang forever.
It records noninteractive Git/SSH settings, separate save/read elapsed times and
both results in `evidence/neo-home-sync-<mode>-after.json`.
On the retained regression commit, `before` records the old 35-second fixture
release and the now-invalid assertion that the queued read succeeds. Unit contracts use a shorter injected deadline for
both fetch and push; RPC exercises the production default. Stop with `stop.sh`.

This slice syncs saves to an existing configured origin/upstream. GitHub's
once-only private-repo proposal/create, second-machine clone and read-once-per-wake
sync have their own journeys. Conflict-question presentation and recorded-choice
application are tracked in their separate journeys.
