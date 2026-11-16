# Coding session strategy question

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-strategy-question.ts
```

The helper boots an isolated daemon with the coding pack, creates a Neo session
and an idle `backend` session over RPC, and records one finished synthetic
coding todo that worked there. No `sessionStrategy` is saved for the repo.

- The todo runner starts a ready slice: it is sent to the idle backend session
  (long-lived reuse), and one choice card opens with Long-lived, Per task, Per
  PR and Keep, naming the repo. The card holds no todo, so the slice runs.
  Nothing is saved.
- The coding pack's `workerTarget` hook decides work from another ask in the
  repo: still long-lived (`backend-2`, since the backend session is busy), and
  no second card opens.
- The human picks One session per task over RPC. `per_task` is saved for the
  repo with human provenance.
- The next decision keeps its own `backend` start instead of `backend-2`, and
  no new question opens. One strategy proposal exists in total.

Replies and decisions are kept in `evidence/strategy-question.json`. No live
database, provider, credentials, model or GUI is used.
