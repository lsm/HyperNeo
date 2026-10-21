---
name: verify
description: Prove a HyperNeo change works by running an isolated daemon and web UI and driving it like a user. Use before saying a change is done.
---

# Verify HyperNeo

Run the change where a user would meet it: an isolated daemon, its RPC door and
its web UI. Lint, types and unit tests are not proof. Every helper named here
lives next to this file in `.claude/skills/verify/`. Run commands from the repo
root of your worktree.

## Explicit mid-turn Answered linking (handoff PR5)

```bash
RUN=$(mktemp -d /private/tmp/hn-answered-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-answered-linking.ts "$RUN" 9365
```

The actual SDK consumes the real Neo prompt generator, initially a synthetic
todo-event turn. While its first model request is running, two synthetic human
messages are stored and steered into that turn. The local scripted model reads
the daemon-generated `<human-input>` metadata from its actual request, then
calls `neo.publication.publish` through SDK/MCP using the second human trigger.
`observed.json` records requests, receipts and the durable publications. Both
human messages begin Received; the same status projection used by the chat UI
must show only the selected message Answered. The producer stays the todo event.
Reopening only the synthetic SQLite database and replaying the identical publish
must return the existing receipt without another publication. `evidence.json`
records this result and maximum heartbeat lag against 1 s. The helper closes
its SDK stream, queue, loopback model and database in `finally`.

On the failing reproduction commit, the actual model request has no daemon IDs
and both messages remain Received. Focused contracts also reject foreign,
nonhuman, unconsumed and older-turn IDs, keep initial and mid-turn content
unchanged, and prevent a selected answer from answering a different producer.
This proves the real SDK/MCP path and chat status projection, not GUI rendering
or a killed-process recovery. No real provider, credentials, live DB or 8399.

Also run the focused `neo-prompt.test.ts` unit contract: the root instructions
must stay under their existing 160-word budget. The online
`tests/online/convo/neo-publication-sdk.test.ts` checks the actual daemon/SDK
request: one exact daemon ID envelope, then the unchanged local-time and human
text blocks. Run that test with CI's Node Vitest runner and
`vitest.online.config.ts`, from `packages/daemon`, with `env -i`, a fresh test
HOME/data dir and TMPDIR. The Bun runner aliases `bun:sqlite` back into the
compatibility module and cannot run this online configuration; the standalone
mid-turn helper above runs directly under Bun. Both checks retain receipt replay.

## Worktree project resolution responsiveness

Use an owned fresh run directory; the helper requires its own HOME/data and port.

```bash
RUN=$(mktemp -d /private/tmp/hn-worktree-resolution-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worktree-resolution-lag.ts verify 9383 "$RUN"
```

The actual `work.find` RPC runs the real Codex adapter against a synthetic Codex
SQLite state and mirrors the resulting project into the isolated daemon database.
Its sole worktree has a `.git` FIFO: an independent Python writer waits until a
reader opens it, then releases a valid pointer after 1.4 seconds. An external
WebSocket client probes `system.health` while the read is pending. The returned
project must be the main repository, and the thread keeps its worktree location.
`observed.json` records response time, maximum main-loop lag and health latency.
The failing `reproduce` journey reports about 1,405 ms loop lag and 1,406 ms health
latency. After async resolution, the same journey reports about 1.7 ms lag and
0.56 ms health latency, while discovery still awaits the full storage delay.
All helper-owned clients, writer and daemon stop in `finally`. No real Codex
store, `.git` pointer, credentials, provider, GUI or port 8399 is used.

The focused `worktree-resolution.test.ts` also checks that concurrent and repeated
lookups of an unchanged regular pointer perform only one content read. Changed
metadata, a missing pointer, read errors and replacement must refresh/recover. Phase tests cover Codex SQLite open/configure/query/close,
worktree resolution, grouping and each adapter's async success/failure boundary.
Async worktree and adapter spans include awaits and are not exclusive main-thread
blocking time. The synthetic reproduction proves a concrete blocking hazard;
it does not attribute the historical 02:23:43 eight-second gap.

## Rules

- Never start, stop or mutate the human's daemon. Isolated runs never use port
  8399, `~/.hyperneo` or a copy of a real database. Journey 15 only reads logs.
- No provider key in the environment, real or fake. `launch.sh` starts from
  `env -i` with `NODE_ENV=test`, a temp `HOME`, and its own data dir and DB, so
  credential discovery is off and keys stay in that DB, never the keychain.
