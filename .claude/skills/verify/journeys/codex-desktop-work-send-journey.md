## Codex Desktop work.send journey

First run `codex-send-intent-through-a-synthetic-daemon.md`. It proves that a
running Desktop acquires ownership of an unloaded thread before auto/steer delivery,
and refuses visibly if it cannot. App-server fallback is allowed only when the
Desktop process is absent for these modes. Explicit queue retains the shared
app-server queue API even while Desktop is running. A fallback turn's matching completion requests
`thread/unsubscribe`; its official idle grace can retain the thread for up to
30 minutes. No archive/unarchive or app restart transfers ownership.

After an approved deployment, save the RPC build readback and confirm it contains
the merge commit. Prepare a clearly named disposable thread with one completed, tool-free turn in
an owned bootstrap process, then confirm that process exited and owner discovery
reports `no-client-found`. A never-started thread without its source rollout is
not a valid history fixture. Record that the shared app-server loaded list omits
the thread. Neo sends one harmless marker through normal `work.send`. Audit that
same thread: Desktop owns it, its receipt-bound input/reply matches, and the
shared loaded list still omits it. The human opens it and checks the message and
absence of “open in another app”, without a restart. Keep visual acceptance
unverified until the human replies. No GUI automation or human/OAP working
threads. The controlled pre-fix reproduction remains local at
`/Users/lsm/focus/verification/codex-unloaded-owner/repro-history/`.

For new-thread acceptance, ask the human to dispatch one normal Neo task for a
repo and open that thread in the already-running Codex Desktop. Record the exact
thread ID and repo, and ask them to confirm:

1. The thread appears under that repo's project without restarting Codex.
2. It opens without “ChatGPT hit a snag” or “open in another app”.
3. They can watch the turn and type into it.

The human performs these GUI checks; never automate them. Keep Desktop acceptance
unverified until they reply. Follow `codex-desktop-repo-project-registration.md`
for the project check. Never use archive/unarchive to transfer ownership, edit
native state, or run the legacy `codex-send.ts prepare` workaround. Existing
background-owned threads may retain the official unsubscribe idle grace; this
journey does not claim immediate release.

If the no-Desktop app-server connection misses the matching completion event,
its deferred close retains the subscription for at most 30 minutes before
requesting official unsubscribe anyway. That RPC retains its existing 30-second
timeout; the socket then closes on success or failure. This does not interrupt
the turn or bypass the server's official idle grace. The real Unix WebSocket
contract also covers absent and mismatched completion notifications with a short
test-only retention deadline, requiring one unsubscribe and a closed socket.
