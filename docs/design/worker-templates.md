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

**Where it lives.** A worker template has the shape of a space agent template
(`SpaceAgentTemplate`: instructions, tools, model, thinking level) and is a built-in in code,
owned by a pack; the computer-use pack ships `desktop-operator`. The existing template
operations need a Space, and todo workers have none, so a worker template is not stored in
`space_agent_templates` and the human does not edit it in this step. No new table or column.

**Who picks it.** A new optional pack hook `workerTemplate(todo)` returns a key or nothing.
Computer-use returns `desktop-operator` when the todo has desktop apps. Core passes the key
with `work.start`; Neo does not choose. Only the HyperNeo adapter applies a template now; the
Claude Code and Codex adapters start as today.

**What it changes in the session.** `createDriverSession`
(`rpc-handlers/family-operations/drivers.ts`) builds the config from the template the same way
`buildAgentSessionConfig` does for space agents: `instructions` are appended to the system
prompt, `tools` become `sdkToolsPreset`, and `model` and `thinkingLevel` apply when the todo
names none. The fetch and Exa servers are not attached. The session records the template key
in its metadata.

**The brief.** Only the text the template replaces is left out, and only for a session started
with that template: the computer-use `workerContext` and the coding merge policy. The other
packs' `workerContext` (delegation preferences among them), the instruction, the done-when line
and the core reply and blocker rules stay. Every other worker, on any adapter, gets the brief
as today.

**Reuse.** A session started with a template is reused only for a todo with the same template,
and a todo with a template never reuses a session without it, so no worker loses rules it was
not started with.

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
  (secrets, deletes, purchases, sending, security and permission prompts); that a UI failure is
  reported to Neo with the app and the screen, never worked around with a shell. The
  computer-use worker text moves here.

**What it can see.** A prompt cannot keep a secret out of a screenshot, so the boundary is the
app list. `desktop.call` already refuses any action or capture outside the apps the human
approved for the ask (`app_action_not_authorized`, `desktop/opt-in.ts`). The human does not
approve a password manager, a terminal or a settings pane that shows keys; secure text fields
are masked by macOS in both screenshots and accessibility values. Nothing new is redacted in
this step; the proof checks both points.

Neo then writes only the goal and the done-when for a desktop todo.

## 2. Old observations on custom endpoints

Each request to a custom endpoint passes a bridge that parses the Anthropic request. Two of
them know the session: `providers/anthropic-messages-bridge` (from the request) and
`openai-chat-bridge` (from its session token). The Ollama bridge does not, so it is left out.
One shared function runs in the two before the request is converted:

- The model's window is set per session at the call that already sets its thinking
  (`setSessionThinkingConfig`, from `agent/query-runner.ts`). A session with no window set is
  not trimmed. Its state is dropped when the session's query stops.
- When the estimated input of a session passes 60% of the model's window, every desktop
  observation except the last 3 is replaced by one line: tool, time, and "call
  get_window_state for the current screen". Observations are the results of desktop tools:
  screenshots and accessibility trees.
- The replaced ids are kept per session, and later requests replace the same ones, so the
  prefix stays the same and the endpoint's cache holds until the next crossing. A restart loses
  the set; the next request trims again, which costs one cold read.
- Nothing is changed in the stored conversation; only the request is.

**Summary size.** The daemon's own compaction (`agent/context-budget-enforcement.ts`,
`drivers/hyperneo-adapter.ts`) sends `/compact` followed by one line: keep the summary near
2,000 tokens, with the goal, the state reached, open steps and the last observation only.
Today `MessageQueue.isInternalCompaction` and the check in `agent/query-runner.ts` match
`/compact` exactly, which drives deduplication and the wait for the compact boundary. Both
change to match the command word, as the queue's own `isUserCompactCommand` already does, so one
queued compaction of either form still counts once and still waits for its boundary. The
SDK's own auto-compaction keeps its prompt; the trim is what keeps desktop sessions below its
threshold.

## Not in this step

No template choice by Neo, no templates for Claude Code or Codex workers, no coding template,
no editing of worker templates, no settings page. Trimming is for desktop observations on the
two bridges that know the session. No redaction inside an approved app.

## Changes

Four PRs from `dev`, failing tests first. Heavy builds and tests run on CI or the build Mac,
never the laptop. System map read for the planned files.

1. **Template for a todo worker.** The pack hook, the built-in with `Read` and `invoke` only
   (desktop still through `invoke desktop.call`, as today), `work.start` carrying the key, the
   session config, the brief and reuse rules. Works alone: a desktop worker starts with two
   tools and the short prompt. Tests: a desktop todo on HyperNeo starts with the template's
   tools and prompt; a coding todo and a Codex worker keep today's brief; a templated session
   is not reused for another todo and the reverse; a todo that names a model keeps it.
   Estimate: 6 files, 150 lines, 180 test lines.
2. **Top-level desktop tools and timing.** The template adds the catalog tools. Tests: the
   template session lists them and no Bash; a call reaches `desktop.call` with the same
   refusals, including an app that was not approved; results carry `at` and `ms`.
   Estimate: 4 files, 90 lines, 120 test lines.
3. **Trim old observations.** Tests: below the threshold nothing changes; past it all but the
   last 3 become a line; the next request keeps the same lines; non-desktop results are kept;
   two sessions on one bridge keep their own sets; no window set means no trim; both bridges.
   Estimate: 5 files, 120 lines, 180 test lines.
4. **Summary size.** Tests: both enqueue sites send the line; a queued `/compact` with text
   dedupes with a plain one and waits for the boundary.
   Estimate: 4 files, 40 lines, 70 test lines.

**Done when** the same three-task desktop test, run on an isolated test daemon with the same
local model: all three tasks pass; the first request is at most half of 13,655 tokens; no
Bash call; context stays below 60% of the window, with no SDK auto-compaction; a daemon
compaction on the same daemon writes a real compact boundary with a summary near 2,000 tokens;
a capture of an app that was not approved is refused, and a password typed in a Safari page
appears masked in both the screenshot and the accessibility tree.
