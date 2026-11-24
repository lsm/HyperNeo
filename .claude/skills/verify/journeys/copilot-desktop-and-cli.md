# Copilot Desktop and CLI

Run each mode on a build or verification host with the pinned Bun and a fresh
absolute evidence directory. Select a free loopback port other than 8399.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/new-evidence \
  .claude/skills/verify/copilot-desktop.ts 9386 both
```

Repeat for `desktop` and `cli`. Each run starts the real daemon and invokes
its public operations. The standalone Desktop state and transcripts are
synthetic. The CLI uses the pinned SDK with the framed-protocol fixture.

A single adapter named Copilot should appear in each mode with the available
start clients. An explicit Desktop selection must report disconnection without
sending a CLI prompt. With a Desktop peer attached, an explicit CLI selection
must reach the CLI without calling the peer, or report that the CLI is missing.
Automatic starts report the actual client and prefer the available Desktop
peer. When both discovery
sources contain the same identity, the Desktop title, workspace link, and saved
status win. Verify Desktop history, exact input lookup, and settled turn facts.
The daemon must refuse sends to a Desktop-owned session and preserve the App
database. CLI start is available only when the CLI is present. Use the Copilot
owned lifecycle and input delivery journeys for CLI mutation proof.

In `desktop` mode, discovery waits for a briefly locked App database, then
reads a WAL database without writable sidecars and reports an unsupported
schema after the fixture renames the session table. The adapter catalog must
work with the App disconnected, and the source WAL database must stay intact.
Use a proof directory with spaces and URI characters when checking the
read-only fallback. In `both` mode, schema
drift preserves CLI matches with an unavailable note. A search with no
fallback matches reports the Desktop error as unreachable.

In `cli-failure` mode, the CLI listing fails while Desktop is readable.
Discovery still returns the Desktop session and warns that CLI results are
unavailable. A query with no fallback matches reports the CLI error.

Replay the cursor from the first completed turn to read the next turn, even
when both ended at the same time. With schema drift, unknown transcript and
input-marker lookups return `not_found` in both Desktop modes.

In `desktop` mode, append enough history to move a saved cursor out of the
read window and confirm the next completed turn is still returned. In `both`
mode, search for a Desktop session whose title and workspace name are missing.

Use `control` and `both-control` with the same command to attach a synthetic
authenticated Desktop peer. `control` uses the App 1.5 repository protocol.
`both-control` closes the repository probe and confirms the legacy App 1.4
protocol with a project-list reply. Check the probe happens before either creation command.
Start work through HyperNeo with a model and effort.
Check an App settings mismatch prevents the initial prompt, and the accepted
settings come back from the stored session. Submit and withdraw one queued message, stop
the initial turn, send a follow-up, read its reply with the receipt, then
rename and archive the same work. In dual mode, the startup reference must
come from the Desktop peer. Neo's driver refresh must compact the idle
Desktop worker once before it sends the next todo of the same ask. An unrelated
completion must not count as compaction. The local channel also requires the OS listener
to belong to the advertised PID before authenticating. The focused daemon
tests cover stale advertisements, uncorrelated errors, uncertain sends and
the pre-dispatch-only CLI fallback.

Repeat with `compact-failure` and `compact-refused`. A failed completion or a
refusal to queue must each still send the next todo. The peer must receive one
compaction command.

The peer proves routing and receipt handling in an isolated daemon. With
separate approval to use the signed-in macOS App's local connection credential
for this run, verify the driver directly:

```bash
bun .claude/skills/verify/copilot-desktop-live.ts --attended gpt-5.4 high
```

The proof creates a disposable local folder and one App session without a
daemon. It checks the effective model and effort in the runtime's start
event, stops a live turn, confirms that a withdrawn input did not run, reads
the follow-up by its receipt, and archives the session with the folder retained.
Use a model and effort available to the App's signed-in account. The script
emits action results and the requested settings.
Use `--attended --defaults` for a lifecycle run on an account without a model
and effort pair to select. That run makes no assertion about explicit settings.
Append `compact` to exercise manual compaction and confirm that the App
journal records it as applied before the test session is archived.

The CLI also exposes start, send, queue, withdraw, stop, rename, and archive
for daemon-owned sessions. Neo compacts an idle owned CLI worker before
reusing it for the same ask. In `cli` mode, start with an explicit model and `high` reasoning
effort. Verify the SDK confirms both before the first prompt, and that start
and status report the applied effort. Unsupported effort and a runtime
configuration mismatch both prevent prompt delivery.

In `cli`, `control` and `both-control`, steer during active work. The peer
must receive exactly one immediate send and return a receipt that can be
observed via status. Copilot can start a later turn if the active one ends.
