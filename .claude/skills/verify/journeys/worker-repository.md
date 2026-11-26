# Coding todos stay in their worker repository

Use the shared metadata-only proof wrapper with Bun 1.4.4:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/worker-repository.ts
```

The helper starts an isolated NODE_ENV=test daemon with a fresh HOME and database,
no provider and no model turn. Synthetic workers have real local Git repositories
with matching SSH, different HTTPS, or absent remotes. Production work.status
resolves their places; todo resolution reads local remotes with the shared cached
workspace identity reader. The MCP operations accept matching and non-coding sends
and refuse other or unknown repositories on add, edit, bind and continue. An
open prerequisite keeps instruction todos from auto-starting during the proof.
Dispatch sentries require zero work.send/work.start calls, and the delivery input
count stays zero. Refused adds and bind targets create no todo; refused edits create no
worker target. Evidence includes operation replies and the dispatch counts.
The helper stops its daemon; the wrapper retains evidence and removes test data.

Remote status and discovery fixtures model an attached Claude Desktop daemon.
The open discovery list shows the worker and its remotes. Status reports the
worker's folder. The normal Desktop history cap drops the worker from discovery
when closed sessions are included. The MCP todo add uses the matching folder
on the owning daemon to accept matching remotes and refuse different or absent
remotes. External daemon transport and native dispatch are simulated.

Repository assertions use coding-owned policy facts, including a non-coding
check changed to a coding check before worker binding. The helper emits
`gh.log` and a sorted GitHub request multiset in `worker-repository.json`.
Compare those requests before and after worker-reader extraction; outcomes and
request counts must match. The shared repository identity normalizer stays in
core while coding owns workspace Git reads and remote canonicalization.
