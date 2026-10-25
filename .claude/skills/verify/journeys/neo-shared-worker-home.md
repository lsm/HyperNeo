### One visible non-coding user folder

Use the shared in-process RPC proof setup in SKILL.md with
`PROOF=.claude/skills/verify/project-start-home.ts`. No model mock, provider or
GitHub calls are involved. The helper starts a real isolated daemon, stops its
job consumer, and invokes the production Neo MCP operations through the todo
runner, work.start and HyperNeo adapter. Only session creation is synthetic:
the helper records its workspace and direct/worktree mode in the isolated DB.
The real local-user neo.open operation also aligns the stored coordinator prompt.
The evidence must contain that actual prompt, its folder rules, and root/discussion
word counts below the existing 260/250 limits. No model turn or actual worker
file creation is claimed.

Run on three fresh isolated directories, adding these arguments after the run
path: `without-workspace`, no extra argument, and `env-workspace`. They must
select `<temp HOME>/HyperNeo`, the exact configured workspace path, and that
same path through HYPERNEO_WORKSPACE_PATH, respectively. No `/home` suffix.
The selected folder must be absent before the first start and created on need.
Two unrelated non-coding projects must share it without assigning home_path.

The helper initializes a synthetic Git parent. Shared-folder workers must run
directly in place; a coding repo keeps its normal worktree mode. The original
coordinator cwd stays in the data directory's Neo folder. An invented HOME
folder and another invented workspace folder are refused without creation;
a folder named in immutable human intake is allowed. The actual worker mailbox
input must contain the non-coding file guidance, including keeping useful files
in its cwd and making a subfolder only for one matter with several files.
The helper closes its daemon in finally and writes RPC replies, worker intake,
selected folders and nine Boolean checks to `evidence/project-start-home.json`.
A missing or false check is not a pass.

For attended header verification, build the web package, then add
`without-workspace --show-header` after a fresh run path. The helper prints
`HEADER: <loopback URL> PID=<its own PID>` and keeps only its isolated daemon
and a static/websocket frontend open. Open that URL manually in a browser:
the worker header must visibly show `<temp HOME>/HyperNeo` beside its title,
with the full path on hover. Inspect and retain a screenshot. This exposes no
Neo project labels. Close that temporary tab and send SIGTERM only to the
helper PID it printed; it stops its frontend and cleans up its daemon.
No unattended GUI test or external model/provider is part of this journey.

Neo's own cwd and home-save/export root are unchanged. Worker relative saves
use their chosen cwd; routing neo.home.save itself is outside this change.
Focused tests also cover refusing the home root, existing-folder overrides,
foreign/similar paths, paginated intake, config precedence and rejected adapters.
