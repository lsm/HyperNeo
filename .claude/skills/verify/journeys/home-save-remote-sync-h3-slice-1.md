### Home save remote sync (H3 slice 1)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-sync.ts <port> "$RUN" after`.
The helper seeds a synthetic Git identity and a local bare remote plus peer clone,
then configures only that test home's origin/upstream. No GitHub, credentials or
network remote is used; keep the verify gh stub first on the daemon's PATH.

The real save RPC must pull the peer's new file and push the requested document.
It then sets remote.pushDefault to an unrelated local bare repo: another save
must still update only origin, leaving the unrelated repo without any heads.
Then both peers commit conflicting versions of another document: save must
return conflict, abort its rebase, retain the local bytes/HEAD, leave the index
clean and never write the pending file. The helper explicitly resolves only its
synthetic fixture with a merge preserving the local version before continuing;
the product never chooses a conflict resolution.

A synthetic receive-pack failure then forces push_failed. Its local commit must
remain intact and be named in the refusal. Removing that fixture setting and
retrying must push the same commit without another commit. Evidence:
`evidence/neo-home-sync-after.json`. Use `before` on the test-only commit in a
separate fresh run: it records a local save that neither pulled nor pushed.
Stop with `stop.sh` afterwards. Focused contracts additionally cover local-only
homes, failed pulls, dirty input, a paused human rebase, links introduced by a
pull, and confirmed document/decision-log pushes. No GUI or model is exercised.

For rebase ownership, use another fresh isolated run and execute
`bun .claude/skills/verify/neo-home-sync-faults.ts <port> "$RUN" race after`.
A synthetic upload-pack pauses fetch; while it waits, the helper starts a real
human-owned interactive rebase and edits at its stop. Save must refuse without
aborting that rebase, changing HEAD/status or losing the edit. Pulls stamp their
own unique Git reflog action, and cleanup requires that ownership marker.
Existing conflict contracts still require the operation to abort its own rebase.

For deadline/queue recovery, run the same helper with `deadline after` in another
fresh run. Upload-pack stays pending until the daemon's actual 30-second network
deadline; its process group must stop, save returns a timeout and a queued read
then succeeds. The helper auto-releases its fixture at 35 seconds on old code so
the baseline cannot hang forever. It records the noninteractive Git/SSH settings,
elapsed time and queued read in `evidence/neo-home-sync-<mode>-after.json`.
Use `before` instead of `after` on the regression commit to retain the failing
race and 35-second baseline. Unit contracts use a shorter injected deadline for
both pull and push; RPC exercises the production default. Stop with `stop.sh`.

This slice syncs saves to an existing configured origin/upstream. GitHub's
once-only private-repo proposal/create, second-machine clone, read-once-per-wake
sync and conflict-question presentation are later H3 slices.
