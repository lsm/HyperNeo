# Core call shapes on the single MCP invoke tool

Use the shared metadata-only setup in SKILL.md:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/invoke-call-shapes.ts verify
```

The helper builds the real Neo and work operation catalog against an isolated
in-memory database, connects a real SDK MCP server/client with in-memory
transports, and reads `tools/list`: the surface an agent sees before calling
`invoke`. No provider, model, network listener, GUI or simulator is used.
Shared disposable HOME/data setup and cleanup belong to SKILL.md.

Pass: exactly one tool named invoke in both Neo and plain sessions. Only the
resolved Neo caller role receives the shapes block; the plain session retains
the exact unaugmented description (saved as `plain-tools.json`). Neo
description includes all thirteen
frequent/error-prone operations, required fields and enum values from their
current Zod input schemas. The compact block uses generated aliases for repeated
objects, omits the string type annotation, and factors common union fields with
`&`. Its complete description stays below 3,000 characters. The helper also
expands aliases and compares each advertised shape with the live schema-derived
signature. It saves the actual Neo MCP response as `tools.json`.

Role-gating baseline (#9038): before that fix, the helper fails the plain
description equality check because the shapes block is present. The signed
test-first commit 20af32b73 records the same failure through AgentSession.
The integration test covers Neo, plain, and all worker roles on both cached
and per-input servers, with identical names and models.

Baseline: before the fix, MCP lists invoke without any call shapes and the
helper fails `Missing work.send`. Commit 6ea05e192 also records the failing
schema-mutation regression. The focused MCP/discovery tests change an advertised
enum and cover required union branches and array precedence.

This verifies MCP description discovery, not worker execution, model behavior,
or reductions in real-world schema-error counts. The helper closes its own
MCP transports and database in finally; the shared wrapper removes its run.
