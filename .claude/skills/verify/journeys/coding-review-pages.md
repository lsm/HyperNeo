# GitHub CLI pagination stays JSON through the lookup helper

Use the fresh home setup from `../SKILL.md`. This helper runs the installed `gh`
against its own ephemeral loopback HTTP server, returning 100 records and a Link
header to a second page with the last record. No daemon, model, provider or
GitHub account is needed. The helper supplies a synthetic GitHub token only to
satisfy the CLI's authentication preflight; all requests stay on localhost.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-review-pages-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  bun .claude/skills/verify/coding-review-pages.ts "$RUN"
```

Pass: `evidence/observed.json` records exactly two local HTTP requests and the
production `runGhJson` result containing both page arrays, in order, with all
101 records. No implicit `--include` is appended to `--slurp`: real gh otherwise
interleaves page headers into the JSON array. Other calls keep their HTTP metadata.
The server closes in finally. Keep evidence outside the worktree.

Use `coding-merge-admission.md` to check the actual daemon operation: its fixture
includes a null-user ghost page, a current bot approval page and a human sign-off
page. Unknown identities cannot supply approval; current identified reviews still
permit admission. Unit tests also put a later bot rejection on another page to
prove it overrides an earlier approval. No live GitHub acquisition, merge or
deployment is claimed by these local proofs.
