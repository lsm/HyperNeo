# Todos end on real outcomes, not hidden evidence files

Status: proposal, 2026-11-17, tracked in #10953. Design only. Paths without a prefix are under `packages/`.

## Why

Most todos end when a file exists at `<data>/work/evidence/<todoId>/result.md`. The human never sees that folder, and nobody reads it. Workers put simulator results, screenshots, copied source, scripts and logs there, and it only grows. On one long-running install it holds more than 9 GB in about 1,750 folders.

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
- `deployed` for a deploy;
- `human_confirmed` for anything the human must try, such as an install on a phone.

Adding or editing a coding todo with an `evidence` check is refused. The refusal names the kinds above.

**2. Other todos keep results where the human can see them.** A todo without a repository may use `evidence` only for:

- a file inside the human's folder (`neoUserFolder` in `daemon/src/lib/neo/folder.ts`: `~/HyperNeo` or the configured workspace root);
- a registered artifact.

A missing path is refused, and so is a path outside that folder. The daemon no longer fills in a path.

**3. Existing open todos keep working.** A todo that already has a check keeps it and completes as before. Only new adds and edits follow rules 1 and 2. No data is rewritten.

**4. The hidden path goes away.** Remove:

- `withAssignedEvidence`, `todoEvidenceFile` and their callers;
- `neoEvidenceRefusal`, replaced by rules 1 and 2;
- the hiding helper in `ask-entries.ts`;
- `HYPERNEO_EVIDENCE`, the `work/evidence` location, and the brief lines about private completion evidence.

Builds and scratch stay as they are: temporary folders that clean themselves.

Neo's prompt text changes to match:

- the `root.md` line "Completion uses core.evidence {} separately";
- the `neo.todo.add` tool text, which today calls an omitted path "preferred: the daemon assigns the path".

## How it is built

Evidence admission already runs at four places, each a step on the add, edit and open paths: `todo-operations.ts`, `todo-mutation-operation.ts`, `ask-record-operations.ts` and `storage/repositories/neo-todo-add-write.ts`. Today each calls `neoEvidenceRefusal`.

Rules 1 and 2 become one pure function in `core-todo-checks.ts`, and those four call sites use it instead. The function takes three facts:

- the check;
- whether the todo has a repository;
- the human folder, already resolved by each caller (`userFolder`).

It returns a refusal or nothing, and it reads no database, clock or file system.

## Tests (written first)

- A coding todo with an `evidence` check is refused. It is accepted today.
- A todo with no repository and no evidence path is refused. Today the daemon fills in the hidden path.
- A todo with no repository and a path under `<data>/work` is refused. It is accepted today.
- A todo with no repository and a path inside the human's folder is accepted.
- A todo with no repository and a registered artifact is accepted.
- An open todo whose existing check names a hidden path still completes when the file exists.

## Not in scope

- Deleting the existing `work/evidence` folder on an install. That is an operator decision, made after this ships.
- Builds and scratch folders.

## Slices

1. **Wire**: the pure rule replaces `neoEvidenceRefusal` at its four call sites, plus the prompt text and the tests above.
2. **Delete**: `withAssignedEvidence`, `todoEvidenceFile`, `HYPERNEO_EVIDENCE`, the `work/evidence` location, the brief lines and the `ask-entries` helper. Removal only.
