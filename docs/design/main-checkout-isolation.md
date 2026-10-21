# Main-checkout isolation

**Proposal; human approval required before implementation or merging this document.**
Workers should start in a leased execution workspace outside the main checkout,
with an enforced filesystem boundary that prevents absolute-path writes back into
main. Prompts, shell-command parsing, and asking the model to `cd` are not the
boundary. This PR changes only this page; it builds and migrates nothing.

## Read-only audit, 2026-10-21

Snapshot of eight `/Users/lsm/focus/<repo>` checkouts, Codex Desktop inventory,
live process CWDs and selected local Codex/Claude transcript tool calls. Recent
means since **2026-10-20 00:00 EDT (04:00 UTC)**; timestamps below are UTC unless
explicitly EDT. Git used `--no-optional-locks`; no pull, checkout, cleanup, build,
credential-file read or TCP 8399 request was performed in the audited checkouts.
Concurrent sessions were running: these are observations, not an atomic snapshot.

The complete local evidence is `/private/tmp/hn-main-isolation-audit/`:
`repos.json` lists all Git-status entries with mtimes/birthtimes and 40 HEAD
reflog entries per repo; `codex-inventory.json`, `processes-with-candidates.json`,
`codex-command-evidence.json` and `transcript-evidence.json` retain session/CWD
and command provenance. `audit.py`, `sessions.py`, and `codex-commands.py` retain
the read-only collection recipes. No file contents from untracked artifacts were
read. Ignored entries are Git-reported roots plus a three-level metadata walk,
excluding dependency/cache internals (`node_modules`, virtualenvs, `target`,
`DerivedData`, `.git`); this is **not** an exhaustive inventory of their leaves.
Birthtime is recorded where available; mtime alone does not prove a new file or
its writer. Transcripts were selected by recent file mtime, so a selected long
transcript also provides older history. Commands are evidence of invocation;
reflog/artifact timing corroborates effects, not the authorization of an action.

| Main checkout | Current tracked / untracked state | Artifacts and times; recent HEAD reflog |
| --- | --- | --- |
| neokai | No tracked edits; 63 untracked files | `.oapx/tool-artifacts/`: 7 files, Oct 13 19:17–23:27; `.pr-shots/`: 56 files, Oct 18 12:56–Oct 19 09:34. Recent ignored nested Claude worktrees, e.g. `neo-f61be3d6` Oct 21 02:11. Last HEAD pull Oct 14 13:14 EDT; main is behind its locally recorded upstream. |
| qlark | No tracked edits; 29 untracked entries | 26 `dist/qlark.app` files dated Oct 19 23:30; three untracked nested worktree roots: `neo-879d6ec6` Oct 19 23:35, `neo-8268eab2` Oct 21 00:44, `neo-26d7d333` Oct 21 16:47. Ignored `build/`, Xcode/SwiftPM outputs changed Oct 20–21, including `project.pbxproj` Oct 21 16:06:16. Reflog has **12** fast-forward pulls on Oct 20 EDT, plus two on Oct 21 at 09:35:33 and 12:06:16 EDT; more than the earlier eight-pull snapshot. |
| ops | No tracked edits or untracked files now | Ignored nested worktrees changed Oct 21, including `neo-27ad5504` at 13:40. HEAD fast-forwards Oct 20 14:11:03 and 20:24:39 EDT. The reported earlier 20 dirty files are not present in this snapshot. |
| open-agent-protocol | No tracked edits or untracked files | Ignored `.claude/worktrees/` and `.opencode/worktrees/` descendants active Oct 20–21. Latest HEAD pull Oct 19 22:59:55 EDT. |
| neo-ios | No tracked edits or untracked files | Ignored `neo-feeed853` worktree created/updated Oct 21 14:44; source/test descendants updated 16:47. Latest main HEAD pull Oct 18 08:07:23 EDT. |
| research | No tracked edits or untracked files | No recent ignored paths within the bounded scan. Last main HEAD pull Oct 13 09:22:13 EDT. |
| dolmen | **67 tracked edits, 62 untracked files** | All observed dirty-file mtimes cluster at Oct 4 02:36:45 UTC; includes batch/lakehouse/API/spike work. No recent ignored paths within scan. Last main HEAD fast-forward Sept 28 17:34:12 EDT. Preserve these older changes; writer/intent not established. |
| money | No tracked edits or untracked files | No recent ignored paths within scan; old ignored outputs remain. Last main HEAD fast-forward Oct 3 16:34:26 EDT. |

