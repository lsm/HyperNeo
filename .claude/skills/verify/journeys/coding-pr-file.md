# Coding pack: complete PR file on a question card

The coding-pack operation `neo.coding.pr.file` takes
`{context:{kind:'ask'|'todo',id},pr:'owner/repo#N'|PR_URL,path,headSha,requestId}`.
The ask's owner Neo is the only caller. Reuse the UUID for retries. The title is
the file's basename. Attach the returned `artifact` through `neo.question.ask`.
The attachment is the complete file at the PR's current head, rendered using its
existing document kind. Describe changes in the card text; never attach a diff.

Run the focused `neo-coding-pr-file.test.ts` contracts and existing preview Git
capture/resolution tests, then `bun run check`. Use a fresh directory and free
non-8399 port for this real daemon/MCP proof (no model or provider required):

```bash
RUN=$(mktemp -d /private/tmp/hn-coding-pr-file-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/coding-pr-file.ts 9483 "$RUN"
```

Keep `evidence/observed.json`, `gh.log`, and `cleanup.json`. The helper starts and
stops its own actual test daemon, registers only synthetic GitHub responses and
Git objects, invokes its coding-pack operation through the agent MCP adapter,
reads the registered complete Markdown bytes, and attaches that exact reference
to a question. Both ask and todo contexts work. Stale heads and unlisted files
refuse with `source_changed` before blob fetch. A head move or context ownership
revocation during blob capture cannot publish success. No human-tap resolver,
raw file grant, URL fetch, diff formatter, live database or credential is used.
The existing document viewer renders the returned Markdown kind; no new UI is
introduced. This proof does not automate native applications or production deploy.
