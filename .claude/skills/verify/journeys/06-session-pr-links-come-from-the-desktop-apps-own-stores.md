6. **Session PR links come from the desktop apps' own stores.** Read-only, on the
   human's machine: `bun .claude/skills/verify/linked-prs.ts claude <local_id>`
   prints the `linkedPrs` that `work.status` reports for a Claude Desktop session
   (its `prs[]`, with `dismissed`); `... codex <thread_id>` prints a Codex
   thread's `pull_request` attachments from `~/.codex/state_5.sqlite`. It never
   reads credential files. End state: the list matches the app's sidebar.
   `bun .claude/skills/verify/pr-owners.ts` replays the coding pack's owner
   choice over every local Claude, Codex and HyperNeo session against the live
   ledger (opened `?mode=ro`) and prints owned-before/after counts plus each
   owner change; check every change names the session that created the PR.

   For the b2 ownership regression, use only synthetic session metadata/transcripts:

   ```bash
   RUN=$(mktemp -d /private/tmp/hn-pr-owners-XXXXXX)
   env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
     bun .claude/skills/verify/pr-owners.ts --synthetic "$RUN"
   ```

   The helper creates its own DB and 64 Claude sessions with about 130 MB of
   synthetic transcripts. It runs the real coding-pack sweep/reconcile and reads
   the ledger snapshot. Git remote lookup uses a real local synthetic Git repo
   once per retained folder across sweeps; only GitHub replies are stubbed. No
   provider or GUI is involved. The live helper's owner projection must match
   the ledger, including no-sidebar transcript and stored watcher evidence. End state: a `commented` sidebar link is unowned,
   an explicit `own:true` link owns its PR, a transcript `gitOperation.pr` with
   `action:created` corroborates ownership, branch matching still works, an append
   is discovered without metadata changes, and dismissal unlinks its PR. A session
   without a sidebar keeps both transcript-created and watcher-opened PR ownership
   across repeated watcher/sweep observations. The
   helper writes `observed.json` before asserting each result and a 1,000 ms
   maximum 10 ms heartbeat-lag budget. Cold, unchanged, repeated-watcher, appended and dismissed
   reconciles each report elapsed time and max lag. No daemon is started; the DB
   closes and the heartbeat stops in `finally`. Retain the JSON, remove only this
   synthetic run afterward. This does not prove deployed behavior.

   The driver reuses the session JSON mtime cache and caches its branch projection
   per record. Git remotes stay cached while a folder remains represented; removing
   its last session evicts that entry. Transcript reads resume after the last complete newline, in 64 KiB
   chunks that yield; partial UTF-8 lines, truncation and replacement are covered.
   The coding pack alone treats a successful creation as ownership evidence; a
   Claude sidebar reference alone is not an owner. The default live read-only
   helper now uses that same reader/policy. Never read auth or credential files.

   For PR-ledger c, run the unowned-PR wake door in a new synthetic database:

   ```bash
   RUN=$(mktemp -d /private/tmp/hn-pr-unowned-XXXXXX)
   env -i PATH="$PATH" NODE_ENV=test HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" \
     HYPERNEO_USE_DEV_PROXY=1 VERIFY_PORT=9355 \
     bun .claude/skills/verify/pr-owners.ts --synthetic-unowned "$RUN"
   ```

   Ports 9355 and 8000 must be free. The helper starts its own isolated daemon
   and local mock provider, and uses synthetic GitHub responses through the real
   coding-pack reconcile. It observes the result at the actual Neo mailbox input
   via WebSocket `session.messages.byStatus`, not just a mocked wake callback.
   End state: one consumed Neo input lists 90 newly unowned human PRs, excluding
   drafts, bots, known owners, closed PRs, unknown metadata, and creation at/before
   the persisted first-activation cutoff. A later new PR survives a lost handoff acknowledgement
   and pack recreation with the same batch identity and reaches Neo once.
   Unchanged reconciles send nothing. Each PR has one `neo-pr-unowned:repo#N`
   record; one pending batch preserves retry identity. New arrivals while a
   batch retries wait until the next reconcile. The notice describes discovery
   facts and tells Neo to check current ownership before assigning anyone.
   `observed.json` records elapsed time and max 10 ms heartbeat lag for each
   reconcile against a 1,000 ms budget; `delivered.json` and `accepted.json`
   prove both batches reached Neo as consumed input. GitHub and existing Claude
   owner reads are synthetic; no deployed or GUI behavior is claimed. The helper
   disposes its service, daemon, SDK processes and local provider in `finally`.
   Retain evidence, confirm both ports are closed, then remove only this run.
