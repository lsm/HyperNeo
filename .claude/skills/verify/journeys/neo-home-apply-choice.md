# Apply a recorded home conflict choice

From the worktree root, run each mode with a fresh absolute directory and a free
port other than 8399. The helper starts and stops its own NODE_ENV=test CLI daemon
with an empty HOME, its own DB, synthetic Git identity and local bare remote.
It uses `env -i`, no provider credentials and a refusing gh stub. No real GitHub
repository, auth file or human home is used. There is no unattended GUI run.

```bash
bash .claude/skills/verify/neo-home-apply-choice.sh "$RUN_NORMAL" after 9417
bash .claude/skills/verify/neo-home-apply-choice.sh "$RUN_IGNORED" after 9419 ignored
bash .claude/skills/verify/neo-home-apply-choice.sh "$RUN_CHAT" after 9420 chat
```

Normal mode drives public WebSocket `operation.invoke` throughout. It creates a
real divergent `notes.md` history, answers the actual conflict question through
`neo.question.answer` and saves with `conflictQuestionId`. The exact remote bytes
must be on disk and both original commits must remain ancestors of the new merge,
which is pushed to the synthetic origin. It repeats for `direction.md`: the
version-choice answer alone refuses `confirmation_required` without a file change.
A separate root-Neo yes/no question must visibly bind the exact path and SHA-256;
only its actual human yes allows save with `questionId`. Check the decision log,
Neo-Confirmed-By trailer, exact bytes, both ancestors and clean status.

Chat mode runs the same normal/protected journey, but records each version choice
through public `neo.message.send` with `replyTo` naming the conflict question and
the exact text `Use remote`. `neo.question.get` must confirm a human answer. This
channel stores scalar text, unlike the question button's array. Both forms must
apply identically, and the protected-file choice still requires its separate yes.
The retained `before ... chat` mode records the original scalar-answer refusal.

A choice receipt must identify a generated home conflict question through its recorded full-version snapshots. It is not checked against current revisions; unrelated local or remote commits do not invalidate it.
Git still reports real merge failures; publication retains its remote revision lease.

Ignored mode creates an ignored human file before the conflict question while
origin introduces the same path. The conflict read must preserve those bytes
(the separate sync-preservation fix is now on dev). The helper asserts that
pre-save observation, then writes the same synthetic human bytes again to keep
the application baseline explicit. Save must refuse without replacing that file
or moving either head. The evidence retains both read-time and save-time bytes.

Evidence: `$RUN/evidence/neo-home-apply-choice.json` contains actual RPC replies,
commit IDs, both human answer paths and preservation assertions. All retained modes
must print PASS and the launcher must report its owned daemon stopped. The
initial tests-first commit records before-mode RPC refusing even an answered
choice. The initial implementation plus the retained ignored-file fixture
records the ignored-file publication failure before its fix.

Focused contracts also inject local commits during staging and at Git publication,
remote commits during push, incorrect/unanswered choices and
wrong protected hashes. A successful save updates the current runtime wake's
sync receipt so a subsequent Neo read returns the applied bytes rather than its
old cached conflict, without another pull.

This operation resolves **one regular conflicting document**. Multi-file
conflicts, deletion/symlink choices and Review together refuse for further human
review; a sibling protected document is never implicitly authorized. Concurrent
remote changes after local publication cause the lease-protected push to refuse:
the named local merge remains saved (the existing push_failed contract), and both
histories and changed remote history survive. Do not roll back over human edits.
Retry/reconcile that named commit through normal save after inspecting origin.

Not verified: real network remotes, provider-driven model completion, phone or
web interaction (no UI changed here). Security #7975, native Read and command-line
safety guards are unchanged. The public answer operations run normally; no
provider credential is configured and model completion is not part of this proof.
