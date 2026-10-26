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

For restricted workers, use each engine’s built-in macOS Seatbelt sandbox, never command parsing. Codex
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

Proposed: Claude starts use `<HyperNeo data dir>/worktrees/<repo>/<id>`
(`~/.hyperneo/worktrees` on this laptop), replacing the current in-main
`.claude/worktrees` location. Codex keeps `~/.codex/worktrees`.
Neither proposed worker location uses `~/focus/worktrees` or `.claude/worktrees` inside main.
The clone recommendation changes Git storage, not these worker locations.

## 3. Reusable session access and credentials

Access belongs to a long-lived session, reused across tasks; never create a session
per task. Most workers default to restricted: their own worktree, scrubbed environment,
no service keys. Normal edit/build/test/commit/push and opening/merging PRs use one
fine-grained GitHub token scoped to the repository and needed permissions.

At creation, the human may explicitly grant an ops/deploy session specific keys
(e.g. `WOODPECKER_TOKEN`, `CLOUDFLARE_API_TOKEN`) and wider filesystem roots, up to
broad machine access. Store writable roots, key names and broader access on the
session; grants are human-approved, visible in the UI and revocable. Projects/packs
may suggest defaults; they cannot approve them. Revocation stops the running worker;
resume omits the grant. Already disclosed keys need rotation to become unusable.
Neo dispatches coding to the restricted
pool and deploy/server checks to an appropriately granted session, never widening
a coding session to fit a task.

Move keys out of `~/.zshrc` into one store (Keychain or 1Password, chosen for the
deployment). On start/resume, the daemon injects only that session’s granted keys.
Scrub inherited API keys/tokens, auth sockets and shell-profile reinjection.
For restricted sessions, deny reads of `~/.config`, `~/.ssh`, `~/.docker`, `~/.kube`,
`~/.npmrc` and engine auth files; match native Read permissions for Claude. Deny
Keychain/1Password IPC where the engine’s OS policy supports it; state uncovered
access explicitly. A granted key is visible to the agent: prefer narrowly scoped
tokens, never grant Alpaca/trading keys. No credential contents were read for this page.

## 4. Deferred

“Use without seeing” (broker and per-service adapters) waits for containers/OAP isolation.

## Implementation slices

Slice 2 (#8203) prepares coding work in private Git clones. Slice 3 (#8627)
adds OS write enforcement to prepared workers (including HyperNeo SDK sessions): Codex `workspace-write` at thread
creation and the opening turn, Claude's Bash sandbox without unsandboxed retry,
and private short temp/cache roots. Existing Claude native-file path rules remain.
Codex 0.160.1 `workspaceWrite` has no per-path read-deny configuration; it does
not enforce the secret-read boundary in section 3. Secret-read isolation is a
separate later slice, #8630. Neither slice 3 nor Claude Bash sandboxing claims
OS containment of native file tools or arbitrary MCP/helper processes.

Prepared Claude starts/resumes explicitly pass the clone's generated settings file;
local-source loading alone does not apply its protected environment variables.
Runtime roots are re-created on resume/query and sibling-policy refresh. Claude
HTTP(S) hosts are allowed through its proxy. Unix sockets are denied by default;
only human-approved exact paths in Worker Unix sockets are granted to new sessions.
Live GitHub push/authentication is unverified.

Pre-upgrade prepared Claude sessions repair missing env/sandbox defaults before
resume. Sibling permission refresh supplies defaults for absent/corrupt settings
but preserves complete existing env/sandbox values and never provisions another
worker's runtime. Policy replacements are atomic within the prepared clone.

Slice 4 (#8630) selects the installed app-server's experimental named permission
profiles at thread creation, opening turn and future-turn settings updates.
`hyperneo-worker` defines explicit private write roots, normal filesystem reads,
and secret-path read denials; no legacy sandbox selector may override it. This
uses the engine's OS enforcement instead of a second daemon Seatbelt wrapper or
removing host paths. Unknown/unsupported profiles fail closed. Pre-profile Codex
threads may need recreation rather than a workspaceWrite fallback.
The daemon also installs the profile in the clone's protected `.codex/config.toml`
so Desktop can resolve it after the bootstrap process exits. Existing project
settings and other profiles survive; generated config is locally Git-excluded.
Clones tracking that config path are refused without modification. Codex's
existing workspace protections for `.agents` and `.aws` stay read-only; `.codex`
also protects the generated profile. This retains slice 3's Git/tooling limits.
The shared home credential list supplies Azure/GCloud/GnuPG and histories, but
workers narrow its broad Library entry to Keychains and 1Password so Library
toolchains remain readable. Section 3 deliberately denies all of `.config`;
tools needing those configurations must use explicit session grants later.
Startup requires confirmed profile provenance; queue admission requires the
profile catalog to recognize and allow it before changing settings or sending.
Home `.env`/`.env.*` and PEM/key filename patterns are denied too. Codex uses
the engine's depth-16 bounded glob snapshot on Linux; future matching files and
deeper paths require a fresh sandbox or explicit credential-directory rules.
Claude persists matching Bash `denyRead` and native `Read` denies, including on
legacy resume and sibling refresh. Covered paths include section 3's tool-auth
locations, engine auth files and shell profiles, with configured engine-home
locations included. Keychain/1Password IPC and arbitrary MCP processes remain
uncovered. Policy tests run inside prepared workers; the real OS denial/allowed
repo-read proof is `worker-secret-read.md`, run by Neo after deployment on a host
that can apply a fresh sandbox. Nested sandbox failure is not OS proof.
