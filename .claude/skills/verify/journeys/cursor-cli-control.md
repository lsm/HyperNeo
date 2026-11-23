# Cursor CLI lifecycle

Run the isolated daemon with pinned Bun:

```bash
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/evidence \
  .claude/skills/verify/cursor-cli-control.ts -
```

The fixture checks a selected model and effort, a completed first reply, a
resumed follow-up with the same configuration, busy refusal, and a peer-confirmed stop. Repeat with the path to the
official CLI in place of `-` to check sign-in refusal under the isolated home.
The wrapper must exit successfully in both modes.
