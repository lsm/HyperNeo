## Operation validation errors include one correct example

Use the shared metadata-only proof wrapper in SKILL.md, with
PROOF=.claude/skills/verify/operation-input-examples.ts. The helper owns a fresh
synthetic daemon on an ephemeral port, without a provider or model turn.

The real daemon MCP invoke handler must reject all fixtures with invalid_input.
Each message retains the original error and appends exactly one JSON input
which passes that operation's actual schema. In particular, a todo instruction
without its target stays invalid and includes a correct todo.add example.
observed.json saves every fixture and tool result. The shared wrapper retains
evidence and deletes the temporary daemon database and HOME.

Fixtures labeled reconstructed came from operation_refusals operation names and
invalid_input reasons, the current schemas and Neo's reported error classes.
That table does not store original inputs. Historical shapes have all real
identifiers and contents replaced with synthetic values.

The separate operation-input-catalog-audit.ts helper checks every advertised
schema and every operation whose required fields can be refused through MCP.
Its socket listeners are replaced to isolate a schema contract check; it is
also run by input-examples.test.ts. It is supplementary and must never be
reported as successful real-daemon proof. A failed daemon bind leaves the main
journey unverified even when the catalog audit passes.
