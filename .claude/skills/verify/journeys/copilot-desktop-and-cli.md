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

A single Copilot adapter should appear in each mode. When both discovery
sources contain the same identity, the Desktop title, workspace link, and saved
status win. Verify Desktop history, exact input lookup, and settled turn facts.
The daemon must refuse sends to a Desktop-owned session and preserve the App
database. CLI start is available only when the CLI is present. Use the Copilot
owned lifecycle and input delivery journeys for CLI mutation proof.

In `desktop` mode, discovery waits for a briefly locked App database, then
reads a WAL database without writable sidecars and reports an unsupported
schema after the fixture renames the session table. In `both` mode, schema
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
authenticated Desktop peer. Start work through HyperNeo with a model and effort.
Check an App settings mismatch prevents the initial prompt, and the accepted
settings come back from the stored session. Submit and withdraw one queued message, stop
the initial turn, send a follow-up, read its reply with the receipt, then
rename and archive the same work. In dual mode, the startup reference must
come from the Desktop peer. Neo's driver refresh must record compaction for
the idle Desktop worker after the matching attempt completes. An unrelated
completion must leave the original reply intact and must not count as
compaction. The local channel also requires the OS listener
to belong to the advertised PID before authenticating. The focused daemon
tests cover stale advertisements, uncorrelated errors, uncertain sends and
the pre-dispatch-only CLI fallback.

Repeat with `compact-failure` and `compact-refused`. A failed completion or a
refusal to queue must each record one failed attempt and a retry delay. The
peer must receive one command and the prior reply must remain readable.

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
The script emits action results and the requested settings.
Append `compact` to exercise manual compaction and confirm that the App
journal records it as applied before the test session is archived.

The CLI also exposes start, send, queue, withdraw, stop, rename, and archive
for daemon-owned sessions. Neo can compact an idle owned CLI worker kept for
reuse. In `cli` mode, start with an explicit model and `high` reasoning
effort. Verify the SDK confirms both before the first prompt, and that start
and status report the applied effort. Unsupported effort and a runtime
configuration mismatch both prevent prompt delivery.

Strict same-turn steering remains unsupported. In the App, an immediate send
after the original turn ends can start a new turn.
