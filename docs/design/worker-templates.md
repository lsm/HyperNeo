# Worker templates, desktop operator first

Status: proposal, 2026-11-25. Design only. Paths without a prefix are under
`packages/daemon/src/lib/`.

## Why

A desktop todo gets the same worker as a coding todo. A recent desktop test on a local model
(a HyperNeo worker on a custom endpoint, three small tasks in Calculator, TextEdit and Safari)
loaded 34 tools, so its first request was 13,655 tokens before the task. Its brief was 7,025
characters, of which the task was 790; the rest was delegation, reply and blocker rules, the
desktop text and a repository merge policy. The worker made 88 desktop calls and 50 Bash calls,
34 of them `date` to time its steps, 9 `sleep` and one `pkill`. 99% of its tool-result
characters were desktop observations, mostly screenshots, and its context peaked at
149,213 tokens. Of 64 compactions recorded on custom endpoints, 42 were the SDK's own, each
re-reading the whole context (one read 170,773 tokens, took 234 s and kept 8,899).

Space agents already have templates: `space_agent_templates` with instructions, tools, model
and thinking level (`agents/template-manager.ts`, built-ins in `agents/seed-agents.ts` and
`agents/long-horizon-templates.ts`). Todo workers use none of it.

## 1. A template for a todo worker

**Where it lives.** A worker template is a row of `space_agent_templates` with `space_id = ''`,
or a built-in of the same shape. No new table or column. A pack may ship built-ins; the
computer-use pack ships `desktop-operator`. A later edit by the human overrides the built-in
with the existing template operations.

**Who picks it.** A new optional pack hook `workerTemplate(todo)` returns a key or nothing.
Computer-use returns `desktop-operator` when the todo has desktop apps. Core passes the key
with `work.start`; Neo does not choose. Only the HyperNeo adapter applies a template now; the
Claude Code and Codex adapters start as today.

**What it changes in the session.** `createDriverSession`
(`rpc-handlers/family-operations/drivers.ts`) builds the config from the template the same way
`buildAgentSessionConfig` does for space agents: `instructions` are appended to the system
prompt, `tools` become `sdkToolsPreset`, and `model` and `thinkingLevel` apply when the todo
names none. The fetch and Exa servers are not attached. Text that packs add to the brief
(`todo-runner.ts`: `workerRules`, `workerContext`, the repository merge policy) is left out,
because the template carries what the worker needs. The brief keeps the instruction, the
done-when line, the core reply and blocker rules, and the delegation preferences, which are
human data.

**`desktop-operator`.**

- Tools: `Read` and the desktop tools. No Bash, Write, Task, Cron, Skill or plan tools. A
  human-edited copy may list `Bash`.
- Desktop tools are top-level: one tool per entry of `desktop/tool-catalog.json`
  (`list_windows`, `get_window_state`, `launch_app`, `click`, ..., `zoom`), each calling
  `desktop.call {tool, args}`. This is the Neo resident-tool pattern in
  `operations/mcp-server.ts`, given to sessions whose template asks for it. `invoke` stays for
  `message.send`.
- Every desktop result carries `at` and `ms`, so timing a step needs no shell.
- Instructions, short: what it may do (act in the approved apps); what it asks Neo first
  (secrets, deletes, purchases, sending, security and permission prompts); that it never
  reads, types or screenshots a token or password; that a UI failure is reported to Neo with
  the app and the screen, never worked around with a shell. The computer-use worker text
  moves here.

Neo then writes only the goal and the done-when for a desktop todo.

## 2. Old observations on custom endpoints

Each request to a custom endpoint passes one of the three bridges
(`providers/openai-chat-bridge`, `anthropic-messages-bridge`, `ollama-bridge-server.ts`), which
parse the Anthropic request and know the session. One shared function runs there before the
request is converted:

- When the estimated input of a session passes 60% of the model's window, every desktop
  observation except the last 3 is replaced by one line: tool, time, and "call
  get_window_state for the current screen". Observations are the results of desktop tools:
  screenshots and accessibility trees.
- The replaced ids are kept per session, and later requests replace the same ones, so the
  prefix stays the same and the endpoint's cache holds until the next crossing. A restart loses
  the set; the next request trims again, which costs one cold read.
- Nothing is changed in the stored conversation; only the request is.

**Summary size.** The daemon's own compaction (`agent/context-budget-enforcement.ts`,
`drivers/hyperneo-adapter.ts`) sends `/compact` with one line: keep the summary near 2,000
tokens, with the goal, the state reached, open steps and the last observation only. The
message queue accepts `/compact` with text. The SDK's own auto-compaction keeps its prompt;
the trim is what keeps desktop sessions below its threshold.

## Not in this step

No template choice by Neo, no templates for Claude Code or Codex workers, no coding template,
no settings page. Trimming is for desktop observations on custom endpoints only.

## Changes

Four PRs from `dev`, failing tests first. Heavy builds and tests run on CI or the build Mac,
never the laptop. System map read for the planned files.

1. **Template for a todo worker.** The pack hook, the built-in, `work.start` carrying the key,
   the session config, the brief without pack rules. Tests: a desktop todo on HyperNeo starts
   with the template's tools and prompt; a coding todo is unchanged; a todo that names a model
   keeps it; another adapter ignores the key.
   Estimate: 6 files, 140 lines, 160 test lines.
2. **Top-level desktop tools and timing.** Tests: the template session lists the catalog
   tools and no Bash; a call reaches `desktop.call` with the same refusals; results carry
   `at` and `ms`.
   Estimate: 4 files, 90 lines, 120 test lines.
3. **Trim old observations.** Tests: below the threshold nothing changes; past it all but the
   last 3 become a line; the next request keeps the same lines; non-desktop results are kept;
   all three bridges.
   Estimate: 5 files, 110 lines, 160 test lines.
4. **Summary size.** Tests: both enqueue sites send the line; the queue treats it as a
   compaction.
   Estimate: 3 files, 30 lines, 50 test lines.

**Done when** the same three-task desktop test, run on an isolated test daemon with the same
local model: all three tasks pass; the first request is at most half of 13,655 tokens; no
Bash call; context stays below 60% of the window, with no SDK auto-compaction.
