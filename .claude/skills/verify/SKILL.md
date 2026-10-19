---
name: verify
description: Prove a HyperNeo change works by running an isolated daemon and web UI and driving it like a user. Use before saying a change is done.
---

# Verify HyperNeo

Run the change where a user would meet it: an isolated daemon, its RPC door and
its web UI. Lint, types and unit tests are not proof. Every helper named here
lives next to this file in `.claude/skills/verify/`. Run commands from the repo
root of your worktree.

## Rules

- Never touch the human's daemon: never port 8399, never `~/.hyperneo`, never a
  copy of a real database.
- No provider key in the environment, real or fake. `launch.sh` starts from
  `env -i` with `NODE_ENV=test`, a temp `HOME`, and its own data dir and DB, so
  credential discovery is off and keys stay in that DB, never the keychain.
- Model turns go to a local mock of the Anthropic API (`mock-api.ts`, the same
  server CI's dev-proxy mode uses) on port 8000. Give the isolated daemon the
  dev-proxy key over RPC (step 3 below), never through its environment.
- GitHub is a stub: `gh` on the daemon's `PATH` answers `gh pr view` from
  `<run>/pr.json`, refuses everything else (including `gh auth token`) and logs
  every call to `<run>/evidence/gh.log`. Nothing reaches github.com.

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

Give it a model, once per run (stored in the run's DB only):

```bash
VERIFY_PORT=9311 bun .claude/skills/verify/rpc.ts rpc:providers.create \
  '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}'
```

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
  `sqlite3 -readonly "$RUN/data/daemon.db" "SELECT ..."`. Only `seed-todo.sh`
  writes to it, to set up journey 3.
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
4. **The web UI renders.** `/neo` shows the conversation with the human message
   marked Received; `/session/<root>` shows root's transcript, including the
   mocked replies and the todo note. The session view takes a few seconds to
   load; wait for the transcript before the screenshot.

6. **A cross-repo request becomes one card per repo.** Launch with
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

5. **Session PR links come from the desktop apps' own stores.** Read-only, on the
   human's machine: `bun .claude/skills/verify/linked-prs.ts claude <local_id>`
   prints the `linkedPrs` that `work.status` reports for a Claude Desktop session
   (its `prs[]`, with `dismissed`); `... codex <thread_id>` prints a Codex
   thread's `pull_request` attachments from `~/.codex/state_5.sqlite`. It never
   reads credential files. End state: the list matches the app's sidebar.
   `bun .claude/skills/verify/pr-owners.ts` replays the coding pack's owner
   choice over every local Claude, Codex and HyperNeo session against the live
   ledger (opened `?mode=ro`) and prints owned-before/after counts plus each
   owner change; check every change names the session that created the PR.

## Evidence

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

`stop.sh` stops only the daemon and mock it started, by their pid files. Close
the browser tab you opened. Delete `$RUN` once the evidence is in the PR.
