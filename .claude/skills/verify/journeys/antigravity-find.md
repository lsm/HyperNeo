# Discover Antigravity CLI sessions

Use the isolated daemon and pinned Bun from the Verify skill. Run each mode
with a fresh evidence directory.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fixture-evidence \
  .claude/skills/verify/antigravity-find.ts fixture
bash .claude/skills/verify/proof-run.sh /absolute/absent-evidence \
  .claude/skills/verify/antigravity-find.ts absent
bash .claude/skills/verify/proof-run.sh /absolute/signed-out-evidence \
  .claude/skills/verify/antigravity-find.ts signed-out /absolute/vendor/agy
```

The daemon's real RPC catalog exposes `antigravity-cli` only when the executable
is present. The ACP fixture returns the matching session on page two. Verify
its source, title and workspace through `work.find` and check the journal for
one `initialize` and two `session/list` calls. Discovery must not load or modify
sessions. The vendor binary in an isolated, signed-out home must surface its
sign-in requirement through the same operation. Require exit code 0 in each
mode. The fixture does not verify discovery from a signed-in account.
