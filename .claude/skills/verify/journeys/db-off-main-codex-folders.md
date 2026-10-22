# Codex Desktop discovery keeps health responsive

Use SKILL.md's in-process setup, pinned Bun1.4.2, fresh synthetic HOME/data/DB,
and PROOF=.claude/skills/verify/codex-snapshot-reader.ts. No model/mock/GUI is needed.
Run with `1200` after the run directory, repeat with `1200 bridge`, then `0`.
The helper creates only a synthetic external state_5.sqlite:10000 complete rows,
200folders and mixed archived/subagent threads. It calls real public work.find
for one folder and independent health RPC from a child process. Exact titles,
thread order/statuses and full folder counts must match the original snapshot.
The entire external file SHA must stay identical; unavailable external DB must
report unreachable, create no DB and recover after restoring the synthetic file.

A one-shot executing-thread wait models the folders statement's storage delay;
it does not reproduce or attribute the historical physical cause. Commit the
failing reproduction before implementation. Require main lag below1s and health
below250ms; the delayed find still exceeds250ms. The no-delay run checks RPC
latency separately. Retain evidence/observed.json and folder-reads.jsonl, including
failures. The helper closes owned workers/app/socket/probe in finally. No real
external DB or credential files are read or copied; no deployment is performed.
The helper holds an actual missing-file error reply until status/page/HyperNeo
search RPCs queue behind it. All three must succeed on the same reader with full
SDK text retained. Matching known external errors stay local; crashes/timeouts
still fail the generation. The fixture delays the reply, never fabricates it.
