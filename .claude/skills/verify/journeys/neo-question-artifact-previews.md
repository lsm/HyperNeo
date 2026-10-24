# Registered documents on Neo question cards

Build web, then use a fresh synthetic run with its own HOME/data/DB. No provider
or model turn is needed; the ordinary verify launcher may still own its mock.

```bash
RUN=$(mktemp -d /private/tmp/hn-question-artifacts-XXXXXX)
mkdir -p "$RUN/home" "$RUN/evidence"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  bun .claude/skills/verify/question-artifacts-rpc.ts "$RUN" seed
.claude/skills/verify/launch.sh 9474 "$RUN"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  bun .claude/skills/verify/question-artifacts-rpc.ts "$RUN" capture 9474
```

Use headless Chromium with an isolated context at `/neo`: the open question's
`Open preview: Synthetic review report` button opens the existing preview panel
and shows `Complete bytes`. Back closes the panel; the question's answer buttons
remain available. Repeat at 390px. Keep screenshots in `RUN/evidence/`.

Stop only this run with `stop.sh`, launch it again, and run the helper with phase
`restart`. It confirms persisted refs on question.get and neo.snapshot and reads
the exact registered bytes. Forged ID/title/daemon replacement attempts must be
refused without retiring the original question. Home-conflict `document` stays
independent. Stop the daemon and close the headless browser after verification.

Focused suites: neo-questions, neo-question-confirmation,
migration-450-neo-question-artifacts, NeoArtifactTaps and NeoAskTodos.