- Model turns go to a local mock of the Anthropic API (`mock-api.ts`, the same
  server CI's dev-proxy mode uses) on port 8000. Give the isolated daemon the
  dev-proxy key over RPC (step 3 below), never through its environment.
- GitHub is a stub: `gh` on the daemon's `PATH` answers `gh pr view` from
  `<run>/pr.json`, refuses everything else (including `gh auth token`) and logs
  every call to `<run>/evidence/gh.log`. Nothing reaches github.com.

## Neo animation stability (headless)

Build web, then Launch on a free non-8399 port with a fresh synthetic run directory.
In that same shell (with a stop.sh EXIT trap), run:

```bash
NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-animation-check.mjs 9378 "$RUN" verify
```

If Playwright's matching browser is unavailable, set `VERIFY_BROWSER` to an installed
Chromium executable. This always launches headlessly, never the desktop browser.
The helper validates the isolated daemon log, opens Neo over RPC, seeds 18 synthetic
publications in that DB and enables voice with a loopback endpoint. At desktop and
mobile widths it drives the real built `/neo` page, injecting only synthetic
`neo.working` events on its browser WebSocket, and starts/cancels a fake microphone.
It replaces browser analyser output with synthetic local audio levels; no transcription
or model turn is needed. Rail/message bounding boxes must not move, and observing the
rail and its children must receive zero resize callbacks during four busy toggles.
Voice sampling median must be below 25 ms, with over 60 samples in 1.8 seconds;
frame counts and p95 timing are recorded, not a hardware-independent FPS guarantee.
Evidence: `evidence/neo-animation-verify.json` and `neo-animation-{1280,390}.png`.
Before fixing, `reproduce` records 45 px message movement, four resizes, and about
50 ms audio sampling gaps on a 60 Hz browser. The focused VoiceWaveform suite also
drives synthetic 30/60/120 Hz timestamps to check refresh-independent sampling.
This proves web behavior under synthetic input; it does not verify iOS or 5G service.

## Recovery expiry responsiveness

Run a fresh isolated daemon without provider keys. The helper seeds 22,287
synthetic recovery records (22,269 consumed / 18 expired), matching the observed
production status counts, with no eligible expiry rows. It probes `system.health`
over the real WebSocket while the maintenance operation runs on the main DB.
The extra Python connection holds a synthetic WAL writer lock for 1.2 seconds.
It never opens the real DB. All helper-owned processes and the daemon close in
`finally`.

```bash
RUN=$(mktemp -d /private/tmp/hn-expiry-proof-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/recovery-expiry.ts verify 9335 "$RUN" expiry
```

`evidence/verify.json` must show covering-index checks, no expiry UPDATE during
the empty sweep, a health reply below 250 ms, and event-loop lag below 1 s.
After releasing the lock, it also expires an actual mapping and inbox request,
retaining the entire request and its existing reason. Unit boundary/status/
count/retention/upgrade contracts run only in CI. This proves the focused expiry
path, not the performance of every other writer in the daemon.

On the contract-test commit before the fix, `reproduce` with scope `full-tick`
records the recovery UPDATE blocking over 250 ms and the delayed health reply.
On fixed code, repeat `verify` with scope `full-tick` in another fresh directory:
its saved report can still fail because the following `space_external_events`
expiry performs an unrelated empty UPDATE under the same held writer lock.
Report that remaining failure explicitly; do not treat the focused expiry pass
as whole-tick acceptance. That wider contention fix is a separate item. A
controlled synthetic lock reproduces a possible cause; it does not identify the
writer responsible for an historical production event. No GUI or model turn is
part of this maintenance journey.

## Launch

```bash
cd packages/web && bun run build && cd ../..
.claude/skills/verify/launch.sh 9311 "$RUN"
```

- Pick any free port except 8399. `launch.sh` refuses a busy port, and refuses
  if 8000 (the mock API) is taken.
- `$RUN` is a fresh directory (default: a new `mktemp -d`). It holds `data/`
  (DB), `home/`, `bin/gh`, the logs, the pid files and `evidence/`.
- Ready signal: `ready: http://127.0.0.1:<port>  run dir: <run>`. The daemon log
  shows `HyperNeo Test Server` and `Database: <run>/data/daemon.db`.
- The daemon logs nothing in test mode. Set `VERIFY_LOG_LEVEL=error` (or `info`,
  `debug`) on `launch.sh` to see its errors in `daemon.log`.

Give it a model, once per run (stored in the run's DB only):

```bash
VERIFY_PORT=9311 bun .claude/skills/verify/rpc.ts rpc:providers.create \
  '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}'
```

### Neo home setup (journey 34)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-setup.ts <port> "$RUN"`.
The helper seeds only a synthetic git identity in the isolated HOME and a private
transcript, then invokes `neo.project.save` and `neo.home.init` over real RPC.
It expects one local bootstrap commit containing README, empty direction and
`.gitignore`; coordinator transcripts stay ignored. Repeating initialization and
renaming a project preserves HEAD and its assigned home path. The helper then
removes only its synthetic HEAD/index to force an identity failure: no bootstrap
files may remain staged, and configuring the identity must make retry succeed.
Evidence: `evidence/neo-home-setup.json`. Signing-failure recovery is checked with
an explicit false signer in focused unit tests, without real signing credentials.
This slice adds setup only; save/content checks and reads have later journeys.
It adds no command parser or native-tool hook policy. Filesystem/container limits
are the safety boundary. No provider, GitHub or GUI turn is part of this RPC check.

Repeat journey 34 on a fresh run with final argument `cleanup-failure` to
`neo-home-setup.ts`. A synthetic git shim makes reset fail after the commit fails
for missing identity. RPC must preserve the original author-identity error.
The helper records the remaining staged files, removes its shim, explicitly
unstages only its own fixture files, configures identity and verifies retry.
This fault mode does not claim that a failed cleanup left the index empty.

Repeat journey 34 on a fresh run with final argument `interrupted` to seed the
persisted state from interruption between add and commit: no HEAD and exactly
README.md, .gitignore and direction.md staged. The next real `neo.home.init` RPC
must finish one bootstrap commit without manual reset. This simulates the disk
state; it does not kill the daemon. Focused contracts retain refusal for other
staged files. Existing file contents survive recovery.

Repeat journey 34 with final argument `ignore-repair` on another fresh run. The
helper removes only its fixture ignore in a local commit, leaving an existing
home with untracked coordinator transcripts. `neo.home.init` must repair the
ignore, preserve transcript contents, track no transcript and leave clean status.
Other dirty files still require human review.

Repeat journey 34 with final argument `ignore-repair-failure` to force a missing
identity during ignore repair. After configuring identity, retry must create the
repair commit and leave clean status, preserving private transcripts. The gate
checks the committed ignore; failed repair restores its prior ignore contents
(or removes only the newly created ignore), removing newly created bootstrap
documents after a failed repair. Focused contracts cover both absent
and existing ignore files.

### Neo home save (journey 35)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-save.ts <port> "$RUN"`.
The helper seeds synthetic identity and transcript data, then calls the actual
`neo.home.save` RPC. First save creates the local bootstrap plus one document
commit, preserving leading spaces and trailing newlines. Repeating identical
content must return the same commit. Credential-like content, direction changes
and dirty human files must be refused without changing the document or HEAD.

A synthetic missing identity forces commit failure: the original document must
remain byte-for-byte intact and retry must succeed after configuring identity.
A read-only fixture directory forces an actual write-before-file-creation EACCES;
cleanup must preserve that error. An overlong filename must retain ENAMETOOLONG.
Evidence: `evidence/neo-home-save.json`. Focused contracts cover the other token
forms, ignored/internal/outside/symlink paths, concurrent saves and caller ownership.
No real credentials, remote, provider/model turn or GUI are used. Content checks
apply only to this operation; environment/filesystem limits must bound general
writes. Read behavior, human confirmation support and remote sync remain later
slices. Stop the isolated daemon and mock with `stop.sh`.

Repeat journey 35 in a fresh run with final argument `unicode` to
`neo-home-save.ts`. Unpaired surrogate input must return a Unicode content
refusal on both attempts, without a file or new commit. The helper then seeds
only a synthetic non-UTF-8 document and forces commit failure: rollback must
preserve every original byte and leave clean status. Valid Unicode is encoded
and compared as UTF-8 bytes; existing files are never decoded for rollback.

Repeat journey 35 in another fresh run with final argument `ignore-repair`.
The helper removes its fixture ignore in a local commit, then calls save with
untracked coordinator transcripts present. Save must repair the ignore and commit
the curated document while preserving and never tracking the transcripts.
Staged transcripts and unrelated human changes still cause dirty refusal.

### Neo home read (journey 36)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-read.ts <port> "$RUN"`.
The actual `neo.home.read` RPC must report an uninitialized home without creating
files. After explicit initialization, the helper seeds a human-edited direction
with a BOM, whitespace, non-BMP Unicode and 60,000 full lines. The entire text and
SHA-256 must match, without committing or changing that edit. Private/internal
paths and missing documents return typed refusals. Synthetic non-UTF-8 bytes must
be refused without returning replacement text or changing the source bytes.

Evidence: `evidence/neo-home-read.json` summarizes lengths, hashes and unchanged
HEAD/status; `neo-home-read-response.json` retains the full synthetic response.
Focused contracts cover project mandates, empty documents, ignored paths,
symlinks, caller ownership and serialization with save. This proves the local
RPC door, not a GUI or remote pull. It uses no provider/model, real credentials,
real DB or GitHub requests. H2 confirmation and H3 sync remain later slices.
Stop the isolated daemon and mock with `stop.sh`.

## Work names through supported harness APIs

```bash
RUN=$(mktemp -d /private/tmp/hn-rename-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=warn bun .claude/skills/verify/work-rename.ts verify 9385 "$RUN"
```

The helper boots a fresh isolated daemon with a synthetic Codex app-server Unix
socket and synthetic thread DB under its temporary HOME. `operations.describe`
must expose `work.rename`. Neo's real MCP adapter and WebSocket RPC rename only
the synthetic thread via `thread/name/set`; the fixture owns its synthetic DB
update and emits `thread/name/updated`. Subsequent `work.status` sees the name
without restarting. Synthetic HyperNeo, Space task and Space agent renames go
through the existing session lifecycle, task.update and agent.update APIs; the
session title is marked user-set to prevent automatic title replacement. A
synthetic Claude Desktop installation returns not_supported. Invalid multiline
titles must not reach Codex. RPC responses and peer calls are retained in
`evidence/observed.json`. On the reproduction commit, use `reproduce` instead:
it must show discovery has no rename operation. All owned servers and daemon
stop in finally. No human threads, real credentials, provider/model, private app
writes or port 8399 are involved. This proves daemon/MCP and protocol behavior;
actual Codex Desktop GUI rendering is not exercised.

## Codex send intent through a synthetic daemon

```bash
RUN=$(mktemp -d /private/tmp/hn-send-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=warn bun .claude/skills/verify/codex-send-intent.ts verify 9377 "$RUN"
```

The helper starts an isolated daemon and synthetic Codex Desktop IPC/app-server
Unix sockets under its fresh HOME. It uses real WebSocket `operation.invoke`
with the production Codex adapter. `work.adapters` must advertise steer for
Codex and omit it for HyperNeo; the subsequent explicit steer must return the
active turn receipt. The real `operations.describe` door must scope
strict steer guidance to Codex and direct HyperNeo/Space targets to auto. Owner discovery rejects with a synthetic
version mismatch while app-server has a steerable turn: default auto and explicit
steer must return `steeredIntoTurnId` without queueing. Explicit queue must return
`queuedSubmissionId`. Idle explicit steer must return `not_delivered` without
queueing; idle auto queues. An uncertain server steer must never also queue.
A Desktop-owned turn must steer through its owner; explicit Desktop refusal must
return `not_delivered` with its reason. Warning-level routing records, peer calls
and all RPC responses are retained in `evidence/observed.json`. Run `reproduce`
instead on the regression commit: it must queue without trying app-server steer.
No model, provider, credentials, real Codex state or GUI is involved. All owned
servers and the daemon close in finally. Pick a free port other than 8399.

### Home proposal questions (journey 37)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-question-confirmation.ts <port> "$RUN" after`.
The helper opens only a synthetic Neo session and seeds its own ask in its test
DB, then uses real `neo.question.ask`, `get` and local-human `answer` RPCs.
A yes/no proposal must retain `confirm:{path,sha256}` through creation and the
human answer. The visible body must include that exact path/hash; an incomplete
body is refused. Ordinary questions remain unbound. A protected `neo.home.save` without a question remains `confirmation_required`;
journey 38 exercises confirmed saves and the paired decision commit.

Evidence: `evidence/neo-question-confirmation-after.json`. Stop the daemon/mock,
restart only that same synthetic run, and run the helper with `restart`: its
saved question must retain the exact binding, answered state and human yes.
No provider/model, real credentials, GitHub requests or GUI are needed; a delivered
answer note may queue a turn with no provider, which is not model-execution proof.

For the upgrade reproduction, start on the contract-test commit before the
migration and use `before`. It records the old ask/get dropping metadata and
saves a legacy question id. After stopping those processes, boot the fixed code
against only that same owned synthetic DB and run `after`, then `restart`.
The legacy text/answer stays intact with a null binding; new proposals persist.
Repeat with `boundaries` to check that a path shown only as a longer filename or
inside another path, and a hash shown only in a longer hex string, are refused.
Exact path/hash tokens surrounded by Markdown/prose punctuation must be accepted,
including balanced italic, bold and strike markers; underscore filename suffixes
remain near misses.
`evidence/neo-question-confirmation-boundaries.json` retains every response.
The additive/idempotent legacy-answer migration contract runs in CI.
Never copy or alter a real DB for this journey. Stop with `stop.sh` afterwards.

### Confirmed home saves (journey 38)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-confirmed-save.ts <port> "$RUN" after`.
The helper seeds only a synthetic Git identity/ask/history in its own HOME and
DB, then uses real question ask/get/answer and home init/save RPCs. Missing,
open, no, wrong-path and wrong-hash confirmations must refuse without changing
HEAD or either file. A matching human yes must commit the exact mandate bytes
and append to its sibling decisions.md in one commit with the question trailer.
Root direction uses root decisions.md; focused contracts cover that path too.

The helper records question/get's answeredByHuman flag, both committed paths,
contents and trailer. An unchanged retry adds no decision. Removing only the
synthetic Git identity forces commit failure: both prior files and HEAD must
remain identical, the index clean, and configuring identity makes retry succeed.
Evidence: `evidence/neo-home-confirmed-save-after.json`. On the test-only commit,
use `before` in a separate fresh run to retain the matching-human-yes refusal.
No provider/model, real credentials, GitHub request or GUI is exercised. Stop
with `stop.sh`. Direct filesystem write restrictions still belong to the
surrounding environment; this verifies the single operation, not a shell sandbox.

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

### Private GitHub home proposal (H3 slice 2)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-github.ts <port> "$RUN" verify`.
The helper replaces only the isolated daemon's stub `bin/gh`. Its allowlist answers
auth status and the synthetic owner lookup; private creation connects and pushes
to a local bare Git repository. Every other GitHub command fails. Never run this
with the real HOME, remotes, credentials or GitHub executable on the daemon PATH.

The actual RPC must refuse missing/open consent before any create call, show the
daemon-bound repository in the question, accept its recorded human yes, and call
private creation exactly once. The initial commit must reach only the synthetic
remote, with upstream configured and clean status. Repeated proposal/application
calls return the stored receipt. Stop and restart this same isolated daemon, then
run the helper with `restart`: the persisted question/creation receipt must avoid
another external submission. Evidence: `evidence/neo-home-github-<mode>.json` and
`evidence/home-gh.log`.

In separate fresh runs, `decline` verifies human no stays local and reuses its
question, and `unavailable` verifies failed auth is probed once with no question or
creation. On pre-feature dev, `before` records the unknown-operation baseline.
Focused contracts additionally refuse agent answers, foreign/retired/unrelated
consent, replacement repository fields, existing origin and dirty files, and
reserve once across concurrent calls and an uncertain external failure. Such a
failure may have created the repository remotely: reconcile with the human rather
than replay creation. No actual GitHub creation, credentials, model or GUI are
verified. The first proposal is explicitly requested with the current root askId
after setup; re-proposal on a later human request, cloning and wake reads remain
later work. Stop the daemon/mock with `stop.sh` in the same shell as launch.

### Goal-cycle prompt delivery (P1)

Run the existing real SDK/publication journey with a clean synthetic HOME and a
loopback scripted model using the repeatable wrapper:

```bash
bash .claude/skills/verify/neo-goal-cycle-sdk.sh /absolute/fresh/run-dir
```

The wrapper refuses an existing run directory and clears the parent environment.
It creates its own HOME/tmp, places the GitHub stub first on PATH, and invokes the
focused online test. Both the daemon and scripted model use ephemeral loopback
ports; it uses no real keys, provider account, live DB or GUI. Its synthetic model
credentials point only at that in-process fixture. The test closes the transport,
daemon and fixture in finally.

`evidence/neo-goal-cycle-sdk.json` records the actual model-facing system prompt,
human input, tool receipts and the publication read back through RPC. The prompt
must include the core goal cycle (goal/facts/mandate reads, journal runId,
progress updates, human path/hash confirmation and the scheduled-only one-line
ending), even with coding guidance present. Focused unit contracts cover domain
packs disabled too, and keep NEO_ROOT_PROMPT under 160 words and unchanged.

The scripted model proves prompt delivery and publication plumbing; it does not
prove that an autonomous model follows the cycle, that it writes a correct
journal/mandate, or that a goal wake renders correctly. Those behaviors are not
claimed by this prompt-only check. On the test-only commit, the same wrapper in
another fresh run records the missing guidance before failing its delivery
assertions. Preserve both JSON files outside the run directory.

## Codex Desktop work.send journey

Codex work.send steers a Desktop-owned running turn. This journey uses
the real native IPC and the `invokeOperation` door used by Neo; it does not
automate the GUI or start a HyperNeo daemon. Use only a sacrificial thread
in a fresh temporary workspace, never a human's working thread. Run helpers
with `env -i HOME="$HOME" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin"
NODE_ENV=test bun .claude/skills/verify/codex-send.ts <action> "$RUN"`.
`prepare` creates and names the verification thread via the existing
app-server, archives/unarchives only that new empty thread to release its
runtime lock, and uses the existing Desktop handoff once. An unsubscribe
alone can leave the runtime loaded; a handoff failure is not a steer pass.
`start` starts another turn on that same Desktop-owned verification thread
via IPC without opening a window. Immediately run `send`, then `observe`
after the reply. End state: `send-result.json` has `delivered: true`, a
`steeredIntoTurnId` and no `queuedSubmissionId`; `acceptance.json` confirms
the matching turn completed with the requested token. On the old code,
`send` fails with a queue receipt and the token appears in a later turn
whose trigger is `queue`. `stop` interrupts only the verification thread
if cleanup is needed. No credentials are read; the installed app handles
its existing authentication. Keep the JSON evidence and state that GUI
rendering was not verified. After the turn completes, `fallback` confirms
an idle Desktop thread returns a queue receipt instead. Unit tests use fake
sockets and run in CI.

## Codex Desktop repo project registration

The Desktop project cache is distinct from app-server project storage. Creating
an app-server project alone is not proof that it appears in Desktop. The driver
uses Desktop's own `codex://threads/new?path=<repo root>` create/select entry when
no registered project exists, then reads its saved local-project registration and
legacy-to-server ID mapping before assigning the thread's `projectId`. It never
writes Desktop state directly. These are installed Desktop integration contracts,
not a documented public project SDK; recheck them after Desktop upgrades.

Manual check (no unattended GUI): keep Desktop running, have the human ask Neo
for a new Codex task in a repo absent from Desktop projects, and observe that the
repo is added and the thread appears under it. Confirm any Desktop folder-consent
dialog by hand. Open the thread and confirm its first reply renders without a
restart. Start a second task in that repo: there must still be one project. Keep
the thread IDs, project root and the human's result as evidence.

For the staged opening helper below, create the workspace first with
`mkdir -p "$RUN/workspace"`, then manually open
`codex://threads/new?path=<RUN>/workspace` to register it before running `prepare`. The helper refuses to open the registration URL automatically;
retry preparation after the human registered the workspace. Native create/select
and delayed registration are covered with fake launcher/state fixtures in CI.
The existing app-server-only prototype evidence does not verify this GUI journey.

## Codex Desktop opening journey (human-operated GUI)

Use `env -i HOME="$HOME" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin"
NODE_ENV=test bun .claude/skills/verify/codex-start.ts <action> "$RUN"` with a fresh
absolute temporary run directory. This helper starts no HyperNeo daemon, reads
no credential file, and never opens or drives a window. The installed Codex app
uses its own existing login for the single verification turn.

1. Run `prepare`. It uses the production adapter to create and name a sacrificial
   thread, captures its opening request, and deliberately pauses before handoff.
   `prepare-result.json` reports this intentional unconfirmed turn. `opening.json`
   records the actual text input; `text_elements` must be `[]`.
2. The human opens the printed `codex://threads/...` link in the already running
   Desktop. Run `start` only after that thread is open. It submits the captured
   request through the same native IPC follower-start interface as the driver,
   without an automatic `open` command. Do not restart Desktop.
3. The human checks that the thread displays `DESKTOP_OPENING_VERIFIED`, without
   “ChatGPT hit a snag”, and reports the result. Run `observe` to preserve the
   thread metadata and latest turn in `observed.json`. An accepted IPC request,
   backend completion, or a pure input-consumer check does not prove GUI success.
4. The human may archive only this verification thread afterward. Retain the JSON
   evidence and the human's result in the PR. Before the fix, the opening request
   lacks spans and Desktop's live turn continuation reader calls `.some` on
   undefined; reloading persisted history can conceal this failure.

## SDK message derived-column upgrade journey

Use synthetic bodies only. Before applying the column implementation, run
`NODE_ENV=test bun .claude/skills/verify/sdk-message-columns.ts seed "$RUN"`
then `inspect "$RUN"` with the same helper. The latter must fail because the
derived columns are absent. Seed records 11,000 messages, including full large
tool results and one malformed JSON row, plus a SHA-256 of the valid bodies.
The seed writes `replacement_metadata_normalized=1`, matching production writers
so the unrelated one-time legacy replacement reconciliation does not run.
Use a temporary HOME and `env -i` as in Launch; no real database is read or copied.

With this branch, run `upgrade "$RUN"`, then `inspect "$RUN"`, then `upgrade`
again. End state: all body bytes and the row count match the seed; metadata
matches the body, malformed JSON stays unchanged with NULL derived columns,
and the restart skips completed chunks. Keep the before failure, inspection,
startup lag and chunk logs. Numbered migration 413 adds the columns; the separate
`sdk_message_columns_backfilled_v2` marker records completion of the async pass.
Its cursor commits with each transaction; chunks yield after at most 512 rows
or 4 MiB, with a larger single message kept whole. No body is moved or trimmed.
Startup heartbeat covers the entire initialization, so distinguish existing
startup costs from measured chunk times and report any budget violation.

Then launch an isolated daemon as above and run
`bash .claude/skills/verify/sdk-message-columns-door.sh <port> "$RUN"`.
This sends through `message.send`, observes the same `messages.bySession`
subscription as the web transcript, and checks stored metadata/body agreement
read-only. Stop and relaunch that isolated daemon, then repeat with a distinct
third argument for the evidence name. Keep both RPC replies and feed snapshots.
GUI rendering is not covered; no real provider, credentials or GUI are used.
Filter characterization cases and assertions remain unchanged and run in CI;
their raw-SQL seed helper fills columns through the production derivation.

## SDK message repository filter journey

Run `NODE_ENV=test bun .claude/skills/verify/sdk-message-filters.ts seed "$RUN"`
on the pre-filter branch, then `measure "$RUN" before`. This generates 55,000
synthetic messages with full large tool results, production-derived columns and
`replacement_metadata_normalized=1`; it never copies a real database. Use an
empty temporary HOME and `env -i` as in Launch. On this branch, run
`measure "$RUN" after` against that same synthetic database. Initialization adds
the two typed eligibility columns and completes the existing backfill's v2 pass.
End state: receipt and full-body hashes match before/after, all per-query timings
stay below 250 ms and maximum event-loop lag stays below 1 s on this fixture.
Keep the logs and disclose any violation rather than calling it a pass.

Launch the isolated daemon on that run directory and run
`bash .claude/skills/verify/sdk-message-filters-door.sh <port> "$RUN"`.
It invokes `session.messages.byStatus` for consumed inputs.
End state: total 54,440, twenty messages in the original order, beginning with
`m-1` (the earlier `m-0` is a replayed tool result). Keep the RPC reply, compare
its ids/text/total to the synthetic repository receipt, then stop the daemon
and mock. Loading a session replays deferred input, so a live deferred count
cannot be compared to the offline receipt without controlling that lifecycle;
do not claim that check passed. Deferred selection is compared offline and
covered in CI. No GUI rendering is covered.

## SDK adapter/runtime filter journey

Use `sdk-runtime-filters.ts seed "$RUN"`, then `measure "$RUN" before` on dev
before the filter change. Use `NODE_ENV=test`, a clean temporary HOME and
`env -i` as in Launch. It seeds 55,002 synthetic messages through the production
derivation, including full large tool results, with
`replacement_metadata_normalized=1`. Run `measure "$RUN" after` on the branch,
then repeat as `measure "$RUN" restart`. Keep receipts, body hashes, query plans,
per-query times and separate startup/query maximum event-loop lag. Compare
the first index upgrade and completed restart separately against 1 s lag and
250 ms per query. No body is trimmed; a differing hash or exceeded budget fails
acceptance rather than being explained away.

Launch the isolated daemon on that run directory, run Doctor, then
`bash .claude/skills/verify/sdk-runtime-filters-door.sh <port> "$RUN"`.
End state: public `work.status` returns `runtime-filter-token`, the original
recent input and two ordered exchange entries, and `inputEvidence.state` is
`observed` for `last-human`. The helper compares these with the pre-change
receipts and saves both the RPC result and comparison. No provider or GUI is
needed. Keep the launch shell alive through Doctor and this helper if the
command executor stops background children when that shell exits; stop the
daemon and mock before ending the shell. Unit/contract suites run in CI.

## SDK live-query filter journey

Use a detached checkout of the pre-slice dev head under `~/focus/worktrees/`,
install its frozen dependencies, and copy `sdk-live-query-filters.ts` into its
verify directory. In that checkout run `seed "$RUN"`, then `measure "$RUN" before`
with the helper. Use `NODE_ENV=test`, a clean temporary HOME and `env -i` as in
Launch. The fresh synthetic DB has 55,014 messages, full large tool results,
production-derived columns/renderability/terminal flags and
`replacement_metadata_normalized=1`. Its archived synthetic Space prevents
background task execution; read-only feeds still expose its task and roster.

From the branch run `measure "$RUN" after`, then `measure "$RUN" restart`.
Keep body/receipt hashes, seven read results, query plans/times and separate
startup/query maximum lag. Receipts must match before/after; the helper fails
on body changes, lag >=1 s or a query >=250 ms. It covers repository reads,
background metadata, full/compact transcripts, the task feed and active roster.
Output shaping may shorten messages as it already does; stored bodies stay full.

Launch the isolated daemon, run Doctor and then
`bash .claude/skills/verify/sdk-live-query-filters-door.sh <port> "$RUN"`.
It uses the real `liveQuery.subscribe` door for both transcript variants, task
messages and active-turn entries. Every snapshot must match the pre-change
receipt, including ordered child messages and background metadata. Evidence is
the four RPC replies plus `rpc-feed-comparison.json`. No provider or GUI is used;
GUI rendering is not verified. Keep the launch shell alive through the helper
and stop the daemon/mock before it exits. Remove the baseline worktree after
capturing its receipts. Contract/unit tests run in CI, including late child
arrival and removal when its parent leaves the selected window. After stopping
the daemon, run `measure "$RUN" post-door` again: startup can update SQLite
statistics and change a previously fast plan. Migration 417's covering window
index must keep that read bounded after those statistics updates too.

## Doctor

```bash
.claude/skills/verify/doctor.sh 9311 "$RUN"
```

Read-only. It checks test mode, that the DB is inside the run dir, that the web
UI is served, that RPC answers, and that the mock model API is up. It ends with
`usable` or `not usable`.

## Drive

- RPC: `VERIFY_PORT=<port> bun .claude/skills/verify/rpc.ts <operation> '<json>'`
  invokes an operation; `rpc:<method>` calls a plain RPC method. A third
  argument keeps the socket open that many seconds and prints the events that
  arrived.
- State: read the run's DB read-only, e.g.
  `sqlite3 -readonly "$RUN/data/daemon.db" "SELECT ..."`. Only the seed and
  check scripts write to it: `seed-todo.sh`, `todo-pr-claims.ts`, `todo-pr-concurrency.ts` (journey 3) and
  `seed-ledger.sh` (journey 4),
  `merge-check.sh` (journey 24), `archive-guard-check.sh` (journey 10) and
  `seed-start-question.sh` (journey 14), `quote-summary-check.mjs` (journey 18),
  `seed-schedule-interrupt.ts` (journey 22), and `external-reply-check.ts` (journey 23).
- Web UI: open `http://127.0.0.1:<port>/neo` (Neo) or
  `/session/<sessionId>` (a session) in the browser; read the page text and take
  a screenshot.

## Journeys

Each ends in a state a user can observe. A feature that adds a user-facing path
adds its journey here.

1. **A human message reaches root Neo, which answers.**
   `neo.open {}` returns root's `sessionId`; send
   `neo.message.send {"sessionId":"<root>","requestId":"<uuid>","content":"Is the web header fix merged?"}`.
   End state: `sdk_messages` for root holds the user message (with its local-time
   line) and, within ~25 s, an `assistant` and a `result` row from the mock. The
   mock returns plain text, so no publication is written; a publication needs a
   scripted model (see `tests/online/convo/neo-publication-sdk.test.ts`).
   For the root visibility prompt experiment, run that focused online test with a fresh
   temporary HOME and `env -i` as documented in `packages/daemon/tests/online/README.md`.
   It starts its own isolated test daemon and loopback scripted model, checks the assembled
   `neoPrompt()` reaches the real SDK, and reads back the exact publication through RPC.
   The final prompt block must keep ordinary turns silent, using publish/question for
   the human, while scheduled goal wakes alone end in a one-line wake-row label.
   The root prompt still has its word-cap unit test.
   This proves prompt delivery and publication plumbing, not a generative model's choice
   to publish or stay silent. Without a permitted local model, report that behavior as
   unverified; do not use live credentials or treat the script as behavioral acceptance.
2. **Voice streaming relays text.** Start the stub ASR (Deepgram protocol) with
   `bun .claude/skills/verify/asr-stub.ts 9312 < /dev/null > "$RUN/asr-stub.log" 2>&1 & echo $! > "$RUN/asr-stub.pid"`, then
   `VERIFY_PORT=9311 bun .claude/skills/verify/voice.ts 9312`. It points voice at
   the stub, starts a stream, sends three chunks and stops. End state: `started.via`
   and `stopped.via` are `streaming`, `stopped.text` is the final text, and
   `texts` holds the interim `voice.stream.text` events and one `isFinal`.
3. **A coding todo completes on merge.** After journey 1 opened root, run
   `.claude/skills/verify/seed-todo.sh "$RUN"`. It writes an open ask for root
   with a `doing` todo whose check is `pr_merged` and whose report names
   `https://github.com/verify-test/demo/pull/8`, and a `$RUN/pr.json` that reads
   that PR as `MERGED`. End state within ~3 min (one driver refresh plus the
   2-minute check window): the todo is `done` with evidence `#8 merged`,
   `evidence/gh.log` shows the `gh pr view`, and root's transcript holds the note
   `Todo "Fix the loader" is done: #8 merged`.
   Settling done waits for the todos: right after seeding,
   `rpc.ts neo.ask.settle '{"askId":"ask-verify","status":"done","outcome":"Shipped."}'`
   replies `todos_unfinished: … "Fix the loader" (todo-verify, doing).` and the ask
   stays `open`; the same call after the todo is `done` settles the ask `done`.
   To verify PR ownership and URL edits, run
   `bun .claude/skills/verify/todo-pr-claims.ts <port> "$RUN"` on a fresh isolated
   daemon. It seeds only this run's ask, URL-less session todo and coding ledger
   claim, then uses the real `neo.todo.add/edit/remove` RPC door. End state: adding
   a duplicate refuses with the existing todo id/title; `addUrls` pins the PR on
   that original; a competing edit refuses it. The helper marks the stub PR merged
   and waits up to 210 seconds for the coding pack to finish the original without
   a manual close. Evidence: `evidence/todo-pr-claims.json` includes RPC receipts,
   stored merged evidence and the Neo snapshot; `gh.log` shows stub-only lookups.
   No real PR, provider, credentials or GUI is used; model notifications use the
   local mock and this run's dev-proxy provider row. GUI rendering is not verified.
   In another fresh run, execute
   `bun .claude/skills/verify/todo-pr-concurrency.ts <port> "$RUN"`.
   It overlaps a completion check awaiting GitHub with 20 URL additions on that
   same todo. Every URL must remain in its check; the stale completion is refused
   and the todo remains open. Repeat in fresh run directories with a final
   argument `edit`, `close`, and `sweep` to cover plain completion, closure and the
   real periodic background check. Each mode pauses the local gh stub after its
   check starts, adds 20 URLs through RPC, then releases the old result. None may
   finish the todo. The sweep mode can take up to 3 minutes to begin.
   Evidence: `evidence/todo-pr-concurrency.json`.

4. **An open todo's PR leads the PR ledger in the snapshot.** After journey 1
   opened root, run `.claude/skills/verify/seed-ledger.sh "$RUN"`. It writes a
   project for `verify-test/demo` (so the pack sweep keeps its ledger rows), an
   open ask with a `doing` todo that owns `verify-test/demo#8` (and was once
   branch-matched to `#100`), and 120 older open ledger rows in the same repo.
   End state: `rpc.ts neo.snapshot '{}'` returns `packRows` whose first coding
   row is `verify-test/demo#8` with `todoId: "todo-ledger"`, its state and its
   owner, even though the ledger lists only its 100 oldest rows otherwise, and
   `#100` carries no `todoId`.
5. **The web UI renders.** `/neo` shows the conversation with the human message
   marked Received; `/session/<root>` shows root's transcript, including the
   mocked replies and the todo note. The session view takes a few seconds to
   load; wait for the transcript before the screenshot.

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

7. **A cross-repo request becomes one card per repo.** Launch with
   `VERIFY_MOCK=neo-script-api.ts .claude/skills/verify/launch.sh 9311 "$RUN"`.
   That mock plays root's model: when the human's message contains
   `verify-cross-repo`, it calls `neo.ask.open` with todos for two repos
   (`lsm/HyperNeo` and `lsm/open-agent-protocol`). Open root, then send
   `neo.message.send {"sessionId":"<root>","requestId":"<uuid>","content":"Attach the open PRs (verify-cross-repo)"}`.
   End state within ~20 s: `neo_asks` holds the request card `done` with outcome
   `Filed 3 todos across hyperneo, open-agent-protocol cards.` and two open
   child cards, `Attach open PRs · hyperneo` and `· open-agent-protocol`, each
   with only its repo's todos (`neo_todos.repo`). On `/neo`, "Your work" lists
   the two child cards, and Recent outcomes shows the request as Done with that
   outcome under Details.
8. **A todo whose PR lands in another repo moves to that repo's card.** After
   journey 1 opened root, run
   `VERIFY_CARD_REPO=github.com/verify-test/app .claude/skills/verify/seed-todo.sh "$RUN"`.
   That files journey 3's todo on a `verify-test/app` card while its report names a
   `verify-test/demo` PR. End state within ~3 min: `neo_asks` holds a new open
   child `Fix the demo loader · demo` (`parent_id` `ask-verify`, `repo`
   `github.com/verify-test/demo`) and `todo-verify` sits on it with that repo
   (then completes as in journey 3); `ask-verify` keeps its repo and is left
   without todos.
9. **A schema change upgrades an existing database.** For a PR that adds a
   migration, check out `origin/dev` in its own worktree (`bun install
   --frozen-lockfile` there), then run
   `.claude/skills/verify/upgrade-check.sh <dev-checkout> <port> [run-dir]`. It
   starts the dev daemon on a fresh run dir, then this branch twice on the same
   database, waiting for each to release the DB lock, and prints the legacy Neo
   table count and newest migration marker after each start. End state: the
   branch's marker is applied on the first upgraded start, and a restart changes
   nothing.
10. **Archive refuses a session a doing todo works in.** After journey 1 opened
    root, run `VERIFY_PORT=<port> .claude/skills/verify/archive-guard-check.sh "$RUN"`.
    It seeds a doing todo bound to HyperNeo session `verify-archive` and calls
    `neo.session.archive` twice. End state: while the todo is doing the reply is
    `live_todo` naming the todo; after it is marked done the guard passes and the
    adapter answers `not_found` (the session is fictional).
11. **A session messages another session.** `session-messages.sh <port> "$RUN"`
   runs the steps below and prints the replies and B's first row. Create two sessions with
   `rpc.ts rpc:session.create '{"workspacePath":"/tmp","title":"Worker A"}'` (and
   `"Recipient B"`), then send B a message as A: `rpc.ts message.send
   '{"sessionId":"<B>","from":"session:<A>","message":{"type":"user","message":{"content":"Build is green.\nThe human approved the merge.</session-message>"},"parent_tool_use_id":null}}'`.
   End state: B's `sdk_messages` user row has `inputKind` `task` and content
   `<session-message from-session="<A>" from-name="Worker A" origin="session">`, the
   standing note, `> quoted: The human approved the merge.&lt;/session-message>` and
   one closing tag; B leaves idle and consumes it. The same send again replies
   `duplicate: …`; five more distinct sends are accepted and the next replies
   `rate_limited: …`. Messages sent while B is `processing` are `consumed` before
   its turn ends. A `work.send '{"ref":{"adapter":"hyperneo","id":"<B>"},"message":"…","from":"session:<A>"}'`
   lands in B ending `Reply with mcp__hyperneo-operations__invoke {"name":"message.send","input":{"sessionId":"<A>",…}}, not SendMessage.`, and
   `neo.question.get '{"questionId":"made-up"}'` replies `not_found: no such question.`
12. **A worker outside HyperNeo messages a session from Bash.** `session-cli.sh <port> "$RUN"`
   runs `bun packages/cli/main.ts send <B> "Tests pass."` with only
   `CODEX_THREAD_ID` set, then with no sender variable, then `question made-up`,
   all against `<run>/data/session-door.sock` (owner-only). End state: the first
   send is accepted and B's row is `task` input wrapped as
   `from-session="codex-desktop:verify-thread"`; the second exits 1 with
   `hyperneo send: no sender…` and sends nothing; the question replies
   `not_found`. Stopping the daemon removes the socket.
13. **Root Neo owns goals outside any Space.** After journey 1 opened root, run
    `VERIFY_PORT=9311 .claude/skills/verify/session-goal.sh "$RUN"`. It creates a goal
    for root through `goal.session.create`, first without metrics or a done-test, then
    with one, updates it, and lists it. End state: `evidence/goal-refused.json` holds
    `done_test_required`; `goal-list.json` lists "Grow OAP" at progress 40 with its
    done-test, mandate link and next step; `goal-events.txt` reads `created|human`
    then `updated|human`. The script then appends a journal entry twice for the same
    run: `goal-journal.json` holds one entry for `run-1`, with the second effect
    ("Three projects asked for it") and the PR as evidence.
14. **A start question lists only todos that can still start.** After journey 1
    opened root, run `.claude/skills/verify/seed-start-question.sh "$RUN"`. It
    writes `ask-prune` with two todos awaiting start, `todo-a` (check
    `pr_merged` on `verify-test/demo#8`, which reads as `MERGED`) and `todo-b`
    (no check), and one open start question `q-start` listing both. End state
    within ~3 min: `todo-a` is `done` with `started_at` empty, and `q-start`
    is still `open` with `start_todos` `["todo-b"]`.
15. **A session with no registered provider fails once and says why.** A fresh run
    dir has no provider records, so Anthropic is not registered there. Launch with
    `VERIFY_LOG_LEVEL=error`, then run
    `VERIFY_PORT=<port> .claude/skills/verify/missing-provider-check.sh "$RUN"`. It
    sends one message to root Neo and waits for its delivery job to settle. End
    state: the job is `dead` with `retry_count` 0 and the error `Provider
    'anthropic' is not registered. Log in or add an API key for it under Providers,
    or switch this session to another provider.`, the message is `failed`, and
    `daemon.log` has that one `[ErrorManager] model` entry.
16. **Neo's messages to its workers show in Neo's conversation; theirs to Neo do not.** Run
    `.claude/skills/verify/neo-session-rows.sh <port> "$RUN"`. It opens root, creates
    a worker session "Fix the loader", and sends one message each way. End state: it
    prints only `Neo -> Fix the loader: Rebase on dev, then tell me.` for both
    `neo.conversation.read` and the snapshot's `sessionMessages`; the worker's
    `Rebased.` is still delivered to root but is not a row. On `/neo` Neo's message
    shows as one collapsed row "Neo → Fix the loader" with its first line.
17. **Neo or the user schedules a session wake.** `session-schedules.sh <port> "$RUN"`
    creates a session and calls `schedule.session.*` as the local user. End state: a
    1-second cadence replies `invalid_cadence`; an hourly reminder is `active` with
    one pending `sessionSchedule.fire` job an hour out and appears in `list` for that
    target; `pause` makes it `paused` and drops the job; `resume` makes it `active`
    with a new job; `delete` removes the row and its job. Journey 20 verifies delivery.
18. **Reply quotes show the same summary in the composer and after sending.**
    After opening root and configuring the mock provider, run
    `NODE_PATH=<directory containing playwright> node .claude/skills/verify/quote-summary-check.mjs <port> "$RUN"`.
    If Playwright's browser is not installed, set `VERIFY_BROWSER` to a Chrome
    executable; it runs headless with a fresh browser context. The check seeds
    a publication in the isolated run DB with different short and detailed text,
    then replies through the visible footer button and the context menu, types
    and sends a reply, and waits for the durable message rather than its pending
    preview. End state: all four quote previews show only the short summary;
    `evidence/quote-summary.json` records the observed strings, with composer
    and sent-message screenshots for both paths. To retain before/after proof,
    pass an evidence name as the third argument. Keep the launch shell alive
    while driving the UI if your command executor stops background children
    when the launching command exits.
    Repeat with `VERIFY_QUOTE_LONG=1` to seed a 350-character summary: composer
    and durable quote must both show the stored 300-character excerpt plus an
    ellipsis. The daemon and web share this excerpt rule; detailed message text
    remains available through Details and Copy.

19. **Daemon performance has a repeatable read-only tally.** Run
    `bun scripts/daemon-lag-tally.ts <log> [--timestamps <jsonl>] [--since <ISO>] [--until <ISO>]`.
    It accepts timestamped console lines or JSONL directly. The laptop console
    log has no timestamps, so use its structured mirror to date the matching
    lag-event suffix, never the file's modification time:

    ```bash
    UNTIL=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    SINCE=$(bun -e 'console.log(new Date(Date.parse(process.argv[1])-86400000).toISOString())' "$UNTIL")
    bun scripts/daemon-lag-tally.ts ~/.hyperneo/logs/laptop-daemon.log \
      --timestamps ~/.hyperneo/logs/daemon.jsonl --since "$SINCE" --until "$UNTIL"
    ```

    End state: Markdown tables show UTC daily block counts, watchdog unresponsive
    counts, worst block, and each day's SQL groups ranked by total blocked time.
    SQL literals and bind parameters use the existing storage normalizer.
    `no SQL` means no slowest statement was logged; it does not prove pure JS.
    Blocked durations are attributed to the accompanying SQL label, not measured
    SQL time. Watchdog notices can describe the same incident as a later block;
    their durations are not added to blocked time. SQL labels may already be
    truncated by the logger. These records cannot prove every hot query is under
    250 ms; inspect `sqlite.query.slow` separately for that goal.

    Window bounds are inclusive `since`, exclusive `until`, with timezone required.
    Undated events are shown separately without bounds, or counted as excluded
    with bounds. A mismatch between console and JSONL event suffixes fails rather
    than guessing dates; use matching snapshots or pass JSONL directly. Save the
    output and exact window as evidence, and disclose missing timestamp coverage.
    No database or credentials are opened, and no daemon is launched or changed.
    Synthetic CI coverage lives in `tests/unit/lib/daemon-lag-tally.test.ts` in
    the daemon package; run just that file locally.

20. **A due session reminder wakes its recipient as a daemon note.** Register the
    mock provider from Launch, then run `bun .claude/skills/verify/session-schedule-fire.ts <port> "$RUN"`.
    It creates a session and a one-minute reminder through RPC and waits up to 80 s.
    End state: the session transcript contains one `<daemon-note kind="scheduled_wake">`
    with the reminder text and system input, without a
    session-message envelope. `neo_input_origins.trigger_id` stores `scheduled_wake:`
    followed by JSON with `scheduleId`, `sourceKind`, and `sourceId`; the mailbox
    keeps that origin while SDK storage normalizes synthetic input to `system`.
    The schedule reports `fired`, a message id, zero due
    count, a facts digest and its next cadence; the helper pauses it after capturing
    `evidence/session-schedule-fire.json`. Open that session's transcript and capture
    a screenshot. Busy/needs-you/unchanged skips, nudge counting, source removal and
    pause races are covered by the focused session-schedule-fire unit suite.

21. **Closed schedule targets complete without a false fire.** Run
    `bun .claude/skills/verify/session-schedule-targets.ts <port> "$RUN"` against an
    isolated daemon. No model turn is needed. It creates one target and two
    one-minute reminders, archives that target through RPC, and points the other
    reminder at a missing session. End state: both schedules are `done` with
    `last_outcome = target_gone`, no pending job and no message delivery; the fire
    jobs complete without retries. Evidence: `evidence/session-schedule-targets.json`.
    The helper deletes its schedules after capturing evidence. The focused delivery
    suite also checks a target archived during source lookup and an interrupted
    external send: that occurrence is durably reserved before `work.send`; retry
    skips it as `skipped_delivery_unconfirmed`, retaining its due count and digest.
    This gives external adapters at-most-once submission per occurrence: a crash
    before submission may miss that occurrence, and a later cadence can try again.
    Real external-adapter delivery is not verified by this journey.

22. **Interrupting an open session preserves its schedule.** Run
    `bun .claude/skills/verify/seed-schedule-interrupt.ts <port> "$RUN"` against an
    isolated daemon. The helper checks the test-mode log and database path before
    seeding a user-interrupted processing state on its newly created session.
    `work.status` reads `stopped`, but the due reminder must read `active` with
    `skipped_busy`, due count 1 and a future cadence through `schedule.session.list`.
    No message is delivered. Evidence: `evidence/session-schedule-interrupt.json`.
    The helper deletes its schedule after capturing evidence. The focused delivery
    test also returns the target to idle and observes a fired reminder on its next
    cadence. Stopped adapters with unknown lifecycle skip busy; local ended/archived
    targets are recognized from their session row and still complete as target_gone.

23. **An external worker can report progress to its sending Neo mid-work.**
    Run `RUN=$(mktemp -d /tmp/hn-reply-XXXXXX)` then
    `bun .claude/skills/verify/external-reply-check.ts <free-port> "$RUN"`.
    It refuses 8399 and a busy port, starts a real isolated daemon in test mode
    with an empty environment and its own HOME/DB, and registers a synthetic
    Claude Code peer on a private Unix socket. No provider, mock-model port or
    GUI is needed. The script seeds only this run's ask/todos/start questions,
    then answers the start questions through real RPC so the todo runner sends
    its instructions through the native Claude inbox transport.

    End state: `$RUN/observed.json` records the worker's actual incoming frames.
    The first instruction includes `hyperneo send <the actual root Neo id>
    "<text>"`; an instruction already containing that line has one copy; a
    human-origin send has none. The script then runs the real CLI with a
    the synthetic Claude peer's sender identity and checks read-only that its progress
    message reached that Neo's transcript. It stops its daemon and closes its
    peer socket even when an assertion fails. Save `observed.json` and the
    console output as before/after evidence, then remove the run directory.
    This proves real RPC/todo/inbox/CLI delivery with a synthetic peer, not
    Claude Desktop or Codex Desktop GUI rendering; those routes and direct
    `work.send`/`work.start` are covered by the daemon unit tests.


24. **Projects never merge on their own.** After journey 1 opened root, insert two
   `neo_concerns` rows whose `repo:` aliases in `neo_project_workspaces` name the
   same repository, then call `rpc.ts neo.projects.reorganize '{}'`. End state:
   the reply has no `merged` field, both projects remain, `neo_project_merges` is
   empty, and the `repository:` identity belongs to the older project. To see what
   the cleanup would do on a real daemon without touching it, run
   `bun .claude/skills/verify/cleanup-dry-run.ts [db]` (read-only; defaults to
   `~/.hyperneo/data/daemon.db`): it prints the planned deletes, and any merge it
   lists runs only with `apply: true`. To see an explicit merge carry its asks,
   run `VERIFY_PORT=<port> .claude/skills/verify/merge-check.sh "$RUN"`: it seeds a
   `Web` home with a `repository:` alias and a same-titled copy holding a done ask
   whose todo names another repo, then calls `neo.projects.reorganize {"apply":true}`.
   End state: `neo_project_merges` has `project:web-copy → project:web`, `ask-merge`
   now has `project_id` `project:web`, and `todo-merge` keeps
   `github.com/verify-test/other`.

25. **A blocked daemon tick identifies recent work without logging message bodies.**
    Run the same production diagnostic attachment on an isolated test daemon:

    ```bash
    RUN=$(mktemp -d /private/tmp/hn-lag-attribution-XXXXXX)
    env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
      bun .claude/skills/verify/lag-activity-check.ts 9344 "$RUN"
    ```

    This uses a new synthetic DB and a real WebSocket RPC whose test-only handler
    blocks for 1.35 s. It never registers that handler in production. The helper
    explicitly attaches the production monitor because test mode skips the
    watchdog that normally arms it. End state: `$RUN/observed.json` contains the
    unchanged lag line, matching incoming/outgoing RPC names and periodic phase
    timing, before/after heap fields, runtime GC coverage and sampler latency.
    A phase from a previous tick and a private RPC body marker must be absent.
    The helper stops its daemon and monitor in `finally`; it starts no model,
    browser or real credentials. Heap latency is measured on its synthetic heap;
    real-heap overhead is guarded by the runtime 1 ms sampling budget.
    See [the phase inventory](lag-phase-inventory.md) for timer defaults and
    diagnostic limits. A recent activity is correlation, not proof of cause;
    asynchronous phase duration includes awaits. This journey proves diagnostic
    output, not the cause of any real laptop block. Live logs remain read-only.


27. **A session goal owns a fact-driven wake and its asks.** Launch a fresh run with
    `VERIFY_MOCK=neo-script-api.ts`, register the synthetic provider from Launch,
    then run `bun .claude/skills/verify/goal-schedule.ts <port> "$RUN"`. It creates
    an hourly-capable goal with a one-minute cadence for verification. The mock
    model calls `neo.ask.open` through the real MCP door with that `goalId`.
    End state: `evidence/goal-schedule.json` contains the linked ask, a delivered
    `<daemon-note kind="scheduled_wake">` in root Neo's transcript with mandate
    and journal run identity, the exact same digest from `goal.facts`, and an
    empty summary after delivery. Reading facts twice before delivery preserves
    the delta. Updating progress to 40 produces only `- Progress: 0` and
    `+ Progress: 40`. Pausing removes the job, resuming restores it, and completing
    the goal removes its schedule and returns null facts. Run
    `NODE_PATH=<directory containing playwright> node .claude/skills/verify/goal-schedule-view.mjs <port> "$RUN"`
    to open the root session transcript headlessly and capture
    `evidence/goal-schedule-transcript.png`. Keep the `neo:` colon unescaped in
    the session route; the router does not decode a percent-encoded session id.
    CI covers foreign-goal rejection, failed/unconfirmed delivery, unchanged
    nudges, linked question/PR changes, repository splits and migration reruns.
    Missing and closed Neo targets finish `target_gone`; open interrupted Neo
    targets remain active with `skipped_busy` and can fire when idle. Delivery
    rechecks closure after facts load, so a closing target receives no wake.
    No real model, external PR or desktop GUI is exercised. Mandate reconciliation
    and what-works compaction belong to G8.
    To check close/reopen settings without a model turn, run
    `bun .claude/skills/verify/goal-reopen.ts <port> "$RUN"`. It creates a daily
    09:00 UTC cron with nudge interval 7, closes and reopens it as both completed
    and archived, and asserts that the configured schedule returns each time.
    Evidence: `evidence/goal-reopen.json`. Restart the isolated daemon and repeat
    with the saved goal id as the third argument to prove persistence across
    process restart. Wake preferences are stored on the goal; closing still
    deletes its schedule row.
    Run `bun .claude/skills/verify/goal-target-return.ts <port> "$RUN"` against a
    fresh isolated daemon to check owner recovery. It archives its new session,
    waits for the real cadence to finish `target_gone`, restores the session
    through RPC, and pauses/reactivates its goal. The restored schedule must keep
    its configured cadence/nudge interval and deliver its next wake to that
    session's transcript. Evidence: `evidence/goal-target-return.json`.
    Run `bun .claude/skills/verify/goal-unreadable-state.ts <port> "$RUN"` in
    another fresh isolated run to check a malformed processing-state fixture.
    The helper validates its test DB, seeds unreadable state only on its new Neo,
    and waits for the real goal cadence. The schedule must record `fired`, deliver
    its wake and enqueue the next cadence without a job error. The fixture is
    restored in `finally`. Evidence: `evidence/goal-unreadable-state.json`.
    To check completion during fact collection, create a fresh `$RUN` and run
    `env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test bun .claude/skills/verify/goal-close-race.ts <free-port> "$RUN"`.
    This helper owns its daemon and needs no mock model. A test-only source wrapper
    completes its goal through real RPC between the fact snapshot and rendering.
    The renderer must return source-gone, with no exception or wake delivered.
    Evidence: `evidence/goal-close-race.json`. Its daemon stops in `finally`.

29. **Scheduled wakes are part of the conversation contract (G5a).** Launch a fresh
    isolated daemon, then run `bun .claude/skills/verify/neo-wake-contract.ts <port> "$RUN"`.
    The helper validates the test DB and seeds synthetic delivered inputs through
    the production repositories, including all five addition kinds. The real
    `neo.conversation.read` and `neo.snapshot` RPCs must expose the same wake.
    Inputs are enqueued and consumed through production APIs and terminal results
    use the production response-origin stamp; no sequence is rewritten. Only the
    self-origin scheduler delivery creates a wake; question/recovery continuations
    inherit metadata without creating duplicates. A recovered or steered turn's
    terminal settles its recorded wake. A different turn must neither settle an
    unfinished wake nor replace its closing line. Unstamped legacy results use the
    next independent consumed input as a boundary. The raw daemon note
    is absent from the public output. Evidence: `evidence/neo-wake-contract.json`.
    This checks the API with synthetic recorded turns, not model behavior or the
    web disclosure row; G5b adds the rendering journey. Stop with `stop.sh`.

30. **Scheduled wakes are quiet web disclosures (G5b).** Build the web and launch a
    fresh isolated daemon. Run `bun .claude/skills/verify/neo-wake-web.ts <port> "$RUN"`
    to seed synthetic active, settled-with-additions and settled-empty wakes, then
    `NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-wake-web.mjs <port> "$RUN"`.
    Like journey 18, `VERIFY_BROWSER` can select a headless Chrome executable.
    `/neo` must show closed clock/title/summary/time rows; the active one reads
    Working. Attributed publication detail appears once, inside its wake. The publication link must resolve to its rendered article (recorded in
    `neo-wake-{desktop,mobile}-publication-link.json`). Opening
    the row exposes labelled additions; following its question link reveals the
    original question in Your work on desktop and in the mobile sheet. A removed
    todo link opens its owning ask’s Details before scrolling to the retained row. Questions
    remain independently answerable; journal labels are text until G6 supplies a
    journal destination. Screenshots `neo-wake-{desktop,mobile}-{collapsed,expanded,question}.png`
    and observed text `neo-wake-web.json` live in `evidence/`. No model turn, real
    provider, real data or desktop GUI is exercised. Stop with `stop.sh`.

    For history folding, use another fresh isolated run. Seed with
    `bun .claude/skills/verify/neo-wake-pagination.ts <port> "$RUN"`, then run
    `NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-wake-pagination.mjs <port> "$RUN"`
    (`VERIFY_BROWSER` works here too). Its 51 retained publications put the wake
    just outside the initial history window. Clicking Load earlier folds the
    topmost publication into its newly visible closed wake; that wake must retain
    the publication's viewport position on desktop and mobile. Closed descendants
    can report nonzero cached rectangles in Chrome, so visibility is determined
    by the disclosure, not height alone. Repeated already-rendered text isolates
    folding from unrelated later Markdown reflow; that reflow is not fixed here. Evidence: `neo-wake-pagination.json`
    and `neo-wake-pagination-{desktop,mobile}-{before,after}.png`. Stop the run.

## Evidence

### SDK message body dual write (slice 6)

Use a fresh synthetic corpus and an isolated daemon on a free non-8399 port:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-body-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-live-query-filters.ts seed "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-dual-write.ts 9332 "$RUN"
```

The seed uses production `deriveSdkMessageColumns` and
`replacement_metadata_normalized=1` on 55,014 synthetic historical rows. The
helper starts the real daemon, writes complete 700,000-character tool results,
updates result flags, then calls `session.create`, `message.send` and
`liveQuery.subscribe` over WebSocket. It waits for asynchronous mailbox
materialization before inspecting the body copies. It deletes one synthetic
message through SQL to check follow-delete cleanup and retains another tool
result byte-for-byte. No production deletion or retention policy is added.

End state: `evidence/observed.json` records equal body hashes across a full daemon
restart, unchanged historical body hash, identical transcript rows/metadata,
query timings and 10 ms heartbeat lag. LiveQuery's in-memory version resets on
restart and is excluded from content equality. `rpc-before-restart.json` and
`rpc-after-restart.json` retain the full actual responses. Max lag must be below
1,000 ms and measured SQL below 250 ms. Integrity hashing is outside the measured
hot paths; startup SQL is not individually timed. The helper stops both daemon
instances in `finally` and uses no provider, real keys or GUI. The accepted input
may settle as failed with no provider; this verifies persistence and transcript
delivery, not model execution. Unit contracts cover the remaining writer doors,
failure rollback, nested transactions and status-only updates in CI.

### Repository body reads (slice 8)

Use a fresh synthetic fixture, never a live DB or a copy. Unit suites run in CI.
This journey exercises the same `message.sdkMessages` and `message.sdkMessage`
RPC doors used to load a transcript and an individual full message. It does not
drive the GUI or start a model turn. It uses the real repository, daemon and
WebSocket transport, without the mock API or a provider key.

```bash
RUN=$(mktemp -d /private/tmp/hn-body-read-door-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-live-query-filters.ts seed "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-body-repository-door.ts verify 9334 "$RUN"
```

The seed writes 55,014 rows through production derivation and dual write, with
`replacement_metadata_normalized=1` as production writers do. The helper first
loads both RPC responses, then blanks only the newest 500 synthetic legacy body
columns whose side bodies exist. Both responses must remain identical, including
background metadata and subagent messages, and remain identical after restart.
The complete logical-body SHA-256 must match before/after; tool results remain
stored in full. Full-body hashing and synthetic mutation happen outside latency
measurement, while startup/restart and RPC reads have separate lag measurements.
`observed.json` records executed SQL, query plans, RPC times and max event-loop lag;
SQL executions must be below 250 ms and measured lag below 1 s. Startup SQL is
not individually instrumented. Both daemon instances close in `finally`.

On the contract-test commit before the read wiring, use `reproduce` instead of
`verify` in a separate fresh run. `reproduction.json` records the wrong returned
transcript (`unknown` with empty content on that code), or a read error; neither
is a pass. Do not reuse that modified fixture for the fixed-code acceptance run.
GUI rendering, external drivers and the remaining live-query body outputs belong
to other journeys/slice 9 and are not verified by this repository-read journey.

### Remaining runtime body reads (slice 9)

Run the registered daemon RPC and live subscriptions against split-only bodies:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-runtime-bodies-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-live-query-filters.ts seed "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-runtime-door.ts verify 9336 "$RUN"
```

Use a free non-8399 port and a fresh run directory. The shared 55,014-row synthetic
seed uses production derivation, dual writes and `replacement_metadata_normalized=1`.
The helper adds only synthetic prompt, result and scoped group fixtures. It observes
full/compact transcript and task feeds, the active-turn roster, session groups,
message RPCs, adapter result/input/exchange reads and a scoped SQL body read. Outbox
verification accepts the original long prompt and rejects conflicting text.

It then blanks only the synthetic legacy bodies with existing side copies, notifies
subscriptions, and compares every output before/after and after daemon restart.
Full logical-body SHA-256 must remain identical, including every complete tool
result. `evidence/observed.json` records replies, snapshots, SQL times and heartbeat
lag against the 250 ms / 1,000 ms goals. Hashing, corpus creation and synthetic
blanking are outside measured hot reads; startup lag is measured separately.
`evidence/plans.json` records the actual session-feed and background-metadata plans;
both must hydrate selected rowids with joins and contain no correlated subquery.
Repeat with `reproduce` on pre-slice-9 code in a separate fresh directory/port:
`reproduction.json` records missing output or the legacy parser error. A baseline
RPC/setup failure is inconclusive, not a successful reproduction.

The helper closes both daemon instances and WebSockets in `finally`. It uses no
model, provider, real DB, credential file or GUI; UI rendering and deployment
performance are not verified. Unit contracts and unchanged historical pins run
in CI. Historical schema SQL and the dual-write copy are intentional legacy
readers until the later migration/removal slices.

### Online SDK body copy (slice 10)

### SDK body next-start mode (online precursor to slice 11)

Use a fresh isolated HOME/data directory and a free port; no GUI, provider or
credentials are needed. The helper seeds consumed inputs, so no model turn is
scheduled. Do not use a live DB or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-side-only-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-mode.ts laptop 9372 "$RUN"
```

Repeat with `mixed` and another fresh run/port. Both seed 5,000 synthetic messages,
derive columns through the production chunked backfill, and retain complete tool
results. The mixed fixture deliberately removes half its side copies, retaining
their legacy bodies; startup must serve in dual-write mode. Its own synthetic
missing copies are restored before the next restart. The completed laptop fixture
must choose side-only immediately. All eight production writers are exercised in
both runs; side bodies remain complete and the logical hash survives restart.
Fifty real health/transcript RPCs return full tool results. This is not a GUI test.

For the single-step old-schema upgrade, create a detached worktree at the observed
iMac build `258b731c` under `~/focus/worktrees/`, install frozen dependencies, and
run `old` in a fresh isolated directory, adding that worktree as the fourth
argument. It creates 60,000 synthetic old-schema rows with consumed inputs and
`replacement_metadata_normalized=1`, never copying the live DB. On the old #7865
head `2014efa`, the same old-schema startup refused before serving (reproduction:
`/private/tmp/sdk-side-old-schema-proof/evidence/observed.json`). Fixed code must
run migrations, bind, serve health/transcript, finish the real background copy,
continue dual-writing in that process, then choose side-only on the next start.

Evidence is `evidence/observed.json`: complete logical hashes/counts, WARN-level
chosen modes, startup/copy/query/lag/RPC timings and missing count. Initial legacy
hash equals the migrated logical hash before new writes; the post-write logical
hash remains identical across restart. Seeding and deliberate full-digest reads
are measurement probes, not production RPC workloads. The helper closes its
WebSocket and daemon in `finally`; unit suites run only in CI.

Mode selection runs after numbered migrations/backfill and checks gaps in bounded
yielding batches. No live mode switch occurs. Unified reads retain side-first
COALESCE until slice 11; all writes always keep a complete side body, and pending,
reversed or incomplete copies also update the legacy body atomically. Startup
mode is logged at production WARN. Permanent backups are retained. Slice 11 must
accept legitimate nonempty legacy copies from writes during background copying:
side completeness, verified backup and hashes establish authority, not empty
legacy text. Column removal still needs its separately scheduled downtime PR.

For the qualified-predicate regression behind CI's `no such column: m.rowid`
and `m.sdk_message` failures, use a fresh isolated run directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-body-predicate-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-predicate.ts verify "$RUN"
```

This uses real in-memory SQLite and the production body writer, testing both
qualified row/body predicates in both modes. Every tool-result byte remains
readable through the repository. On the failing head run `reproduce`: dual-write
must throw both unknown-column errors while side-only succeeds. The UPDATE must
declare the same `m` target alias as the side INSERT. It does not change fixture
assertions, schemas or body semantics. Repeat the real-daemon `laptop` and `mixed`
journeys above to verify all eight production writers and RPC output afterward.

### Historical slice-10 copy journey

Run only on a new synthetic database, larger than the read-only live file-size
observation; never seed from or copy a live DB:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-body-copy-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts seed 9338 "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts reserve-retry 9338 "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts verify 9338 "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts backup-reject 9338 "$RUN"
```

The 90,000-row seed uses production derivation, dual writes and normalized
replacement metadata, including 735 KB complete tool results. It removes half
the duplicate side copies to model historical legacy-only rows. The parent
probes real `system.health` and `message.sdkMessages` over WebSocket while the
real daemon migrates. There is no daemon HTTP `/health` route; an HTTP 404 is
not responsiveness evidence. Transcript replies use `sdkMessages`, not `messages`.
The parent closes its WebSocket when the child publishes completion so daemon
cleanup can finish; unexpected RPC errors fail the journey.

The reservation probe restarts its synthetic DB connection and confirms one
durable backup destination, leaving an incomplete `.partial` at that owned path.
The first child SIGKILLs itself after verifying its backup, before any copy cursor
exists; the second reuses that backup and SIGKILLs after its first committed chunk;
the third requires the original verified backup and finishes the migration.
Assert exactly one backup file, no remaining partial, and unchanged backup mtime
at the reserved destination through both restarts. The reservation probe also
creates unrelated backup/manifest/partial sentinels and asserts their bytes remain
unchanged. Never sweep other paths or delete verified backups.
`observed.json` must show zero remaining legacy bodies, an empty suppression
table, the same full ordered logical-body hash, per-chunk transactions <250 ms,
maximum heartbeat lag <1,000 ms and successful health/transcript RPCs. Lag and
transaction maxima include all children. `reservation-retry.json`, `backup-crash.json`,
`crash.json`, `child.json` and logs retain all phases. Peak logical and allocated disk bytes are sampled across
the data tree every probe cycle, including the permanent backup and WAL; this
is a sampled peak, not a physical worst-case bound. Startup and overall runtime
are recorded separately. Seed and final offline hashing are outside daemon lag
measurement. A backup manifest mismatch or missing original backup must reject
verification without altering source bodies; `backup-rejection.json` records it.

Exercise the offline reverse tool only after both children stop:

```bash
env -i PATH="$PATH" NODE_ENV=test bun packages/daemon/scripts/restore-sdk-message-bodies.ts \
  "$RUN/data/daemon.db" --restore-legacy > "$RUN/evidence/reverse.log"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts inspect 9338 "$RUN" > "$RUN/evidence/reverse-after.json"
```

The reverse hash must match `before.json`. Side bodies and the pinned backup
remain; the reversed marker disables automatic copying. All children, workers
and sockets must stop; delete only this run's synthetic data after retaining
evidence. Unit suites run in CI, including insufficient/unknown disk refusal,
verification failure, runtime-capacity/worker refusal, durable backup reservation,
rollback, restart, authoritative-side conflicts, malformed
bytes and concurrent normal writers. No GUI, model or credentials are used.

Exercise the lifecycle/error boundary in another fresh directory (65-second
observation spans the former automatic retry interval):

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-copy-lifecycle-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy-lifecycle.ts verify 9337 "$RUN"
```

`lifecycle.json` must show no copy logs after a delayed Space-ready callback runs
on a closed core; a corrupt synthetic backup manifest must produce one error-level
operator-action log with the backup path, one disk admission, no deferred retries,
responsive real health RPCs and unchanged complete logical-body hash. The manifest
is restored in `finally`; no verified backup is deleted. The same helper's
`reproduce` mode takes an optional baseline worktree as the final argument and
must observe the closed-DB warning plus two verification attempts across 65 s on
the unfixed code. Stop all owned daemons/workers and remove the baseline worktree.
Transient creation failures may retry; a verification failure requires operator
action and has no automatic retry. Never repair, delete or replace a live backup
to make the check pass.

The lifecycle helper also accepts a source-worktree path and a fault name as
its final arguments: `verify 9337 "$RUN" "$PWD" audit` or `path` exercises
disagreeing persisted copy hashes or an invalid original backup location.
Each fresh synthetic run observes 65 seconds: one error-level operator-action
log (including the pinned path), one disk admission, no retry, responsive health
RPCs and unchanged complete-body hash. `reproduce` against an unfixed worktree
must show two admissions/warnings instead. `reservation`, `json` and `shape`
faults additionally model a moved reservation, malformed JSON and invalid cursor
shape; CI also pins a cursor beyond its high-water mark. All stop before any backup worker starts, without changing the
stored marker or complete tool result. These are terminal state errors, not an
instruction to repair/delete any live marker or backup.

For slow-chunk handling use another fresh isolated directory and
`bun .claude/skills/verify/sdk-body-copy-slow.ts verify 9337 "$RUN"` with the same
cleared environment/own HOME/data-dir setup. It deliberately injects one 300 ms
synchronous delay into a synthetic copy UPDATE to cross the pause threshold;
this is a control-flow fault injection, not a physical disk performance result.
`slow-chunk.json` must show one backup verification, one `slow_chunk_pause`, no
deferred run, successful health RPCs and unchanged full-body hash after completion.
The same helper's `reproduce` mode on the unfixed source must observe a deferred
run and a second complete backup verification after 60 seconds. It records the
source-file SHA-256; no production clock/timeout is changed by the helper.
Shutdown during the cancellable pause is pinned in the CI contract. Slow chunks
pause asynchronously for one second inside the current run, preserving its
verified worker channel; a process restart still requires full backup verification.
Repeat the ordinary 90k-row journey separately for actual performance numbers.

Before merging, require Neo's explicit go-ahead, latest-head bot approval and
green CI. Read-only stat/free-space checks must show room for 2× the live DB
plus the permanent backup; the production admission itself requires 2× DB+WAL.
After automatic deployment, read live logs only: `disk_check_passed`,
`backup_verified` (path, bytes, `quickCheck: ok`, hashes), per-chunk progress,
`complete` (matching copy audit chains, runtime) and `run_finished` (max lag).
The copy hashes cover the full versions actually moved, transaction by
transaction, across resumes. Normal writes can change two whole-DB snapshots
online, so do not call that a static global-hash comparison. Report any missing
or failed evidence to Neo; do not restart, write to, or restore the live DB.

### Task body projection triggers (slice 7)

First reproduce the body-source boundary with a fresh isolated run directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-task-body-probe-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/task-body-projection.ts "$RUN"
```

Old code retains flags 17/subtype `before` after the side body changes. The split
triggers must return flags 18/subtype `after`. Keep the before/after artifact.
Repeat in a fresh directory with `missing` appended after `"$RUN"`: it removes
only the synthetic derived projection, blanks its legacy body, then updates
status. The old split inserts flags 0/subtype null; the corrected update must
restore flags 17/subtype `before` from its side body. CI also covers historical
rows without side bodies. Existing projections skip this body initialization.
For the actual task-feed door and performance proof, use another fresh directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-task-body-door-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-live-query-filters.ts seed "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/task-body-projection-door.ts 9333 "$RUN"
```

The 55,014-row synthetic seed now uses the production dual-write helper as well
as production derivation and `replacement_metadata_normalized=1`. The verifier
uses the daemon's registered repository, including its reactive notifications,
and real WebSocket subscriptions to full and compact task feeds. It removes a
synthetic action projection and repairs it through the daemon's actual
status-update facade before observing its pin. It then adds 100
ordinary rows so the unresolved action must stay pinned outside the compact
100-row window; resolving it clears the pin, while the full feed reports the
chosen option. It waits for the production feed debounce before taking the next
snapshot. Do not construct a repository without `ReactiveDatabase` to test live
refresh: such a fixture bypasses the production notification path.

End state: full/compact snapshots and all stored body hashes agree across daemon
restart. Status-only changes retain projection body fields even with the legacy
body blanked inside a transaction that is rolled back; copy suppression and its
rollback preserve the projection and restore normal body writes. Deleting one
synthetic message follows the existing cleanup and leaves a different complete
700,000-character tool result unchanged. `observed.json`, `task-*.json`,
`compact-*.json` and `rpc-*.json` hold the real observations. Lag must stay below
1,000 ms and measured hot SQL below 250 ms; hashing is outside measured hot paths
and startup SQL is not individually timed. No model, provider, real DB or GUI is
used. With no provider the separate mailbox input may settle as failed; the
journey verifies storage, projections and feed delivery. Both daemon instances
stop in `finally`. Unit contracts and the unchanged historical pins run in CI.

Keep everything in `$RUN/evidence/` and quote it in the pull request:

- the RPC replies and DB query output for each journey;
- `voice.json` from journey 2 and `gh.log` from journey 3;
- screenshots of `/neo` and the session view;
- the doctor output.

State what you did not verify.

## Cleanup

```bash
kill "$(cat "$RUN/asr-stub.pid")"   # only if journey 2 started it
.claude/skills/verify/stop.sh "$RUN"
```

`stop.sh` stops only the daemon and mock it started, by their pid files, and
waits for both to exit before the run directory can be reused. Close
the browser tab you opened. Delete `$RUN` once the evidence is in the PR.


### Opt-in JSC source attribution for lag (journey 25)

Repeat journey 25 with `HYPERNEO_LAG_PROFILE=1` in its isolated `env -i` command.
The helper must now observe `samplingProfile.status=captured` with the real
`lagProfileSyntheticHotspot` function in `lag-activity-check.ts` and a positive
source line, while preserving the original lag warning and payload privacy.
Repeat without the flag: `samplingProfile` must be absent. This enables profiling
only in that synthetic process, never on the laptop daemon.

Measure steady overhead in separate fresh run directories, alternating the flag
off/on/off/on, with the same isolation variables and a free non-8399 port:

```bash
RUN=$(mktemp -d /private/tmp/hn-lag-profile-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/lag-profile-overhead.ts 9346 "$RUN"
```

Add `HYPERNEO_LAG_PROFILE=1` only for the on runs. Each `overhead.json` records
12,000 real synthetic RPCs after 1,000 warmups: CPU, wall time, p50 and p95.
Both helpers stop their daemon and monitor in `finally`. These measurements
cover a synthetic workload, not the laptop heap or normal human activity.

Profiling activates when the existing lag monitor is armed after startup
settles (or its startup grace expires), not before initialization. Disabled is
zero profiler work; runtimes without the Bun API report `unsupported`.
The sampler interval is 10 ms; every 250 ms monitor tick drains native samples,
including healthy and rate-limited ticks. Only the newest 2,000 samples are
ranked; any omitted count is explicit. Output is five stacks, six frames each,
function names up to 120 characters and source paths up to 300; source URL
queries/fragments and inline source bodies are excluded. Unknown source lines
are null. Three reports per rolling hour limit log volume. The coverage is
between profiler drains, approximately the monitor tick, with small boundary
skew from the monitor's own work. Async/native code may lack useful JS frames.
JSC sampling runs for the enabled process lifetime; disabling it requires a
separate authorized restart. Never set this flag on the live daemon without
explicit approval from Neo/human. A captured stack is attribution evidence;
these synthetic runs do not establish the cause of the real laptop stalls.

### Codex PR attribution stall regression (journey 26)

Run a synthetic Codex database/transcript through the real `work.status` door:

```bash
RUN=$(mktemp -d /private/tmp/hn-codex-pr-lag-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/codex-pr-lag-check.ts 9347 "$RUN"
```

Use a free non-8399 port and a fresh run directory. The helper creates its own
Codex state DB under the temporary HOME before daemon startup; no real Codex
store, transcript, keys or credential discovery is used. Its 4,011,712-byte
transcript has normal synthetic padding plus a tool-documentation line with
32,000 unmatched `pull_request` tokens after `attach_artifact`. The old nested
lazy regex revisits the suffix for every token: it takes seconds, whereas the
new scan advances monotonically through non-overlapping parenthesis segments.

End state: `observed.json` preserves the first/unchanged/appended/truncated PR
lists, RPC elapsed times and maximum 10 ms heartbeat lag. Max lag must be below
1,000 ms; the helper writes the evidence before asserting the budget, so the old
code's failing reproduction remains measurable. This is an adversarial synthetic
line in a realistic tail size, not a copy or an estimate of the real transcript.
The helper stops its daemon and timer in `finally`; no GUI, providers or profiling
flag are involved. This proves the daemon RPC path, not deployed performance.

An unchanged transcript tail skips PR extraction, using a SHA-256 digest of the
already-read lines. File timestamps are not cache identities: coarse timestamps
can repeat after a same-size rewrite. Only the bounded PR result and digest are
cached in the adapter's lifetime; status/reply and exchange reads continue. Append,
equal-size rewrite, replacement, changed tail window and truncation must invalidate
it; `codex-pr-cache.test.ts` pins those
observable results. No raw transcript is retained in the cache.

### Work-feed search cleanup latency (journey 28)

Run the real Claude-feed maintenance job in an isolated daemon while reading a
session through WebSocket RPC:

```bash
RUN=$(mktemp -d /private/tmp/hn-search-delete-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/search-delete-lag.ts 9348 "$RUN"
```

Use a free non-8399 port and a new directory. The helper creates 30,000 synthetic
stored tool results and duplicate Claude search rows, each with an 8-KiB body,
plus 3,000 Codex search rows and the actual FTS5/vector cleanup triggers. It queues
`work.feed.claude` through the real job queue, samples the event loop every 10 ms
and reads `session.get` during cleanup. No provider, transcript discovery outside
the temporary HOME, real database, credentials or browser is used.

End state: `observed.json` records a completed job, zero duplicate Claude rows,
all 3,000 Codex rows, identical SHA-256 of every stored message/tool-result body,
maximum event-loop lag below 1,000 ms and every observed search-content statement
below 250 ms. The old unbounded delete fails those budgets; save that failing
`observed.json` before applying the fix. Sampling and SQL timing start after corpus
creation, so seed work is excluded. RPC measurements share the daemon's process
and can miss a stall between requests; the interval delay is the block metric.
The helper stops its daemon and interval even on assertion failure.

Repeat in another fresh directory with `16000` as the third helper argument to
exercise the maximum feed body size. CI also checks that another callback runs
while derived cleanup is still underway, FTS/vector cleanup remains correct,
other feed kinds remain searchable and vanished-feed callers await cleanup.
Measurements establish the tested synthetic workloads, not a physical upper
bound on disk I/O or deployed performance. Keep both JSON reports and the exact
command as PR evidence; stored source data is never deleted.

### Search index insert latency (journey 29)

Index synthetic messages into an isolated daemon that runs its own background
FTS merges, then keep writing while the space tick's expiry UPDATE runs:

```bash
RUN=$(mktemp -d /private/tmp/hn-fts-merge-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/fts-merge-lag.ts 9349 "$RUN" 500000 256 45
```

Arguments after the run dir: rows (500,000, about the iMac's index), words per
body (64 ≈ the live average, 256 for 4x bodies) and seconds of steady writes. The
helper inserts in 200-row transactions that yield between batches, samples the
event loop every 10 ms, times 20 search queries, then runs the
`space_external_events` expiry UPDATE plus a 20-row index write every 100 ms.

End state: `observed.json` shows `index.worstBatchMs` and both `maxLagMs` below
1,000 ms at 256 words, and the same `searchAfterIndexing.totalMatches` before and
after a change. With `crisismerge` 64 the 256-word worst batch was 1,859 ms (an
FTS5 crisis merge inside the insert); with 16 it was 434 ms.

### Subagent lookup by tool id (journey 30)

A page's subagent rows must be read by tool id, not by walking the session:

```bash
bun .claude/skills/verify/subagent-lookup.ts 45000 10
```

The script builds a synthetic session (45,000 rows by default, with 10 tool uses on the last page) and installs the live laptop's `sqlite_stat1` figures for `sdk_messages`. It then times the subagent lookup inside `getSDKMessages` and prints its plan. It runs on Bun's SQLite, the planner the daemon uses; Vitest's `node:sqlite` plans differently. End state: the plan seeks `(session_id=? AND parent_tool_use_id=?)` (the covering `idx_sdk_messages_session_visible`), and the lookup takes about 0.1 ms. Before the `ORDER BY +timestamp` hint, it walked `idx_sdk_messages_session_timestamp_id` whenever a page had two or more tool uses: about 7.4 ms on warm synthetic rows, and 234–2,734 ms on the live disk.

### Work-feed offsets read once (journey 31)

Work-feed polls must not re-read the offsets table:

```bash
bun .claude/skills/verify/work-feed-offsets.ts 2700 35
```

The script builds a synthetic temp DB (2,700 rows and 35 polls by default, the live per-5-minute cadence). Each poll calls `readWorkFeedOffsets`, then writes one offset through `saveWorkFeedChunk`. End state: `table reads=1` for any number of polls. Before the in-memory offsets map it printed `table reads=35`. On the live daemon, `select path, offset, size, mtime from work_feed_offsets` then appears in the `sqlite.query` summaries only in the first window after a restart.

## Worker handoff outbox (PR1)

Run the real SDK tools against a loopback-only scripted model. No GUI, daemon
restart, live DB, real keys or real transcripts are involved. Pick a free port
other than 8399. The parent environment is empty; only each synthetic SDK child
receives the dev-proxy credential and loopback base URL.

```bash
RUN=$(mktemp -d "$PWD/.verify-handoff.XXXXXX")
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-handoff.ts "$RUN" 9361
```

`worker-handoff.ts` resolves the repository's installed SDK executable through
its production resolver (new SDK versions ship a native executable, not cli.js).
It drives worker native Write → real MCP `handoff.publish`, then a separate Neo
SDK session through real MCP `handoff.read` and native Read. The report must retain
all 12,000 UTF-8 bytes and SHA-256. A sibling private file, a published symlink and
a changed snapshot must return denial without their contents; the changed file
must report `tampered`. `evidence.json` records receipts and actual tool results.
The script closes both SDK streams and its mock server. Before repository checks,
preserve evidence outside the worktree, then remove only this synthetic run
(the SDK writes unformatted configuration into its temporary HOME). This verifies
tool behavior,
not GUI rendering or protection against a malicious same-user OS process.

### Lag diagnostics name the step (journey 32)

```bash
bun .claude/skills/verify/lag-diagnostics-check.ts "$(mktemp -d /private/tmp/hn-lag-diag-XXXXXX)"
```

The helper runs the daemon's own `startDaemonLagDiagnostics` and the Bun SQLite wrapper with
query observability on a throwaway file, then blocks the event loop three ways: a 1.3 s CPU spin,
a 1.3 s `Atomics.wait` (off-CPU, like a lock or I/O wait) and a transaction that spins 1.3 s.
End state in `lag-diagnostics.json`: three `[Daemon] Event loop blocked` lines; each
`event_loop.lag_activity` record carries `resources` (main-thread CPU ms, off-CPU ms, major page
faults, block writes, voluntary context switches since the previous tick). The spin reads as
~1,300 ms CPU, the wait as ~1,400 ms off-CPU, and the third line ends
`slowest SQL …ms: transaction`. On macOS a blocking wait may not count voluntary switches.

Live, a feed or driver-refresh block names its open phase: `feed:<claude|codex>:<head|read|parse|save>`,
`feed:<kind>:<purge|prune|list|changed>`, and `neo:driver:<card_topic_sweep|todo_refresh|follow_topics|session_watch>`.
A block with high `majorPageFaults` and off-CPU time is paging, not our work.

To load the Claude feed on a synthetic transcript in an isolated daemon:

```bash
RUN=$(mktemp -d /private/tmp/hn-feed-lag-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/work-feed-lag.ts 9350 "$RUN" 24
```

It writes a 24 MB transcript (text turns plus tool results), runs `work.feed.claude` until every
turn is indexed and samples the event loop. Baseline on dev: one 1.2 s job, max lag 67 ms.

## Complete worker report in one send (handoff PR2)

Run the real SDK MCP send and Neo read against a loopback scripted model, then
run the actual `hyperneo send` CLI through an isolated owner-only Unix socket:

```bash
RUN=$(mktemp -d "$PWD/.verify-message-send.XXXXXX")
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-message-send.ts "$RUN" 9362
```

Choose a free non-8399 port and a fresh directory. Only synthetic SDK children
receive a dev-proxy credential pointing at the loopback mock. End state:
`evidence.json` records one worker MCP `message.send {to,text}` containing all
8,192 bytes, an accepted receipt with SHA-256, the same reference in the durable
mailbox, and identical complete bytes read through Neo's real MCP and native Read
interfaces. The helper reopens its own SQLite DB after removing the completed
synthetic mailbox row; retrying with the same `idempotencyKey` must return the
same receipt without another job. The actual CLI must also deliver all 8,192
bytes through its Unix HTTP door using the simple shape.

The Neo SDK prompt is taken from the durable mailbox payload. This checks the
send/receipt/read interfaces; it does not run the daemon's automatic mailbox
consumer or a GUI. It closes SDK streams, the socket and mock server in `finally`.
Preserve evidence outside the worktree, then remove only the synthetic run before
repository checks. Keep the same-user trust boundary from PR1: no OS isolation is
claimed, and reads detect changed published bytes instead of returning them.
The contract suite also seeds an interrupted partial draft and sends the same
report concurrently to different recipients; every accepted report must retain
all bytes. Explicit file arrays accept 20 references; 21 must return a schema error
that names the limit and the option of sending additional references separately.

## Complete stored worker reply (handoff PR3)

```bash
RUN=$(mktemp -d "$PWD/.verify-work-read.XXXXXX")
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-work-read.ts "$RUN" 9363
```

Use a fresh directory and a free non-8399 port. The real SDK invokes `work.read`
over MCP against an isolated SQLite database and a loopback scripted model.
A synthetic 198,001-byte report lives only in SDK body storage, behind 30 later
follow-ups; no search-index row exists. Neo/internal and archived session reads
must return `not_found` through the same MCP door, without exposing their
synthetic private text. Linked archived tasks and terminal tasks older than the
shared 30-day TTL must also return no body, using each SDK row's task ID rather
than session-name inference. The helper follows the returned cursors
and checks exact UTF-8 byte length and SHA-256, hidden-thinking exclusion and
unchanged SDK/body rows. A retracted legacy message without an SDK UUID must
stay hidden when its replacement edge targets the stored message ID. The proof also
follows textless older pages until `complete`, rather than `reply_unavailable`.
A malformed stored SDK body is skipped without losing healthy report text or
rewriting the corrupt bytes; unit coverage also exercises predecessor context.
`evidence.json` records the page count and maximum
observed event-loop lag against the 1 s goal. Text pages budget serialized UTF-8
bytes so the SDK does not replace the tool result with a persisted-output stub.
`textOffset` counts UTF-16 code units; concatenate chunks of the same message ID
in cursor order, then follow older-history cursors if needed. Availability
reports paging completeness, not whether a task is finished or its todo answered.
Result deduplication uses the selected page and at most 16 preceding records; a
distinct visible result stops substitution. Unscanned history stays on the cursor,
so a long tool-only prefix does not cause an unbounded synchronous backward scan.

This proves the SDK/MCP read interface, not todo attribution (PR4) or GUI rendering.
File references remain descriptors; their contents are read and hash-checked
through `handoff.read`, with PR1's same-user trust boundary unchanged.
The helper closes its SDK stream, mock HTTP server and SQLite in `finally`.
Preserve evidence outside the worktree and remove only its synthetic run afterward.

## SDK settings preparation responsiveness

Use a fresh synthetic HOME, workspace and DB. The helper creates a FIFO only in
that workspace (or the synthetic user's `.claude/settings.json`) and starts an
owned writer that supplies JSON after 1.4 s. It calls the real SettingsManager
through an isolated daemon RPC while requesting `system.health` on the same
WebSocket. It records health latency, preparation duration and maximum 10 ms
heartbeat lag, then stops its writer and daemon. No model or credentials are used.

```bash
RUN=$(mktemp -d /private/tmp/hn-settings-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/settings-admission-lag.ts verify 9364 "$RUN" workspace
```

Repeat in another fresh directory with `user` instead of `workspace`. On the
regression commit use `reproduce` instead of `verify`: `observed.json` must show a
block over 1 s and a delayed health reply. Fixed code must keep heartbeat lag
below 1 s and health below 250 ms while settings preparation still takes 1.4 s.
This proves a synchronous settings I/O hazard; attribution of the historical
2026-10-20 17:48:36Z production stall remains unproven.

Repeat `verify` in a fresh run with `dangling` instead of `workspace`. This puts
a relative settings symlink in the synthetic workspace whose target does not
yet exist and delays the synthetic user attribution through the FIFO. The
receipt must show `settingsSymlinkPreserved: true`, and the new target must
contain the inherited synthetic attribution. Before the target-resolution fix,
this journey records `false` and fails because rename replaced the link.
Absolute/relative/chained missing targets and a missing parent directory are
also pinned in the focused settings suite. Missing parents and native symlink
resolution errors fail without replacing the original link.

Settings preparations share a promise chain keyed by the resolved target path,
including across SettingsManager instances and workspace aliases. They re-read
local settings after awaiting inherited attribution, then commit complete JSON
with a same-directory temporary file and rename, preserving existing permissions
and symlink targets. This does not lock unrelated external editors. Invalid JSON
is reported without including its contents and left untouched. A failed write
only unlinks its own successfully created staging file, never the settings file
or another writer's temporary file.

The focused settings suites also exercise overlapping sessions, an external edit
during the delayed attribution read, invalid JSON and queue recovery, read-only
directories, and an injected staging-write failure. All fixtures stay in their
own temporary workspace and user-settings directory:

```bash
cd packages/daemon
bunx vitest run tests/unit/1-core/session/settings-manager.test.ts tests/unit/1-core/session/settings-responsiveness.test.ts
```

### Notice groups reload by subtype (journey 33)

```bash
bun .claude/skills/verify/notice-select-cold.ts "$(mktemp -d /private/tmp/hn-notice-XXXXXX)"
```

The helper builds a synthetic DB shaped like root Neo (about 120k other rows, 17,000 `system`
rows and 82 `session_notices`) and runs the notice-group reload selection in a fresh `sqlite3`
connection, before and after, reporting SQLite page-cache misses: the pages a cold start must
fetch. End state in `observed.json`: the old `message_subtype` filter misses ~980 pages, the
`message_subtype_norm` filter on `idx_sdk_messages_session_subtype_parent` ~56. macOS cannot drop
the OS cache without root, so misses stand in for cold-disk time. Read-only on a live DB, the
same comparison went from 13,929 to 136 misses.

## Question option guidance

After Launch, with no provider configured or model turn, run:

```bash
VERIFY_PORT=9311 bash .claude/skills/verify/question-description.sh "$RUN"
```

The real `operations.describe` discovery door must return `neo.question.ask` with
Reply in chat guidance immediately after the yesno/choice instructions, forbidding
invented "other" or "something else" options. The helper saves the complete reply
in `evidence/question-description.json` and fails on the pre-fix description.
This verifies the agent-facing description, not model compliance or GUI rendering.
Read-only client parity: web `packages/web/src/neo/NeoAskTodos.tsx` renders the shared
reply button before the yesno and choice decisions; iOS
`Neo/Views/AskEntryCardView.swift` in `~/focus/neo-ios` includes `reply` in every
`ViewThatFits` layout before the kind-specific `decisions`. Do not automate GUI
checks unattended.

## Worker build query through the owner-only socket

Build web once, then use Launch with a fresh run and a free non-8399 port. No
provider or model turn is needed. Keep launch, check and stop in the same shell
so the shell runner does not reap the background daemon between calls:

```bash
RUN=$(mktemp -d /private/tmp/hn-build-XXXXXX)
trap '.claude/skills/verify/stop.sh "$RUN"' EXIT
.claude/skills/verify/launch.sh 9372 "$RUN"
env -i HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  bun .claude/skills/verify/build-check.ts "$RUN" "$(git rev-parse HEAD)"
```

The helper runs the real `hyperneo build` command through both source and release
CLI entries, checks that source `--help` lists `build`, and uses only
`<run>/data/session-door.sock` for the query. Release `--help` requires generated
embedded assets and is not exercised by this source-only journey. The worker sender is set
synthetically; normal workers inherit their session sender and socket location.
It verifies socket permissions 0600, daemon PID and build commit, stable process
startedAt (Unix milliseconds), increasing uptime (milliseconds), health `ok`, and
exactly the six public response fields. Every other registered operation plus an
unknown name and `system.health` must be denied by the socket itself; missing
sender must also be denied. `evidence/build-check.json` retains both CLI outputs
and denied names. Health means the daemon can answer and perform `SELECT 1`; it
does not claim provider availability. The socket contract suite covers probe
failure without leaking error text, and rejects extra response fields. No GUI,
real data, auth files or TCP 8399 are involved.

## Resources on sub-second slow SQL

```bash
RUN=$(mktemp -d /private/tmp/hn-slow-sql-resources-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/slow-sql-resources.ts "$RUN"
```

This exercises the real Bun SQLite wrapper and daemon structured diagnostic log
stream. An owned Python connection holds a writer lock on a fresh synthetic WAL
DB for 0.6 s, then a calibrated recursive SQL query does CPU work. Neither case
needs a model, network port, real database or credential. The writer is stopped
in `finally`; the synthetic DB and `observed.json` remain as evidence.

Both slow records must carry `resourceScope: event_loop_tick`, monotonic tick
boundaries, and the same resource delta available to the lag monitor. The lock
wait must show over 400 ms off-CPU; recursive SQL must show over 250 ms CPU. They
can be below the 1 s event-loop warning threshold and still get resource data.
These are whole-tick counters, including other work and idle time, not exclusive
statement costs or proof that an historical query blocked on a lock or fsync.

While diagnostics are armed, slow warnings flush at the next existing 250 ms
resource sample (or shutdown); no per-statement resource syscall is added.
Outside the monitor, warnings retain immediate delivery without tick metadata.
Unavailable resource sampling leaves counters absent rather than fabricating
zeroes. Fast queries and summary aggregation keep their existing behavior.

Verify shutdown delivery through the actual daemon and its JSONL file sink:

```bash
RUN=$(mktemp -d /private/tmp/hn-slow-sql-shutdown-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/slow-sql-shutdown.ts "$RUN"
```

The helper enables query observation on its own synthetic DB and runs a real
recursive SQLite query immediately before normal cleanup or a synthetic cleanup
failure. `observed.json` must contain exactly one persisted slow record per case,
with tick resource context. It explicitly simulates watchdog arming (normally off
in test mode) and uses a 60 s sampler cadence to keep the query pending until
shutdown. The SQL execution, app cleanup and file sink are real; this does not
verify production watchdog activation. Both sinks must still be subscribed when
cleanup stops the lag monitor, before evidence flushing and sink teardown.

### Core pack preferences (slice 1)

```bash
RUN=$(mktemp -d /private/tmp/hn-pack-preferences-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-preferences.ts 9351 "$RUN"
```

The helper boots the real isolated daemon twice and reads `system.health` over
WebSocket on each boot. `evidence/observed.json` must show zero preference rows
on first boot: migrations never apply defaults or install-specific settings.
One synthetic human setting and its provenance/timestamp survive restart, and
an unanswered repo stays unanswered. The helper inserts only synthetic fixture
data directly; the human-only settings operation belongs to slice 2. It uses
only its fresh DB and temp HOME, without providers or credentials. Both instances
stop in `finally`. This proves bootstrap persistence and the core lookup; there
is no settings RPC/UI or merge-policy enforcement in slice 1. Those later slices
need their own journeys. No live DB, GitHub request or model turn is involved.

### Pack settings operations (slice 2)

```bash
RUN=$(mktemp -d /private/tmp/hn-pack-settings-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-settings-operations.ts 9352 "$RUN"
```

The real isolated daemon's WebSocket `operation.invoke` door must show empty
settings, accept a valid human write, refuse an invalid enum, and return the
saved value/provenance in get, list and `neo.snapshot`. The real MCP adapter over
the daemon's registry must refuse Neo's attempted policy change with `forbidden`
and still allow reads. Restart preserves the saved value, and an unknown repo
stays unanswered. `evidence/observed.json` retains every response. Both instances
stop in `finally`. Only synthetic data and temp HOME are used; no provider,
credential, model turn, live DB or GUI is involved. This proves operation caller
admission and persistence, not later policy enforcement or the install question.

## Feed metadata I/O responsiveness

Use a new synthetic HOME/data/DB and a free non-8399 port. The helper drives the
real timed Codex/Claude feed pipelines over an isolated daemon WebSocket while
requesting `system.health` on the same connection. It injects a 1.4 s delay only
for selected synthetic directory listing, existence and known-file stat calls:
blocking `Atomics.wait` for synchronous calls, asynchronous timers for promise
calls, both delegating to the real filesystem. This models slow metadata I/O;
it is not a reproduction of the laptop's particular kernel wait.

```bash
RUN=$(mktemp -d /private/tmp/hn-feed-listing-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/feed-listing-lag.ts verify 9374 "$RUN"
```

On the regression commit use `reproduce` in another fresh directory. Each of
Codex listing, Claude listing, retained-path prune and unfinished known-path
metadata must show max heartbeat lag over 1 s. Fixed code must keep max lag
below 1 s and health latency below 250 ms. The unfinished old transcript must
still be read despite its age; content, file sizes, complete offsets and mtimes
are asserted in `observed.json`. The retained-path prune must not change offsets.
The helper closes its own socket and daemon in `finally`. It uses no model or
credentials and never reads the real session directories. Feed content reads
remain synchronous in this slice; this journey verifies metadata I/O only.


## Todo report attribution (handoff PR4)

```bash
RUN=$(mktemp -d "$PWD/.verify-todo-report.XXXXXX")
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-todo-report.ts "$RUN" 9364
```

Use a fresh synthetic directory and free non-8399 port. The actual SDK calls
`neo.todo.add` with `start:true` through MCP. The real todo runner dispatches
through `work.send`, stores its receipt and reads `work.status`; the fixture
models consumption, a mid-turn human input, a full assistant report with an empty
terminal result, and a separate later turn. The SDK then reads receipt-bound
status over MCP. The stored todo report and Neo's emitted note must contain all
8,701 report bytes with identical SHA-256 and exclude the later turn. Repeated
refreshes must not duplicate or truncate the report; SDK/body rows stay unchanged.
`evidence.json` records maximum observed event-loop lag against the 1 s goal.
Unit contracts additionally cover reports larger than the excerpt limits, many
assistant rows across pages, shared terminal watermarks, pending/missing inputs
and incomplete terminal history. This proves todo dispatch, settlement and its
SDK/MCP interface using synthetic runtime evidence, not PR5 answered linking or
GUI rendering. Stop the isolated SDK/model server and preserve evidence before
removing only this synthetic run directory.

## Card-topic sweep responsiveness

Run a fresh isolated daemon with synthetic HOME/data/DB and a free non-8399
port. The helper creates 180 followed todos with two topic subscriptions each,
plus one removed todo. Each pack-eligibility settings read gets an explicit
8 ms synthetic blocking wait before its real SQLite read. No real session,
provider, key, transcript or live DB is involved.

```bash
RUN=$(mktemp -d /private/tmp/hn-card-topic-phases-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/card-topic-phases.ts verify 9375 "$RUN" enabled
```

Repeat in another new directory with `disabled` instead of `enabled`. On the
regression commit use `reproduce`: both modes must show 180 eligibility reads
and max heartbeat lag over 1 s. Fixed `verify` must show exactly one settings
read, including when eligibility is false, with heartbeat lag below 1 s and
health below 250 ms. `observed.json` retains phase totals, actual subscriptions,
health latency and any structured lag diagnostics.

With delivery enabled, only the removed todo's two topics end and 360 remain.
With delivery disabled, all 362 topics end. The helper then changes the stored
pack setting, re-subscribes active topics if needed and sweeps again over the
same WebSocket. The changed eligibility must take effect immediately on that
next sweep, in both directions; no value is cached across sweeps. Focused tests
also keep settings unread when there is no followed todo, including an empty
sweep. This keeps the snapshot lazy rather than adding an unconditional read.

The existing activity buffer retains 64 entries and reports dropped entries;
large sweeps expose a suffix of per-todo phases plus the final aggregate. The
helper separately totals every emitted phase in its own instrumentation, without
changing production buffering. Nested totals overlap and must not be added.
This proves the repeated-read path under controlled latency, not the cause of
the historical 20:09 four-second phase or a particular OS wait. The helper closes
its socket, diagnostic observer, Neo service and daemon in `finally`.

### Policy-aware merge nudges (slice 3)

```bash
RUN=$(mktemp -d /private/tmp/hn-policy-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-policy.ts verify 9353 "$RUN"
```

On the reproduction commit run `reproduce` in another fresh directory: a scripted
bot approval for synthetic qlark#19 leads to merge text immediately and again at
+20 minutes. Fixed code must emit zero merge messages and show `waiting_human`
through the real daemon's `neo.snapshot` and production coding-pack sweep/events.
Settings are written only to the synthetic daemon through the human RPC door.
GitHub reads and message delivery use synthetic fixtures/capture sinks; the
production classification, repositories, event delivery decisions and sweep run
unchanged. Both daemon and socket close in `finally`. Evidence retains every
state and emitted message in `evidence/observed.json`. No credentials, provider,
model, live DB, real GitHub calls or GUI are used.

Slice 3 conservatively keeps any configured humanSignoff in `waiting_human`
when otherwise merge-ready: current-head path/label reads and durable holds are
later slices. Review-author login is read now to enforce designated-bot approval;
unknown/stale authors never count. This journey proves the nudge decision and
snapshot, not live GitHub transport, actual delivery or later worker merge checks.

## Web schedule strip (G7b)

Build the web and launch a fresh isolated daemon as above. Run
`bun .claude/skills/verify/session-schedule-web.ts <port> "$RUN"`, then the
headless `.claude/skills/verify/session-schedule-web.mjs <port> "$RUN"` with a
Node runtime that can resolve Playwright. `VERIFY_BROWSER` may name a local
Chromium executable, always launched headless with a fresh profile.

The helper creates only synthetic Neo/session goals and reminders through RPC;
last-outcome/skip/nudge values are explicit DB fixtures, not proof of wake delivery.
The browser opens both `/neo` and `/session/<id>` at 1280/390px. Each strip starts
folded and shows only its own target's rows. Expand it, inspect interval/cron,
next/last timestamps, skip reason and nudge distance (or “Nudge due” after the
threshold), then open the goal title's read-only definition. Pause/resume must update
both UI and a fresh real RPC read.
The helper also opens a synthetic Space session route: no strip or schedule list
RPC may be present there, including after focus. `reproduce` as the final browser
argument skips the long visible-refresh check but retains both boundary assertions.
Screenshots: `evidence/schedules-{neo,session}-{1280,390}.png` and
`evidence/schedules-space.png`; assertions and
observed text: `evidence/schedule-web.json`. Inspect screenshots as well.

The strip refreshes every 30s while visible, on window focus and explicit refresh,
and after controls. Goal titles use a disclosure until G6 adds the full goal panel;
this journey does not claim a journal or cross-page goal link. No GUI, model,
provider, real data or GitHub is used. Stop the daemon/mock with `stop.sh`.

### Immutable settings proposal answers

```bash
RUN=$(mktemp -d /private/tmp/hn-preference-answers-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-preference-answers.ts 9354 "$RUN"
```

The helper uses the real daemon registry's MCP and WebSocket operation doors.
A declined question returns `question_closed` when retried with the same request id;
a new request id must reach the human as an open question.
Neo proposes two synthetic settings; the daemon generates the exact question
text, and `neo.snapshot` must expose that question. Before consent the settings
remain empty. Agent answering is refused; the human button's real
`neo.question.answer` path must atomically apply the stored values. Across daemon
restart, `neo.question.get` reports human consent, provenance stays human, and
agent attempts to replace values or reuse a request id with a different proposal
are refused. A questionId-only retry leaves settings unchanged. Complete replies
are retained in `evidence/observed.json`; both daemons close in `finally`.

No legacy binding, live database, provider, credentials, model or GUI is used.
The ordinary human-answer notification may queue without a provider; this journey
proves question/setting persistence and caller boundaries, not notification/model
completion. Unit contracts also inject a failing settings write and require both
consent and every value to roll back together. Actual browser rendering and the
future first-dispatch trigger are not verified here.

Before pushing a new numbered migration, run from the developer checkout:
`bun .claude/skills/verify/migration-number.ts <number> [own-pr-number]`.
This read-only preflight fetches fresh dev and enumerates every open PR's changed
files through `gh`, then asserts a new candidate follows the highest numbered
migration. A number already reserved in own-pr-number is checked for collisions
instead. Supply own-pr-number only when updating that same PR. It uses GitHub,
not the isolated daemon or a live database; do not run it under the stub-gh PATH.
Unpublished reservations still need coordination with their owner.

### Unknown schedule counts

On another fresh run, seed with `session-schedule-web.ts`, then run the headless
`session-schedule-summary.mjs <port> "$RUN"` with the same Node/Playwright setup.
It holds and refuses only the first schedule-list reply at the WebSocket boundary;
all other calls and the successful retry use the actual isolated daemon. While the
strip is collapsed, both pending and failed reads must show only “Schedules”,
without a fabricated zero. Retry must show the actual count of two. Component
contracts separately check a successful empty read shows zero.

Evidence: `evidence/schedule-summary.json` and
`schedule-summary-{loading,failed,recovered}.png`. This is controlled fault
injection into the real web surface, not a claim that the daemon itself failed.
The helper closes its headless browser; stop the daemon/mock with `stop.sh`.

## Source-labelled schedule list (G7 contract)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/session-schedule-labels.ts <port> "$RUN"`.
It opens a synthetic Neo, creates its goal schedule and another target's reminder,
then reads the real `schedule.session.list` RPC using the shared result type.
The goal title must follow a rename; the reminder uses its note. Each target sees
only its schedules, including cadence, next run, last outcome/skip reason and
`nudgeEvery - dueCount`. Pause and resume must survive a fresh list read.
Repeated label reads must leave `facts_lines` unchanged.

Evidence: `evidence/schedule-labels.json`. This proves the shared read contract
and local-user RPC controls, not the web schedules strip (the next G7 slice),
actual wake delivery, or an iOS screen. No provider/model, GUI, real DB or GitHub
requests are used. Stop the isolated daemon and mock with `stop.sh`.

## Conversation wake lookup query

Run the actual isolated daemon with synthetic HOME/data/DB and a free non-8399
port. The helper seeds 140,000 SDK headers, 1,400 input origins, then zero and two
scheduled wakes. No model, credentials, live data or GUI is involved.

```bash
RUN=$(mktemp -d /private/tmp/hn-wake-query-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/wake-query.ts verify 9377 "$RUN"
```

On the regression commit, `verify` must fail the VM-work budget; `reproduce`
records the original excessive traversal without failing. Fixed code must return
exactly zero then two wakes from the real `neo.snapshot` WebSocket door and the
Bun repository. `observed.json` retains query plans, repository/RPC timings, exact
SQLite VM steps and SQLite page-cache miss/hit deltas. These counters use public
SQLite C APIs through Python's linked SQLite library in read-only mode on the
synthetic DB. Compare its reported SQLite version with Bun's reported version;
page-cache misses mean SQLite page reads, not physical disk reads. A fresh
connection does not flush the operating system cache. This is controlled query
work evidence, not proof of the cause of historical off-CPU waits. The helper
closes its socket and daemon in `finally`. Focused tests also retain empty and
populated views, scope, chronological ordering and both pagination directions.

## Follow-topic refresh responsiveness

After the card-topic expiry sweep, `refreshDriverWork` follows subscriptions for
checkable todos. This journey exercises that actual refresh over an isolated
daemon WebSocket, with 180 synthetic named PR links, two retained topics per
todo and one removed todo. Its GitHub reader returns synthetic empty results;
there is no root session binding, provider, live data or external request.

```bash
RUN=$(mktemp -d /private/tmp/hn-follow-topics-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/follow-topics-lag.ts verify 9378 "$RUN" enabled 8
```

Repeat with `disabled 8` in a fresh directory. The 8 ms controlled wait models
slow settings reads; `enabled 0` and `disabled 0` measure native reads without
injected latency. Before the fix, `reproduce` must record 180 settings reads in
the follow phase and over 1 s max lag with the controlled wait. Fixed `verify`
must record one follow-phase settings read, including disabled delivery, max
lag below 1 s and a concurrent `system.health` reply below 250 ms. The preceding
expiry stage retains its own once-per-sweep settings read; those two reads are
reported separately. The next actual refresh must observe flipped pack settings.

`observed.json` retains phase totals, subscription counts, health latency and
lag diagnostics. Enabled refresh retains 360 synthetic topics and adds 180 PR
topics; disabled refresh expires all 362 initial topics. After changing settings,
the next refresh respectively expires all topics or adds 180 PR topics. Focused
tests also cover an empty pack list, direct-call freshness, duplicate watch
suppression and no followed todos. A controlled wait proves amplification of
slow settings, not the cause of any historical live off-CPU event. The helper
closes its own socket, timer, monitor, Neo service and daemon in `finally`.


### Human-approved standing-rule edits

```bash
RUN=$(mktemp -d /private/tmp/hn-rule-answers-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/neo-rule-answers.ts 9355 "$RUN"
```

This helper starts a real isolated daemon and uses its MCP and WebSocket
`operation.invoke` doors. A system-triggered direct `neo.rule.save` is refused.
After a stored human message is consumed and delivered in that active turn, an
explicit `human:<messageId>` triggerId and that message's exact citation allow
the direct path, matching #7904's input attribution.

The preferred `neo.rule.ask {askId,requestId,add?,remove?}` path generates a yes/no
question and atomically binds its immutable exact edit. No answer leaves the
rules unchanged. Human yes applies only the stored edit; an agent cannot answer,
replace the proposal after consent or pass new edit fields to the questionId-only
`neo.rule.applyAnswer`. Both the human consent and resulting `neo.snapshot`
standingRules survive restart. Successful chat consent must also deliver the
updated `state.settings` event over the connected WebSocket; the helper waits
for the exact new rule in this projection, rather than accepting a DB read as
proof that connected clients updated. Pending proposal retries reuse requestId; closed
questions require a new requestId. Evidence is retained even on failure in
`evidence/observed.json`; each daemon and socket closes in `finally`.

Unit contracts also replace one of twenty rules while keeping the other nineteen,
refuse guessed/queued/nonhuman direct-save triggers, and roll back consent and
all edits on infrastructure failure. A stale proposal (a missing removal or a
changed rule cap) records the human answer without changing rules. Chat sends
remain accepted and notify Neo; `neo.rule.applyAnswer` returns the typed refusal.
The real helper exercises a stale chat yes through `neo.message.send`, and the
unit journey checks notification and retry idempotency for both stale cases.
Only synthetic fixtures are used. This journey
proves the daemon operation and snapshot surfaces; GUI rendering, model choices,
notification completion and deployment are not verified. Neo's default guidance
asks for consent first; the existing direct human-message path remains available.

## Snapshot batch responsiveness

```bash
RUN=$(mktemp -d /private/tmp/hn-snapshot-batch-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/neo-snapshot-batch.ts verify 9382 "$RUN"
```

This starts a fresh isolated daemon with 181 synthetic asks. Its top 50 contain
231 todos and 66 answered questions, with instruction/report sizes shaped like
the observed snapshot. An external client sends four overlapping `neo.snapshot`
requests over the real `operation.invoke` WebSocket door. Another independent
client probes `system.health` when the first child/link query begins. No model,
provider keys, credentials, copied live rows, GitHub or GUI are involved.

The helper injects a controlled 4 ms wait per child/link statement to model the
amplification of slow reads. On regression commit `6040b602e6`, `reproduce`
records four builds and 1,324 child/link reads, max lag above 1 s and a health
reply above 1 s. Fixed `verify` requires one build, three child/link queries,
max lag below 1 s and health below 250 ms. Each of the four replies must retain
50 asks, 231 todos, 66 questions and the exact selected session link.

`observed.json` records query/build counts, max main-loop lag, independent health
latency, burst duration and reply byte sizes. Other snapshot/pack reads remain
included in the separate total-read count; this change does not claim every
snapshot query is constant or explain the physical cause of historical waits.
The helper restores its synthetic query observer and closes both client child
processes, the timer and daemon in `finally`.

Focused contracts also exercise eight overlapping reads, later-write freshness,
scope isolation, per-request revision responses, failed-build recovery, RPC/MCP
view separation and admission, child ordering and missing links. In-flight RPC
builds share only the same requested scope until synchronous construction ends;
there is no retained snapshot cache. MCP reads keep their existing per-turn
handling. `neo.open` must still reply before deferred work discovery starts.

## Workspace project mirroring responsiveness

```bash
RUN=$(mktemp -d /Users/lsm/focus/verification/project-mirror-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/project-mirror-lag.ts verify 9380 "$RUN"
```

Use a fresh directory outside the OS temporary folder: discovery deliberately
excludes temporary workspaces. This starts an isolated daemon and calls the real
`operation.invoke` / `work.find` WebSocket door with 40 synthetic tool projects.
One controlled 1.4 s filesystem wait runs inside the production mirror worker.
An independent child probes `system.health` during that wait; a concurrent
synthetic project edit must complete before the wait ends and survive mirroring.
The reply must retain all 40 groups and their original folder/project ownership.
A second mirror exercises the default production worker entry without injection.

`observed.json` records max main-loop lag, health latency, edit timing and the
default worker timing. Fixed `verify` requires lag below 1 s and health below
250 ms. `reproduce` instead runs the mirror synchronously and requires both lag
and health latency above 1 s. The fixture observes the injected wait exactly
once; operation latency still includes that wait. Unit contracts retain false
results, serialize same-database mirrors, surface failures and allow later retry.
Every owned worker, probe, socket, timer and daemon closes before exit. No live
DB, existing workspace, credentials, provider, GitHub or GUI is used.

Repeat with `memory` instead of `verify` in another fresh directory. That mode
uses the daemon's supported private `:memory:` database and retains its original
connection synchronously, since another connection cannot share it. Without an
injected filesystem wait, the real RPC must still mirror all projects and aliases,
preserve the concurrent edit and create no `:memory:` file in its own working
directory. Its 220 ms edit barrier is fixture time, not a production latency.
The unresponsive-worker contract advances a fake clock 30 seconds, requires an
explicit timeout error and termination, and confirms the queued mirror proceeds
and completion clears its timer. This is technical worker failure protection;
the private memory fallback does not claim off-thread filesystem responsiveness.

For the associated wake-query attribution, run `wake-live-size.ts verify 9379
"$RUN"` in another fresh isolated HOME/data directory using the same environment.
It seeds 107,991 synthetic SDK headers and 2,112 origins across 13 sessions,
then checks zero and two scheduled wakes through the repository and snapshot
RPC. It reports execution plans, VM steps and SQLite page-cache misses. These
are synthetic cardinalities, not copied live layout or physical disk reads.
Neither proof attributes historical no-SQL gaps or establishes that every
off-CPU stall is fixed.

## Copilot discovery boundary (worker slice 1)

```bash
RUN=$(mktemp -d /private/tmp/hn-copilot-pin-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/copilot-discovery.ts 9381 "$RUN"
```

Use a fresh synthetic HOME/data directory and free non-8399 port. The helper
places a synthetic `copilot` executable first on PATH, launches the real isolated
daemon, and calls its WebSocket `operation.invoke` door. `work.adapters` must
advertise only `find`; `work.find` must recover the fixture session's cwd from
its synthetic `events.jsonl`, page the ACP list and return the requested project.
A send, receipt-bound status and stop must return `unsupported`: discovery's
age-based status is not evidence that a submitted input completed. This pins the
pre-worker boundary; later worker slices deliberately extend it with new evidence.
The mock records exactly initialize and two list requests, proving no work was
sent or stopped. `evidence/observed.json` saves operation replies and the call log.
The helper closes its socket and daemon in `finally`. No real Copilot executable,
auth/token files, provider, model, GitHub, existing transcript or GUI is used.

Focused synthetic process tests additionally verify that the existing ACP client
loads a session, filters an unrelated session's message, accepts one streamed
response, and observes a cancelled prompt without removing history. They also
reject an incompatible ACP protocol. This characterizes the current ACP client,
not SDK worker delivery/receipt normalization, model discovery, IDE attachment or
termination of arbitrary child tools:

```bash
cd packages/daemon
bunx vitest run tests/unit/1-core/drivers/copilot-discovery.test.ts
```

## Neo goal list (G6a)

Build the web, launch a fresh isolated daemon, then run
`bun .claude/skills/verify/neo-goals-web.ts <port> "$RUN"` and the headless
`neo-goals-web.mjs <port> "$RUN"` with the same Node/Playwright/VERIFY_BROWSER
setup as the web schedule journey. Synthetic goals and journal entries are made
through real RPC: measured, paused, closed and another session's private goal.
No provider is configured and no model is called.

On `/neo` at 1280px, the Goals section must sit beside Your work. At 390px, open
Your work to reveal it. Both show only the root's two current goals, a 30% progress
bar, a done-test, the next wake matching the real schedule RPC, no wake for the
paused goal, and only the latest journal effect. A new journal entry through RPC
must appear on explicit refresh. Completing both goals through RPC and refreshing
must remove them and show the successful empty state. Inspect
`evidence/neo-goals-{1280,390,empty}.png` and `neo-goals-web.json`.

Component contracts cover loading/error versus empty, retry, journal refusal,
focus refresh, stale owner reads and Chinese labels. Goal detail, home links,
what-works notes and paginated journal evidence remain G6b; this journey does not
claim them. Stop the isolated daemon/mock with `stop.sh`; the browser closes itself.

## Claude Desktop link registration

```bash
RUN=$(mktemp -d /private/tmp/hn-claude-link-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/claude-desktop-link.ts 9383 "$RUN"
```

Use fresh synthetic HOME/data and a free non-8399 port. The real isolated daemon
calls a synthetic CLI that records the first input and remains busy. Public
`work.start`, `work.status` and `work.find` must omit the Desktop epitaxy link and
return `watchHint` directing Neo to `work.status` while no Desktop record exists.
The helper then writes a synthetic Desktop-store record and repeats find/status:
the link must appear and the hint disappear without restarting the daemon. CLI
exit or a requested Desktop handoff alone is not proof of Desktop registration.
On the reproduction commit the same journey fails on the premature start link.

`evidence/observed.json` retains every operation reply. The helper closes the
socket, stops all fixture worker PIDs and cleans up the daemon in `finally`.
Both `claude` and Desktop-launch `script` are stubbed, as is `gh`; no real CLI,
provider, auth/token files, human sessions, GitHub or GUI is used. This proves the
public response and record-discovery transition, not the live Desktop UI's import,
account access or restart behavior. For a supervised live check, have the human
observe the running CLI-only session in Neo, then after a genuine Desktop import
ask Neo to refresh find/status and have the human open the returned link. Do not
resume a second owner of a still-running CLI session, automate the GUI or restart
the human's Desktop app as part of this journey.

## In-app previews: compatibility pins (slice 1)

This tests-only slice preserves existing chat reference text, immutable handoff
bytes, and mutable workflow facts. It does not expose `artifact.file.*` yet.
Run the focused `handoff-artifacts.test.ts`, `artifact-operations.test.ts` and
web `MarkdownRenderer.test.tsx` suites. The web suite runs headlessly in happy-dom
against the actual renderer: repo/PR anchors stay intact, inline/fenced paths stay
text, and raw script examples stay inert. This is component evidence, not browser
containment or a shipped preview journey. No unattended GUI is used.

Build web and use Launch with a fresh run directory and free port, then run:

```bash
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/preview-pin.ts 9386 "$RUN" capture
.claude/skills/verify/stop.sh "$RUN"
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/preview-pin.ts 9386 "$RUN" restart
.claude/skills/verify/stop.sh "$RUN"
```

The fixture uses the existing capture shell to seed a synthetic handoff, retains
its source under a renamed fixture directory, then reads all chunks through the
real daemon `handoff.read` operation door. Both runs require identical full bytes,
size and SHA-256 and refuse a foreign daemon reference. Evidence is retained in
`evidence/preview-pin-*.json`. This proves source-path independence and process
restart, not the future registration door, scoped preview authorization, a removed
Git worktree, iOS or HTML containment. No credentials, provider/model or live DB.
