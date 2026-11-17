# Todos end on real outcomes, not hidden evidence files

Status: proposal, 2026-11-17, tracked in #10953. Design only. Paths without a prefix are under `packages/`.

## Why

Most todos end when a file exists at `<data>/work/evidence/<todoId>/result.md`. The human never sees that folder. Workers put simulator results, screenshots, copied source, scripts and logs there. A daily cleanup normally removes finished, unreferenced todo evidence after seven days and retains referenced or in-use evidence; even with that retention, one long-running install holds more than 9 GB in about 1,750 folders.

Over one recent week of todos on that install:

- `evidence` closed about 1,330 todos, about 700 of them coding todos;
- `pr_merged` closed about 700;
- `human_confirmed` closed 3.

The human's rule is simple:

- coding work is done when its PR merges;
- anything worth keeping goes where the human can see it.

Today the code does the opposite:

- `daemon/src/lib/neo/core-todo-checks.ts`: the core `evidence` check takes a registered artifact or any absolute path.
- `withAssignedEvidence` (same file) fills in the hidden `todoEvidenceFile` (`daemon/src/lib/work-locations.ts`) when the path is omitted. It is called from `todo-operations.ts`, `todo-mutation-operation.ts`, `ask-record-operations.ts` and `storage/repositories/neo-todo-add-write.ts`.
- `neoEvidenceRefusal` (same file) refuses a coding todo whose evidence path is inside the human's folder, and tells Neo to omit the path so the daemon picks the hidden one.
- `work-locations.ts` gives every worker `HYPERNEO_EVIDENCE` and brief lines saying completion evidence is private. The variable is also passed on by `drivers/claude-native-writes.ts`, `drivers/worker-sandbox.ts` and `safe-process-env.ts`.
- `ask-entries.ts` hides these internal evidence lines from the human's view.

## The design

**1. Coding todos end on a real outcome.** A todo with a repository cannot use `evidence`. It ends on one of:

- `pr_merged`, `pr_approved` or `issue_closed`;
- `deployed` for a HyperNeo daemon deploy (the only repository that check supports);
- `human_confirmed` for anything the human must try, such as an install on a phone.

Adding a coding todo or changing its check to `evidence` is refused; unchanged legacy checks remain valid as described below. The refusal names the kinds above.

**2. Other todos keep results where the human can see them.** A todo without a repository may use `evidence` for an explicit absolute file path or a registered artifact already referenced by that todo, retaining the existing artifact admission policy. The human’s folder (`neoUserFolder` in `daemon/src/lib/neo/folder.ts`) is the default; a human may name another persistent directory. The prompts direct workers to put results in that chosen place, not the hidden work directory. Admission cannot establish whether an arbitrary path was named by the human, so it does not enforce that preference. It does enforce the one thing it can know: a new path inside the daemon's data directory (`getDataDir()`, which holds the hidden `work/` tree) is refused, because the human cannot see it. Paths are compared case-insensitively, as the current rule does.

A missing path is refused. The daemon no longer fills in a path.

Evidence checks do not grant filesystem access. A sandboxed worker must already have permission to write the chosen file under its current policy, including when work is sent to a reused or resumed worker. A path outside that boundary needs a human-approved session grant under the worker-sandbox design; until such a grant is available and effective, the worker reports blocked. Never widen a writable root automatically from an evidence path, including its parent or the default human folder. Existing secret and sibling-worker restrictions remain in force. This applies to both Codex and Claude, including Claude native-file permissions and policy recomputation.

**3. Existing open todos keep working.** A todo that already has a check keeps it and is evaluated as before. New adds and changed checks on edits follow rules 1 and 2. An edit that omits the check or resubmits the identical check retains it, including a legacy hidden path; changing the check applies the new rule. No data is rewritten.

**4. Stop assigning hidden paths.** Remove:

- `withAssignedEvidence` and its assignment callers;
- `neoEvidenceRefusal`, replaced by rules 1 and 2;
- `HYPERNEO_EVIDENCE`, its worker environment plumbing, and the general brief lines about private completion evidence.

Keep `todoEvidenceFile` and the `ask-entries.ts` redaction for legacy records: their hidden paths remain masked in both done conditions and completion evidence, including historical and open todos. This lookup does not assign or create a path. For an existing todo whose check already names its assigned hidden path, the worker brief must still instruct the worker to satisfy that exact check privately. If that path is outside its sandbox, the worker reports blocked until authorized access is available; do not grant the hidden directory automatically. New todos receive only their actual outcome check and no instruction to write separate hidden evidence.

