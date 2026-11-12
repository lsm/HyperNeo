# Retired Write plan operation

Use the shared isolated setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/retired-write-plan.ts
```

The helper owns a real daemon with a fresh database and an ephemeral loopback
port. Through its MCP invoke entry, the retired Write planner must return unknown
operation, describe must report absent and prefix discovery must be empty with
the coding pack enabled and disabled. Coding assignment remains registered.
The failing baseline is the same helper against the pre-retirement application.
The wrapper retains observed replies and exit status and removes temporary data.

`coding-stage-preferences.md` and `lane-a-stage-target-db.md` cover preference
persistence and the retained assignment selector. The coding skill selects Write
targets and passes them to the existing todo start. This metadata proof does not
start a native worker or exercise a model turn.