### Attribution that the evidence supports

- **Codex qlark**, thread `01a156d2-2c40-76f0-a33b-fbf252239136`, had
  `/Users/lsm/.codex/worktrees/e4e86fa7/qlark` as its recorded CWD but explicitly
  called commands with `workdir: /Users/lsm/focus/qlark`. Its Oct 20
  `git pull --ff-only origin main` calls line up with reflog fast-forwards
  (e.g. 04:05:07 UTC, transcript line 2880; 19:41:02, line 8784; 20:00:29,
  line 9089). This is a demonstrated absolute-path escape from good placement.
- **Claude qlark**, session `181b7bda-cc90-4298-ab7c-b04a04620591`, records main
  CWD. At Oct 21 13:35:32 it invoked checkout/pull (line 1580); at 16:06:14
  it invoked checkout/pull followed by `bash scripts/verify-app.sh build`
  (line 2321). Reflog at 16:06:16 and generated Xcode files agree in time.
  This corroborates recent main build output, not ownership of every older
  `dist` file.
- **Claude neokai**, session `bc37a8ae-c383-46cb-a16d-cd2a3f1d3c04`, explicitly
  wrote screenshots into `~/focus/neokai/.pr-shots` on Oct 18. Transcript lines
  53132/53158 invoke simulator screenshot/copy into `sv-ios-home.png` and
  `sv-ios.png`; mtimes match 19:28:08/19:28:32 UTC. This predates the recent
  window. No creator is established for `.oapx`'s Oct 13 files.
- **Codex ops**, thread `01a15a7f-9bcf-7903-9f1b-6896765a6285`, explicitly used
  main `workdir` on Oct 20 18:11:02 UTC (transcript line 118): compare two local
  files to merged upstream, restore them, then fast-forward. Reflog confirms
  18:11:03. This explains one synchronization, not the origin of all earlier
  dirty files. The other fast-forward and remaining artifact writers are
  unassigned unless a direct command reference is present in the evidence.

Historical main CWD is not proof of a write. Codex `fullstack-1` and `UI/UX`
currently record main CWD but are `notLoaded`; current loaded active Codex rows
below all record worktree CWDs. Live `work.find`/`work.status` could not be called
through this worker's allowed door; Neo confirmed no live snapshot was available.
Desktop status, process liveness and transcript recency do not prove a running
turn or establish exclusive authorship. Session-to-process candidate matches by
CWD are explicitly non-unique. No blame or cleanup decision follows from this audit.

## Enforcement design

1. **One execution lease before any worker activity.** Resolve canonical repo
   identity separately from execution CWD; reject symlink aliases and descendants
   of a registered main root. A trusted workspace manager provisions an owned,
   unique worktree under `~/focus/worktrees/<repo>/<lease-id>` (or adopts a
   confirmed Codex-managed external worktree). Persist owner, base SHA, branch,
   external artifact directory and lifecycle before starting the process or its
   first turn. Fetch the requested base via the trusted manager; never pull,
   checkout, reset or stash main. Dirty main is preserved, never copied implicitly.
   Non-Git projects receive a dedicated external workspace or an explicit refusal.
