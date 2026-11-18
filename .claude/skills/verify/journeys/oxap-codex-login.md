# OXAP Codex device login

Use the shared isolation and pinned Bun in `../SKILL.md`, and the pinned OXAP
binary as in `oxap-hub-settings.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 login-device
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/second/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 login-crash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/third/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 login-start-failure
```

The helper sends messages in two OXAP chats through the daemon and a real hub.
The synthetic Codex app-server reports a signed-out account. Both chats show the
same device code and link before either thread opens; the server sees two account
reads and one login request. After the matching completion, both threads open.

The first run makes the default Codex path invalid, so sign-in must use the
configured executable. The second kills the app-server during sign-in, checks
the failure reaches the chat, and confirms that another chat can sign in.

The third run rejects the device-login request and checks the chat receives a
failure card and no thread opens.
