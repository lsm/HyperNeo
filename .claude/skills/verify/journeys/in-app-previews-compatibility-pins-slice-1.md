## In-app previews: compatibility pins (slice 1)

This tests-only slice preserves existing chat reference text, immutable handoff
bytes, and mutable workflow facts. It does not expose `artifact.file.*` yet.
Run the focused `handoff-artifacts.test.ts`, `artifact-operations.test.ts` and
web `MarkdownRenderer.test.tsx` suites. The web suite runs headlessly in happy-dom
against the actual renderer: repo/PR anchors stay intact, inline/fenced paths stay
text, and raw script examples stay inert. This is component evidence, not browser
containment or a shipped preview journey. No unattended GUI is used.

Build web and use Launch with a fresh run directory and free port, then run:

```bash
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/preview-pin.ts 9386 "$RUN" capture
.claude/skills/verify/stop.sh "$RUN"
.claude/skills/verify/launch.sh 9386 "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/preview-pin.ts 9386 "$RUN" restart
.claude/skills/verify/stop.sh "$RUN"
```

The fixture uses the existing capture shell to seed a synthetic handoff, retains
its source under a renamed fixture directory, then reads all chunks through the
real daemon `handoff.read` operation door. Both runs require identical full bytes,
size and SHA-256 and refuse a foreign daemon reference. Evidence is retained in
`evidence/preview-pin-*.json`. This proves source-path independence and process
restart, not the future registration door, scoped preview authorization, a removed
Git worktree, iOS or HTML containment. No credentials, provider/model or live DB.
