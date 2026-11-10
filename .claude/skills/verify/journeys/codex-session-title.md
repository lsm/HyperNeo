# Codex session titles and offline rename

Use the pinned runtime and disposable metadata proof wrapper from SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/codex-session-title.ts
```

The helper boots an isolated daemon on an ephemeral port, with synthetic Codex
state and scripted server boundaries. A parsed todo start target carries
sessionTitle through driverWorkCall and the real work.start operation. The
created thread and returned title use that session title independently of the
todo title. Omitting sessionTitle selects the next free generic project name
among live project threads, never the task title. work.rename succeeds while the Desktop control connection throws,
using the owned bootstrap server. Every opened server is closed.

Retain codex-session-title.json, proof.log and run-status.json. No model, native
Desktop, live daemon or real Codex state is used. Browser rendering and actual
installed app-server compatibility remain unverified.

Two overlapping real work.start operations hold the first synthetic name write
until the second has started. The persisted synthetic thread state and receipts
must show distinct next-free project names. No native Codex process runs.

Shared Codex state across processes also uses the production PID-file lock,
scoped to canonical state path and project. Run the independent-process proof:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/process-evidence .claude/skills/verify/codex-session-name-processes.ts
```

Two independent Bun processes share synthetic state, hold the first selected
name before persistence, and must persist names 1 and 2. This tests the actual
cross-process lock; the daemon proof separately exercises the operation path.
Explicit titles enter the same lock and are refused before thread creation if
a live project thread already uses that title. Unit coverage races explicit
and automatic titles. Lock contention times out after 30 seconds; existing PID
lock recovery handles dead owners. No real Codex state or native process is used.

Naming reads full stored names independently of the 80-character display title.
The daemon proof seeds a 73-character project basename and verifies the next
number plus explicit duplicate refusal. It also seeds a user-linked worktree
whose recorded Git root is the main project, and verifies that its occupied
number is counted. The Git mapping and Codex servers are synthetic boundaries;
actual state-file reads and the daemon operation path run in the proof.

The naming inventory filters title candidates before resolving Git checkouts.
An unrelated project title must cause no checkout lookup in the real operation
proof. Focused tests count one lookup per distinct candidate folder, or zero
when no stored title matches an explicitly supplied name.

A live same-prefix thread whose checkout no longer resolves still occupies its
name. The daemon proof seeds a missing-folder thread, checks the next number,
and refuses its explicit duplicate. A resolved different Git project is excluded.

The uniqueness guarantee covers starts sharing the state file and project.
Manual work.rename accepts the requested title, including a title another live
thread already uses. It can also race with start-time name selection. The daemon
proof renames into an occupied title and verifies that both live rows retain it.