Builds and scratch stay as they are: temporary folders that clean themselves.

Neo's prompt text changes to match:

- the `root.md` line "Completion uses core.evidence {} separately";
- the `neo.todo.add` tool text, which today calls an omitted path "preferred: the daemon assigns the path";
- `root-turn-end.md`, which directs todos to use an assigned path;
- `life-admin/instructions.md`, which should continue to allow the human’s requested persistent directory while requiring an explicit path;
- the `invalid_core_check` message in `core-todo-checks.ts`, which advertises the assigned path. Audit related prompt and error text for the same obsolete guidance.

## How it is built

Evidence admission already runs at four places, each a step on the add, edit and open paths: `todo-operations.ts`, `todo-mutation-operation.ts`, `ask-record-operations.ts` and `storage/repositories/neo-todo-add-write.ts`. Today each calls `neoEvidenceRefusal`.

Rules 1 and 2 become one pure function in `core-todo-checks.ts`, and those four call sites use it instead. The function takes four facts:

- the check;
- whether the todo has a repository;
- the previous check on edit, so an unchanged legacy check remains valid.
- the daemon's data directory (`getDataDir()`), read by the caller and passed in.

It returns a refusal or nothing, and it reads no database, clock or file system.

## Tests (written first)

- A coding todo with an `evidence` check is refused. It is accepted today.
- A todo with no repository and no evidence path is refused. Today the daemon fills in the hidden path.
- A todo with no repository and a path in a human-named persistent directory outside the default folder is accepted.
- A todo with no repository and a path inside the human's folder is accepted.
- A new todo with no repository and a path under the daemon's data directory (for example `<data>/work/...`) is refused. It is accepted today.
- A todo with no repository retains an existing registered artifact check; a new artifact check remains subject to the existing admission policy.
- An open todo whose existing check names a hidden path still completes when the file exists; editing its title or resubmitting that unchanged check succeeds, while changing its check applies the new rule.
- For Codex and Claude, starting, sending to a reused worker and resuming never widen sandbox access for an evidence path; policy recomputation preserves existing grants and denials. Exercise paths in shared directories, the filesystem root, secret locations, sibling workers and legacy hidden evidence. An inaccessible check remains pending and the worker reports blocked.
- A data-directory path in different letter case is still refused.
- A new worker brief gives the actual outcome check without a separate hidden-evidence instruction; a legacy hidden-path check gives the compatible private instruction.
- Open and completed legacy todos hide their assigned paths in projected done conditions and completion evidence after both slices.

## Not in scope

- Bulk deletion of existing `work/evidence` folders. The existing cleanup sweep continues to reclaim eligible evidence under its retention and reference rules.
- Builds and scratch folders.

## Slices

1. **Build**: add the pure admission rule and tests without changing callers. Keep production reachable through the existing core module. Pin current behavior and legacy projections before wiring.
2. **Wire**: migrate each of the four admission paths in its own PR. At each path apply the new rule to the original check before any assignment, and stop assigning paths there. Update that path's tests; preserve the other paths until their own PRs. The last Wire PR updates the shared prompts, error text and worker brief, including the legacy-check instruction. Update and run the `human-report-locations` verify journey and executable proof for new checks, inaccessible sandbox paths and legacy redaction. The transition temporarily has different admission rules across paths; do not claim rollout complete until all four are wired.
3. **Delete**: remove unused assignment code and `HYPERNEO_EVIDENCE` environment plumbing, retaining legacy path lookup and redaction. Update affected assertions in `neo-todo-evidence-path.test.ts`, `human-report-locations.test.ts`, `neo-todo-add-write.test.ts`, `neo-ask-entries.test.ts`, `worker-local-binding.test.ts`, `worker-sandbox.test.ts`, `worker-sandbox-release.test.ts`, `codex-desktop-start.test.ts`, `query-options-builder.test.ts` and `safe-process-env.test.ts` in the slice that changes each behavior. Update and run the `worker-sandbox` verify journey and `worker-sandbox.ts` proof without the removed variable; update `work-cleanup-sweep.ts` where it assumes worker evidence locations, retaining legacy cleanup coverage. Production changes in Delete are removal only.
