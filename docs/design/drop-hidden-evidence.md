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

A missing path is refused. The daemon no longer fills in a path, so `evidence {}` now fails the existing check schema, and its `invalid_core_check` message says to name an absolute path, or on an edit to omit the check to keep the current one.

The worker sandbox does not change. It applies only to workers in a Git checkout (its marker lives in `.git`, `drivers/worker-sandbox.ts`), and those are coding todos, which never use `evidence` under rule 1. A sandboxed worker that must write outside its checkout needs the human's filesystem grant, as `docs/design/worker-sandbox.md` already says.

**3. Existing open todos keep working.** A todo that already has a check keeps it and is evaluated as before. New adds and changed checks on edits follow rules 1 and 2. An edit that omits the check or resubmits the identical check retains it, including a legacy hidden path. To keep a check on an edit, omit it. Changing the check applies the new rule. No data is rewritten.

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

The rules are code, not prompt text, and each lives where its subject lives. Both are pure functions: facts in, refusal or nothing out, with no database, clock or file system inside. Both run as steps in the existing superpipe pipelines (`neo.todo.add`, `neo.todo.edit`, `neo.ask.open`, `neo.todo.commit-add`).

**Rule 1 is in the coding pack.** Repositories are the coding pack's concept, so core does not decide which checks a coding todo may use. The pack already refuses wrongly placed coding work through its `refuse` hook in `packs/coding/todo-prs.ts`, which core calls with the todo's place (`neoTodoPlaceRefusal`), whatever pack owns the check. It already runs on add, on continue, and on every edit: the daemon routes `neo.todo.edit` through the writer pipeline in `todo-mutation-operation.ts`, whose planning step calls it (`neo-todo-mutation-planning.ts`). So no new call is needed. Rule 1 is one more case there: an `evidence` check on a todo the pack places in a repository is refused. A check equal to the stored todo's check passes, on edit and on continue alike, so an unchanged legacy check keeps working. The scope's `todo` (today typed as only its id) also carries its `check` for this.

**Rule 2 is in core.** `evidence` is a core check, so its path rule replaces `neoEvidenceRefusal` in `core-todo-checks.ts` at the same four call sites: `todo-operations.ts`, `todo-mutation-operation.ts`, `ask-record-operations.ts` and `storage/repositories/neo-todo-add-write.ts`. It no longer looks at repositories. It takes three facts:

- the check;
- the previous check on edit, so an unchanged legacy check remains valid;
- the daemon's data directory (`getDataDir()`), read by the caller and passed in.

## Tests (written first)

- A coding todo with an `evidence` check is refused. It is accepted today.
- Editing a coding todo to an `evidence` check is refused, while an edit or a continue on a todo with an unchanged legacy check succeeds.
- A todo with no repository and no evidence path is refused. Today the daemon fills in the hidden path.
- A todo with no repository and a path in a human-named persistent directory outside the default folder is accepted.
- A todo with no repository and a path inside the human's folder is accepted.
- A new todo with no repository and a path under the daemon's data directory (for example `<data>/work/...`) is refused. It is accepted today.
- A todo with no repository retains an existing registered artifact check; a new artifact check remains subject to the existing admission policy.
- An open todo whose existing check names a hidden path still completes when the file exists; editing its title or resubmitting that unchanged check succeeds, `evidence {}` is refused with the new message, while changing its check applies the new rule.
- A data-directory path in different letter case is still refused.
- A new worker brief gives the actual outcome check without a separate hidden-evidence instruction; a legacy hidden-path check gives the compatible private instruction.
- Open and completed legacy todos hide their assigned paths in projected done conditions and completion evidence after every slice.

## Not in scope

- Bulk deletion of existing `work/evidence` folders. The existing cleanup sweep continues to reclaim eligible evidence under its retention and reference rules.
- Builds and scratch folders.

## Slices

1. **Build**: rule 2 in `core-todo-checks.ts` with its unit tests, not yet called.
2. **Wire**: add rule 1 to the coding pack's `refuse` hook, swap `neoEvidenceRefusal` for rule 2 at its four call sites and stop calling `withAssignedEvidence` there. Update the prompt, error text and worker brief, including the legacy-check instruction. Retain legacy path lookup and redaction. Update `neo-todo-evidence-path.test.ts`, `human-report-locations.test.ts` and `neo-todo-add-write.test.ts` (its assigned-path case), and keep legacy projection coverage in `neo-ask-entries.test.ts`. Update `neo-prompt.test.ts` and `neo-todos.test.ts` for the prompt text. Update and run the `human-report-locations` and `core-todo-checks` verify journeys and their proofs (`.claude/skills/verify/`).
3. **Delete**: remove unused assignment code and `HYPERNEO_EVIDENCE` environment plumbing. Retain the legacy path lookup and redaction. Update the affected assertions in `worker-local-binding.test.ts`, `worker-sandbox.test.ts`, `worker-sandbox-release.test.ts`, `codex-desktop-start.test.ts`, `query-options-builder.test.ts` and `safe-process-env.test.ts`. Update and run the `worker-sandbox` verify journey and `.claude/skills/verify/worker-sandbox.ts` proof without the removed variable; update the `.claude/skills/verify/work-cleanup-sweep.ts` proof where it assumes worker evidence locations, while retaining coverage of cleanup for existing evidence. Production changes in this slice are removal only.
