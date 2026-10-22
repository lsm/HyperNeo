## Ordinary session delivery across a daemon restart

Run `bash .claude/skills/verify/spent-admission-restart.sh "$RUN"` from the
worktree root with a fresh absolute run directory. Follow SKILL.md isolation:
NODE_ENV=test, fresh HOME/data/DB, no real keys, loopback model and ephemeral
non-8399 ports. This journey uses the installed SDK and actual WebSocket RPC.

Both an ordinary session and Neo consume a kickoff. Hold a real model request,
send a human input mid-turn, interrupt, then verify that human marker reaches the
model and no input becomes failed. Stop only the test daemon,
mark that synthetic input pending for recovery, queue a space_inject head plus
four markers, then restart against the same synthetic DB/SDK history. The head
starts at its delivery retry limit to retain the dead-letter regression. Every
marker must reach an actual model request and every row must become consumed
without another send or restart. The Neo idle/query_ready state is recorded on
the failing baseline; interrupt must preserve queued inputs. The fixed ordinary
path may consume immediately, so no assertion requires that broken idle state.

Evidence is `$RUN/evidence/spent-admission-{ordinary,neo}.json` with RPC receipts,
lifecycle events, model marker receipts and durable input/job states. The fixture
handles new and existing providers through RPC, with a synthetic DB credential;
GitHub is stubbed. Daemon/SDK, socket and model server close in finally. No GUI or
real-provider behavior is verified. All receipt assertions run in CI; no known-red
case is skipped. Keep the old #8093 and #8068 branches as historical evidence.

The model request also checks intake-id scope: human messages sent through Neo's
conversation carry their stored `[message id: ...]`; the ordinary session's
human input retains its existing text with no such header. This metadata is
added by Neo's conversation intake, never the shared delivery path.
