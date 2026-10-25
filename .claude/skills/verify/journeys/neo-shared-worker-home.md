### One shared non-coding worker home

Use the shared in-process RPC proof setup in SKILL.md with
`PROOF=.claude/skills/verify/project-start-home.ts`. No model mock, provider,
GitHub calls or GUI are involved. The helper starts a real isolated daemon,
stops its job consumer, and invokes the production Neo MCP operations through
the todo runner, work.start and HyperNeo adapter. Only session creation is
synthetic: the helper records its selected workspace in the isolated session DB.
No model turn is claimed.

The helper initializes a synthetic Git parent before starting workers. Both
workers must request direct placement: a Git parent must not move a shared-home
worker into a new worktree. The observed worker folders for two unrelated non-coding projects must both be
`<workspace>/home`. Neither project's home_path is assigned. An invented HOME
folder and a different folder inside the workspace are refused without creating
them. A folder named in immutable human intake is allowed and created. The
coordinator cwd and home-save/export root are unchanged; worker relative saves
use the selected worker cwd. Routing neo.home.save itself is outside this change.

Repeat in a second fresh isolated run, adding `without-workspace` after the run
directory argument. Both workers must then use `<data>/Neo/projects/home`.
The helpers close their daemon in finally and write RPC replies, chosen worker
folders and the five Boolean checks to `evidence/project-start-home.json`.
Keep that evidence. A missing or false check is not a pass. Focused registered
operation tests also cover coding repo placement, existing-folder overrides,
foreign/similar paths, paginated human intake, and rejected adapter admission.
