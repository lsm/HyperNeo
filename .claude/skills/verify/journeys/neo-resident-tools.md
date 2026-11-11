# Resident family tools

Use the pinned Bun and run `proof-run.sh <absolute-evidence-directory>
.claude/skills/verify/neo-resident-tools.ts`. The helper owns a disposable test
daemon on an ephemeral port with synthetic HOME/DB, stopped background jobs and
stubbed GitHub. It cleans up the SDK transport and daemon before returning.

The real SDK client lists eight tools, calls all 28 resident routes and compares
replies against invoke. It fetches full schemas through operations.describe,
checks malformed inputs and invalid actions (including supplied actions on single-action tools), and proves a real ask mutation is
readable through the canonical operation. A non-Neo SDK client still lists one
tool. The evidence records actual tool definitions, door and list UTF-8 sizes.
Retain observed.json, proof.log and run-status.json. Browser layout and model
turns are outside this transport journey.

The Neo door is rendered against a registry that refuses enumeration, proving
that static resident guidance does not scan the catalog.
