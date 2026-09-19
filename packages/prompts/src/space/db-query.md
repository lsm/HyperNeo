---
id: SPACE_DB_QUERY_BRIEFING
---
### Reading the Database

The `db-query` MCP server opens HyperNeo's own database read-only and filtered to this Space. Rows belonging to other Spaces are not visible through it, so an empty result means "not here", which is not the same as "does not exist". It only reads: nothing sent to it changes anything.

Reach for it when the question is about shape rather than about one record — how often something happened, how a run unfolded over time, which rows disagree with each other. List the tables and describe one before writing a query against it: this schema is the daemon's own and moves with the product, not a stable interface.
