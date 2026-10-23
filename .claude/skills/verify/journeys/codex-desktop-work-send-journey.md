## Codex Desktop work.send journey

First run `codex-send-intent-through-a-synthetic-daemon.md`. It proves the two
admissions separately without a GUI: new-thread handoff opens Desktop and starts
through its confirmed owner, while existing-thread delivery survives an absent
owner and a refused launcher. The unit contracts also cover a hung launcher for
existing steer, resume/start and active-writer queue paths. Neither an open
request nor a queue receipt proves that Desktop rendered or consumed the input.

After an approved deployment, save the RPC build readback and confirm it contains
the merge commit. Use one authorized existing Codex verification thread for one
`work.send`; retain its input ID, delivery result and receipt-bound `work.status`
readback showing the matching input was consumed. Do not send test messages to
an arbitrary human working thread. A queued but unconsumed input is not a pass.
Do not restart either daemon or Codex to make delivery work.

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
