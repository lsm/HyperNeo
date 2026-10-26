# Explicit attachment paths and immutable revisions

Use the shared metadata-only isolation and `proof-run.sh` setup in SKILL.md with
`PROOF=.claude/skills/verify/attachment-paths.ts`. The helper takes its disposable
run directory as its last argument. No provider, model turn or web build is
needed: this journey changes the registration RPC, with no viewer change.

The helper owns an ephemeral loopback daemon and synthetic native-session state.
Through `operation.invoke` it registers a file outside the workspace, a blocked
report in a protected home dot-folder, and an absolute file for a known owner with
missing native cwd. Relative paths still need an authoritative workspace.

Reusing a request after editing its source must return a new artifact ID. Read
both IDs through `artifact.file.read` and require the original and updated bytes
respectively. An unchanged retry returns the latest receipt, including after the
source is renamed; a different chosen source also creates a revision. Existing
snapshot ownership checks stay in force, independently of registration admission.

The review regression also uses inert sentinels for `.claude.json`, GitHub's
`hosts.yml`, Claude transcript JSONL, shell history and browser `Cookies`. Each
must return `sensitive_path`. Entire home dot-folders are denied even for benign
names, and `.config/gh` is a credential directory wherever it sits. Explicit files
in ordinary outside folders and repository worktrees remain allowed. Retry an unchanged ask-context registration first
through local RPC and then Neo's MCP operation door: the receipt must stay equal.

For the native operation-door proof without a listening socket, use the shared
`proof-run.sh` setup with `PROOF=.claude/skills/verify/preview-register.ts`.
It saves `review-findings.json`, asserting the same sensitive-path refusals and
equal worker/Neo receipts through `invokeOperation`. This supplements the daemon
proof; a loopback launch denied by the host remains an explicit verification gap.

Credential names, secret names, traversal, final symlinks and parent-directory
symlinks must refuse before returning file bytes. All paths are synthetic; the
proof uses only inert synthetic sensitive-file sentinels. Save `attachment-paths.json` and the proof
log; the wrapper deletes all temporary daemon data after saving them.

Run preview-register, preview-policy, native/Claude binding, preview-candidates,
preview-resolve, preview-safe-open and preview-capture tests. The registration
suite also runs this RPC helper. Existing registration helpers prove latest
receipt persistence across SQLite reopen, old receipt compatibility, concurrent
idempotency, immutable history, invalid content and size refusals. The RPC proof
helper also opens a synthetic file anchored at `/`, preserving no-follow checks.

Before the fix, the same RPC helper records `outside_roots`, `unavailable` and
`source_changed`. After the fix its evidence must say `passed: true` and
`oldAndNewBytesRead: true`. GUI layout is outside this backend journey.

After merge use `hyperneo build` to confirm the live served commit contains the
merged change. Never restart the human's daemon to satisfy that check.

The home-folder regression in preview-register.ts saves home-folder-policy.json.
Before the fix all four home dot-folders and a copied credential directory accept
synthetic report.md files; afterward all refuse sensitive_path while the ordinary
explicit outside file still registers. Policy tests cover absolute and relative
forms. Native adapter binding tests preserve normal repository worktrees while
denying sources inside protected home application folders.

Caller-authorization regression: the native helper saves caller-authorization.json.
A bound worker can register a file outside its workspace, but a foreign worker
cannot register into that todo. Unknown contexts synthesize a binding only when
the context ID is the calling session ID; other sessions and arbitrary missing
contexts refuse unavailable. Recheck authority before returning retry receipts
or saving a revision, including revocation during a source-removal retry. Missing
native cwd retains the authoritative owner binding and still permits an absolute
file. The RPC helper refuses arbitrary unknown contexts, and the native helper
proves own-session fallback. Cross-caller unchanged retries remain identical.
