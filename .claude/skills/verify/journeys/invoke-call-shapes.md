# Resident tools and full schema discovery

Run the metadata-only helper through the shared isolated setup in SKILL.md:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/invoke-call-shapes.ts verify
```

The helper builds Neo and work operations against a synthetic in-memory database
and connects real SDK MCP clients. Neo receives invoke plus seven resident family
tools. Thirteen full operation schemas, including retained coding reads and the
snapshot index, come from operations.describe and must match their live Zod inputs.
Plain sessions retain one invoke tool and its original description.

A restored AgentSession must refresh its cached MCP tools when its resolver is
replaced and when the same resolver changes roles. It records all five role
observations, the Neo/plain tool definitions and full schemas. Shared disposable
HOME/data setup and cleanup belong to SKILL.md. The helper closes its own
transports, session and database. No provider, model or external network is used.
