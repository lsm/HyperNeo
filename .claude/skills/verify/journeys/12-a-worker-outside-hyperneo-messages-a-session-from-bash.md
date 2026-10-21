12. **A worker outside HyperNeo messages a session from Bash.** `session-cli.sh <port> "$RUN"`
   runs `bun packages/cli/main.ts send <B> "Tests pass."` with only
   `CODEX_THREAD_ID` set, then with no sender variable, then `question made-up`,
   all against `<run>/data/session-door.sock` (owner-only). End state: the first
   send is accepted and B's row is `task` input wrapped as
   `from-session="codex-desktop:verify-thread"`; the second exits 1 with
   `hyperneo send: no sender…` and sends nothing; the question replies
   `not_found`. Stopping the daemon removes the socket.
