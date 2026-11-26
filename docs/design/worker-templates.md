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

**Where it lives.** Worker templates already exist: every preset in `agents/seed-agents.ts`
(`getPresetAgentTemplates`, tools in `PRESET_AGENT_TOOLS`) becomes a built-in template
`worker.<handle>` through `workerPresetTemplates` in `agents/long-horizon-templates.ts`, and
`getBuiltInSpaceAgentTemplates` serves it. The desktop operator is one more preset there,
handle `desktop`, key `worker.desktop`. Its handle is added to the reserved handles
(`RESERVED_SPACE_AGENT_HANDLES`, `agents/slug.ts`), so `SpaceAgentTemplateManager.listIn` does not offer it in
Spaces, where desktop control does not exist.

**How a todo worker reads it.** `resolveEffectiveSpaceAgentTemplate(key, '', repo)`
(`agents/template-manager.ts`): a row of `space_agent_templates` with `space_id = ''` (the
column's default) wins, else the built-in. The core preset list owns it. Editing goes through
`SpaceAgentTemplateRepository` in scope `''`; the existing RPCs need a Space and do not reach
it, so in this step only a code change or a migration edits it. No new table, column or
registry.

**Who picks it.** Core, not Neo: a todo with desktop apps on the HyperNeo adapter starts with
`worker.desktop`. The Claude Code and Codex adapters start as today.

**What it changes in the session.** `createDriverSession`
(`rpc-handlers/family-operations/drivers.ts`) maps the template as space agents do
(`session-resolution/agent-session-config.ts`): `instructions` are appended to the system
prompt, and `model` and `thinkingLevel` apply when the todo names none. The template's tools
drive `allowedTools` and `disallowedTools` through `deriveWorkerDisallowedTools`
(`agents/tool-policy.ts`). Unlike a space agent, the worker gets a restricted SDK built-in
preset, so Bash and the other unlisted built-ins are not exposed. MCP tools stay subject to
operation admission. The fetch and Exa servers are not attached. The session records the
template key in its metadata.

**The brief.** Only the text the template replaces is left out, and only for a session started
with that template: the computer-use `workerContext` from `neo/todo-runner.ts`. The other
packs' text (delegation preferences, the coding rules and merge policy when the todo is coding
work), the instruction, the done-when line and the core reply and blocker rules stay. Every
other worker, on any adapter, gets the brief as today.

**Reuse.** A session started with a template is reused only for a todo with the same template,
and a todo with a template never reuses a session without it, so no worker loses rules it was
not started with.

**`worker.desktop`.**

- Tools: `Read` and the desktop tools. No Bash, Write, Task, Cron, Skill or plan tools. An
  edited copy may list `Bash`.
- `Read` gets the secret read rules (`neo/secret-read-rules.ts`, `neoSecretReadRules`), which
  today only Neo's own sessions get (`agent/query-options-builder.ts`, `getDisallowedTools`);
  a templated session gets them too.
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

**What it can see.** A prompt cannot keep a secret out of a screenshot, so two checks run in
code before a result reaches the model:

- The app list. `desktop.call` already refuses any action or capture outside the apps the
  human approved for the todo (`desktop/opt-in.ts`).
- The screen content. In `desktop/call-operation.ts`, the accessibility text of each result is
  matched against known secret shapes (private key headers, and token prefixes such as
  `sk-`, `ghp_`, `github_pat_`, `xox`, `AKIA`). A match replaces that text with a marker and
  drops the result's screenshot, with one line saying why. Secure text fields are already
  masked by macOS.

A secret drawn only as pixels, with no accessibility text, is not caught. That is the limit
of this step, and the human's app approval covers it.

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

1. **Template for a todo worker.** The `desktop` preset with `Read` and `invoke` only (desktop
   still through `invoke desktop.call`, as today), its reserved handle, resolution in scope
   `''`, the session config, the secret read rules, the brief and reuse rules. Works alone: a
   desktop worker starts with two tools and the short prompt. Tests: a desktop todo on HyperNeo
   starts with the template's tools and prompt; a row in scope `''` overrides the built-in;
   Spaces do not list it; a desktop todo that is also coding work keeps the coding rules and
   merge policy; a coding todo and a Codex worker keep today's brief; a templated session is
   not reused for another todo and the reverse; `Read` of a protected file is refused.
   Estimate: 7 files, 150 lines, 200 test lines.
2. **Top-level desktop tools and timing.** The template adds the catalog tools. Tests: the
   template session lists them and no Bash; a call reaches `desktop.call` with the same
   refusals, including an app that was not approved; results carry `at` and `ms`; a result
   whose accessibility text holds a token shape comes back with a marker and no screenshot.
   Estimate: 4 files, 120 lines, 150 test lines.
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
a capture of an app that was not approved is refused; a password typed in a Safari page
appears masked in both the screenshot and the accessibility tree; a Safari page showing a
fake `ghp_` token returns the marker and no screenshot; `Read` of a file under `~/.ssh` is
refused.
