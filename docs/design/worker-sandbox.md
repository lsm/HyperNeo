# Worker sandbox isolation

Minimal proposal replacing [#8056](https://github.com/lsm/HyperNeo/pull/8056) and
[#8106](https://github.com/lsm/HyperNeo/pull/8106). Human decides on this page;
this PR changes no runtime. Implement afterwards in small, separate PRs.

The relevant audit facts: a Codex worker with a worktree cwd still ran absolute-path
pulls in qlark’s main checkout; HyperNeo starts Codex with `danger-full-access`
([adapter](../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts)). Claude
starts use `.claude/worktrees` inside main
([adapter](../../packages/daemon/src/lib/drivers/claude-desktop-adapter.ts)). The
credential audit found token-bearing environment names and host tool-auth/config
locations; it did not inspect values or establish effective credential scopes.
Placement and instructions alone protect neither main nor credentials.

## 1. Write boundary and the two proof limits

Use each engine’s built-in macOS Seatbelt sandbox, never command parsing. Codex
starts with [`workspace-write`](https://developers.openai.com/codex/config-reference); tool-writable roots are its worker checkout, its
own Git metadata and specific needed temp/cache paths, never main or a broad home
ancestor. Claude Code enables its built-in sandbox with the same roots, no excluded
commands or unsandboxed retry. Neither changes the human’s main checkout.

A linked worktree stores its index and objects in main’s shared Git common dir:
without extra writes, edits/builds work but commits fail on `index.lock`.

| Commit option | Exact trade-off |
| --- | --- |
| Allow only worker admin/index, its branch/ref-log files and shared object-store paths | Keeps cheap linked worktrees; more policy paths, and writable shared objects can still corrupt main’s history. Never grant all of main’s `.git`. |
| **Recommend: standalone clone, own `.git` inside the writable root, no hardlinks to main** | More disk/fetch cost; own commits need no writable shared Git objects or refs. Explicitly permit only that clone’s `.git` where the engine protects it by default. |

Claude’s OS sandbox covers Bash and child processes, **not native Read/Edit/Write
or MCP** ([upstream scope](https://code.claude.com/docs/en/sandboxing#what-runs-outside-the-sandbox)).

| Claude option | Exact trade-off |
| --- | --- |
| **Recommend: path-scoped native file permission rules too** | Allow edits/writes only in the worker root; deny protected main/sibling paths and secret reads through the engine’s path configuration. No broad Edit/Write grants or permission bypass. This covers file tools, not arbitrary MCP/helper processes. |
| Accept the native-tool gap until containers | Less configuration; a permitted native edit can change main despite the Bash sandbox. Cannot claim worker-wide write isolation. |

Proof, installed Codex **0.160.1** and Claude Code **2.1.302**, real CLI workers with
scripted loopback models and scrubbed synthetic homes: both denied an absolute shell
write and `git pull` into a throwaway main; normal edit/commit/build succeeded in
standalone clones. Codex used `workspace-write` plus its own `.git` writable root.
Claude’s native Edit still changed synthetic main with only sandbox `denyWrite`;
a native path-permission deny then stopped it. Read/Edit/Write path rules are not
OS containment of MCP. Host IPC and HyperNeo adapter wiring remain unverified.
Evidence/scripts: `/Users/lsm/focus/verification/worker-sandbox-2026-10-22/proof-readback.json`.

## 2. Worker checkout location

Claude starts use `<HyperNeo data dir>/worktrees/<repo>/<id>`
(`~/.hyperneo/worktrees` on this laptop). Codex keeps `~/.codex/worktrees`.
Neither uses `~/focus/worktrees` or a `.claude/worktrees` directory inside main.
The clone recommendation changes Git storage, not these worker locations.

## 3. Credentials

Start with a scrubbed environment: no inherited API keys/tokens, auth sockets or
shell-profile reinjection. Deny sandbox reads of `~/.config`, `~/.ssh`, `~/.docker`,
`~/.kube`, `~/.npmrc` and engine auth files; match native Read permissions for Claude.
Deny Keychain/1Password IPC where the engine’s OS policy supports it; name any
uncovered access rather than promise credential secrecy. The only worker GitHub
credential is a human-provided fine-grained token limited to that repository and
needed permissions. It is visible to its receiving process; no host-wide token or
other service credential is handed over. No credential contents were read for this page.

## 4. Deferred

“Use without seeing” (broker, per-service adapters and grants UI) waits for containers/OAP isolation.
