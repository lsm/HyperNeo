## Codex Desktop work.send journey

First run `codex-send-intent-through-a-synthetic-daemon.md`. It proves that
automatic input routes by Desktop ownership: while Desktop is running it
delivers through the owner client and never resumes the app-server writer;
while Desktop is not running it uses the native app-server queue, resuming
saved unloaded threads before settings or enqueue and never resuming loaded
active threads. Explicit steer uses Desktop ownership when Desktop is running
and the app-server otherwise. A fallback turn's matching completion requests
`thread/unsubscribe`; its official idle grace can retain the thread for up to
30 minutes. No archive/unarchive or app restart transfers ownership.

For this regression, the synthetic daemon journey is the acceptance surface. It
checks unloaded-thread ordering, queue delivery and typed failures without any
real threads, live daemon or Desktop GUI. Native Desktop rendering and ownership
after a queued turn remain unverified; perform any later human-operated GUI
check only with separate explicit authorization and a disposable thread.

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