2. **Use the existing adapters, close their gaps.** Codex already creates a
   worktree for a primary checkout (`codex-desktop-adapter.ts:1098–1126`), but
   uses local HEAD and starts with `danger-full-access` (`:1176`, `:1200`).
   `work-placement.ts:8` accepts linked worktrees in place without testing whether
   they sit inside main. Change admission to require an external lease, including
   preparation hooks and resume/send paths. Claude's launcher explicitly chooses
   `.claude/worktrees` and `--worktree` (`claude-desktop-adapter.ts:1256–1292`):
   provision externally first and launch with that CWD, including bootstrap,
   resume, Desktop handoff, child shells and setup hooks. No first turn may run
   before the location and effective policy are confirmed.
3. **Enforce writes at the executor boundary.** Restrict agent writable roots to
   its leased worktree, bounded artifacts/temp/cache locations and required
   runtime state; main content, siblings and protected Git metadata stay
   read-only. The Codex config's
   [`sandbox_workspace_write.writable_roots`](https://learn.chatgpt.com/docs/config-file/config-reference)
   adds writable roots in `workspace-write`; it is not a subtractive denylist.
   Exclude broad ancestor grants, disable unrestricted escalation for workers,
   and verify effective Desktop/start/resume/turn policy rather than just stored
   config. Claude requires an equivalent OS/container enforcement boundary for
   all tool and child-process writes; permission-mode text alone is insufficient.
   Unsupported enforcement fails closed, with an explicit blocked result.
4. **Handle shared Git deliberately.** A linked worktree shares the common Git
   directory, including main refs and `worktrees/*` metadata. Granting it wholesale
   write access would permit main-ref changes or removal of a sibling worktree.
   Keep ref/worktree lifecycle mutations in the trusted manager through scoped
   operations; permit only proven-safe per-lease metadata access for worker
   edits/commits. Test Git common-dir autodiscovery and aliases explicitly. If the
   installed sandbox cannot preserve worker Git workflows while denying those
   writes, use an isolated clone owned by that lease instead of widening access.
   Agents must not regain unrestricted host execution through an MCP shell,
   handoff helper or approval path. Network/deployment authority is separate.
5. **Make execution location observable.** `work.find`/`work.status` expose repo,
   lease CWD, effective isolation state and migration state distinctly. A repo
   label is never used as the command CWD. Default screenshots/build outputs go
   to the lease, and absolute writes to main must fail even when explicitly
   requested. Existing manually created or external sessions are discovered but
   cannot receive HyperNeo-directed worker turns until admitted or migrated.

## Migration and rollout

After human approval, inventory each existing thread's actual execution path,
policy, in-flight turn and uncommitted/untracked state. Mark unsafe sessions as
requiring migration and stop dispatching new work to them; do not interrupt a
running turn or change its CWD underneath it. Drain/coordinate at a safe boundary.
Use supported Codex handoff/relocation only after it proves retained history and
external execution CWD; otherwise create an isolated successor and preserve the
original as a readable predecessor. Claude similarly resumes only into a verified
external workspace, or gets a successor with explicit context transfer. Migration
of an active process is not a metadata edit.

Dirty main (notably dolmen) needs a human-reviewed ownership manifest and explicit
selection before any bytes are copied to a new lease. Never auto-stash, reset,
delete or chmod main; leave the human's checkout usable. Migrate ambiguous shared
workspaces separately. Lease records, retries and crash recovery must be
idempotent; cleanup removes only an owned, inactive, clean/archived workspace
with preserved commits/artifacts and approval where needed. Roll back by disabling
new isolated dispatch and retaining leases, never by returning workers to main.
No existing thread moves and no runtime policy changes are authorized by this doc PR.

## Small PRs and acceptance tests, only after approval

| Slice | Deliverable and observed acceptance |
| --- | --- |
| 1: lease/admission contracts | Failing synthetic-main tests first: primary checkout, linked worktree inside main, symlink, non-Git, setup/preparation failure and crash retry. No worker starts until an external lease is admitted; main status/index/content remain unchanged. |
| 2: Codex placement | Wire lease into bootstrap/first-turn and supported resume/handoff. Real disposable Desktop/app-server session executes its first command without `cd`; CWD is external, artifacts land there, duplicate starts are idempotent. No unattended GUI test. |
| 3: Claude placement | Provision outside repo and wire launch/resume/child shells. Real isolated test process proves initial CWD and output placement; no `.claude/worktrees` directory is created in synthetic main. |
| 4: executor write policy | Real installed Codex and Claude boundaries, separately if needed: attempt writes through absolute paths, `cd`, Python/file tools, symlinks, child shells, Git aliases/common-dir refs, hooks and alternate MCP executors. Each main/sibling write is denied; owned build, edit, commit and artifact workflows succeed. If unsupported, dispatch blocks. This slice is required before claiming enforcement. |
| 5: migration/visibility | Read-only inventory and human-reviewed migration preview, then safe-boundary moves with recoverable predecessors. Show real execution CWD/policy in status; refuse unsafe resume. Verify dirty files/history retained and old dispatch disabled. |
| 6: recovery/cleanup | Crash/retry/restart and stale-lease journeys preserve work and ownership, never delete a live or dirty lease. Verify rollback does not re-enable main execution. |

Each implementation PR targets fresh `dev`, stays within the repo's slice budget,
and updates the verify skill with its real synthetic journey and saved evidence.
Tests assert denied writes and observed CWD/output, not command-string filtering.
The current verify skill's daemon/model journeys were read but not run: this is
an audit/design, and the human prohibited building before approval. Runtime
placement, migration and enforcement remain **proposed and unverified**. This
page is verified against the recorded Git/process/transcript evidence and source
citations; it does not claim that this PR fixes isolation.

## Current worker inventory (snapshot, not a running-turn guarantee)

Codex Desktop reported these **active** threads (full IDs and loaded-idle/notLoaded rows are retained in `codex-inventory.json`):

| Thread | Recorded CWD |
| --- | --- |
| `01a14537-064f-7201-9aef-99ff70d92c96` (backend) | `/Users/lsm/.codex/worktrees/5d14f6b4/neokai` |
| `01a15773-50be-7b93-b634-2f0594551882` (HyperNeo fullstack-3) | `/Users/lsm/.codex/worktrees/b594a46f/neokai` |
| `01a15a95-b684-7350-8b13-0ac982c57d4a` (HyperNeo fullstack-4) | `/Users/lsm/.codex/worktrees/97ea145d/neokai` |
| `01a15a96-81a7-7fd0-b3c1-87ec43460029` (HyperNeo pack-prefs) | `/Users/lsm/.codex/worktrees/c9ea898c/neokai` |
| `01a15b52-4aec-7813-b828-5ccabf65ed6a` (HyperNeo web) | `/Users/lsm/.codex/worktrees/8ffc126b/neokai` |
| `01a15b68-4f33-71c1-abc9-94a0c2b2b2f7` (HyperNeo fullstack-5) | `/Users/lsm/.codex/worktrees/c6a88fa8/neokai` |
| `01a15bab-3664-7a72-8ce2-bce427d20c19` (HyperNeo adapters) | `/Users/lsm/.codex/worktrees/bfecd56c/neokai` |
| `01a15c40-7216-79e2-a7cc-7a1b30d521ac` (Codex HyperNeo web-2 (new session; old web thread never got it): merge lsm/HyperNeo#7886, then question cards render markdown on web (PR 1 of 3), merged) | `/Users/lsm/.codex/worktrees/c88ac639/neokai` |
| `01a15c3a-5284-7ed0-9390-9ef46ca581ca` (Codex HyperNeo delivery (new long-lived session): root-cause analysis + one-page system design for undelivered work, docs-only PR, report to Neo) | `/Users/lsm/.codex/worktrees/a12639d0/neokai` |

Live Claude executable PIDs (wrappers deduplicated), including idle/background processes. A PID is not a verified active turn; unidentified processes are retained rather than silently omitted. Paths below are execution CWDs, not repo labels.

| PID | CWD |
| --- | --- |
| 3597 | `/Users/lsm` |
| 4085 | `/Users/lsm` |
| 5856 | `/Users/lsm/focus/hyperneo-review/.claude/worktrees/landing-page-design-d6b2ac` |
| 6127 | `/Users/lsm/focus/hyperneo-review/.claude/worktrees/admin-user-ui-redesign-8486a1` |
| 6676 | `/Users/lsm/focus/open-agent-protocol/.claude/worktrees/epic-burnell-f7702d` |
| 6865 | `/Users/lsm/focus/open-agent-protocol/.claude/worktrees/open-agent-protocol-phase-design-6681c8` |
| 8131 | `/Users/lsm/focus/dolmen/.claude/worktrees/postgresql-pr-340-review-67f1b3` |
| 11159 | `/Users/lsm/focus/qlark` |
| 15886 | `/Users/lsm/focus/neokai/.claude/worktrees/neo-9076b001` |
| 16047 | `/Users/lsm/focus/neokai` |
| 16269 | `/Users/lsm/focus/neokai/.claude/worktrees/inspiring-poitras-d91438` |
| 17781 | `/Users/lsm/focus/hyperneo-review-test/.claude/worktrees/neo-e8b30c64` |
| 30959 | `/Users/lsm/focus/hyperneo-review-test/.claude/worktrees/neo-7284c909` |
| 31954 | `/Users/lsm/focus/neo-ios/.claude/worktrees/neo-feeed853` |
| 32722 | `/Users/lsm/focus/neokai/.claude/worktrees/neo-afcf4374` |
| 32844 | `/Users/lsm/focus/dolmen/.claude/worktrees/init-7f554d` |
| 35427 | `/private/tmp/claude-501/-Users-lsm-focus-hyperneo-review--claude-worktrees-admin-user-ui-redesign-8486a1/31f344ed-1b4b-42a5-a862-2e974da2f924/scratchpad/loginprobe` |
| 35951 | `/Users/lsm/focus/ops/.claude/worktrees/neo-27ad5504` |
| 38276 | `/Users/lsm/focus/money/.claude/worktrees/gracious-hamilton-c3de26` |
| 48122 | `/Users/lsm/focus/open-agent-protocol/.claude/worktrees/xenodochial-tu-552f79` |
| 51027 | `/Users/lsm/focus/open-agent-protocol/.claude/worktrees/chat-session-dd40c4` |
| 65628 | `/Users/lsm/focus/neo-ios` |
| 67150 | `/Users/lsm/focus/qlark/.claude/worktrees/neo-3ad0f1a8` |
| 67905 | `/Users/lsm/focus/neokai` |
| 80190 | `/Users/lsm/focus/money/.claude/worktrees/init-99705c` |
| 81989 | `/Users/lsm/focus/money/.claude/worktrees/lucid-pike-996a04` |
| 83125 | `/Users/lsm/focus/hyperneo-review/.claude/worktrees/gracious-solomon-e34a4d` |
| 90589 | `/Users/lsm/.hyperneo/Neo/.coordinators/neo-f384eb90-90a8-4316-8cd9-7c5688f3350b` |
| 95776 | `/Users/lsm/focus/hyperneo-review-test/.claude/worktrees/neo-3762954d` |
| 35429 | `/private/tmp/claude-501/-Users-lsm-focus-hyperneo-review--claude-worktrees-admin-user-ui-redesign-8486a1/31f344ed-1b4b-42a5-a862-2e974da2f924/scratchpad/loginprobe` |

Other live Codex executors/services from the process inventory (thread mapping unavailable): PID 4885: `/`; PID 12555: `/Users/lsm/focus/neo-ios`; PID 14357: `/Users/lsm/focus/neo-ios`; PID 67713: `/Users/lsm/.codex/worktrees/8725dd70/research`; PID 84658: `/Applications/ChatGPT.app/Contents/Resources`.
