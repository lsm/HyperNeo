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
`getBuiltInSpaceAgentTemplates` serves it. The desktop operator is one more built-in of the
same kind, handle `desktop`, key `worker.desktop`. It is added beside `workerPresetTemplates()`
in `getLongHorizonAgentTemplates`, not to `getPresetAgentTemplates`: migrations 170 and 172
call that list live and would seed it into Spaces. Its handle is added to the reserved handles
(`RESERVED_SPACE_AGENT_HANDLES`, `agents/slug.ts`), so `SpaceAgentTemplateManager.listIn` does not offer it in
Spaces, where desktop control does not exist.

**How a todo worker reads it.** From `getBuiltInSpaceAgentTemplates()`
(`agents/template-manager.ts`) by key, the built-in only. No row is read or written: a row
with `space_id = ''` is the sentinel that migration 249 moves or deletes, so it is not a
place to keep an override. The core preset list owns the template, and only a code change
edits it in this step. No new table, column or registry.

**Who picks it.** A generic pack hook, `workerTemplate?(todo): string | undefined`, next to
`workerContext` in `neo/pack-contract.ts`. Core only passes the key a pack returns to the
start; it knows nothing about desktops. The computer-use pack returns `worker.desktop` when the
todo has desktop apps. Two packs returning different keys: none is used. Only the HyperNeo
adapter applies a template now; the Claude Code and Codex adapters start as today.

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

- Tools: the desktop tools and `invoke`, nothing else. No file tool: `Read` could open any
  file, and the secret read rules (`neo/secret-read-rules.ts`) are a deny list that misses the
  daemon's own data and other harnesses' auth files, so a desktop worker reads nothing from
  disk. No Bash, Write, Task, Cron, Skill or plan tools.
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

**What it can see.** No code can tell a secret in an image or in a format it does not know,
so a content filter cannot be the boundary. The boundary is the app, and it fails closed:

- `desktop.call` refuses any action or capture outside the apps listed on the todo
  (`desktop/opt-in.ts`); nothing from another app reaches the model.
- Only an app on an approved card counts. The card's app line (`desktopAppsLine`,
  `desktop/app-scope.ts`) changes from the app names alone to the names plus "the worker and
  its model will see everything these apps show, on every page", written by code, so every
  surface shows it. Approving the card is the consent, per ask. Two paths that skip it today
  close: a todo can no longer claim an app only because the human's message names it
  (`neoTodoDesktopScope`, `neo/todo-add-operation.ts`; Neo's step for it in
  `computer-use/instructions.md` goes too), so it must be on the ask's approved card
  (`neo_asks.desktop_apps`); and an existing Mac grant or Allow all no longer stands in
  for it, because `readDesktopTodos` (`desktop/opt-in.ts`) treats a todo as allowed only when
  each of its apps is on its ask's card with the disclosure. The propose path that writes the
  line also writes `"seen": "all"` into each app entry of `neo_asks.desktop_apps`; the line and
  the mark come from the same code, so a card has both or neither. A card created before
  this change, approved or pending, has no mark and does not count: its todos are refused
  with `desktop_consent_outdated`, and Neo proposes a fresh card. No migration. An app the human should not show in full is not
  approved, and the step goes to the human instead.

On top of that, and only as a second line, the accessibility text of each result is matched
against known secret shapes (private key headers; token prefixes such as `sk-`, `ghp_`,
`github_pat_`, `xox`, `AKIA`); a match replaces the text with a marker and drops the
screenshot. Secure text fields are masked by macOS. Both are in the first slice, before any
templated desktop worker starts.

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

1. **Template for a todo worker.** The `desktop` built-in with `invoke` only (desktop
   still through `invoke desktop.call`, as today), its reserved handle, the `workerTemplate`
   hook and computer-use's answer, the session config, the approval
   wording, the secret-shape check, the brief and reuse rules. Works alone: a desktop worker
   starts with one tool and the short prompt. Tests: a desktop todo on HyperNeo starts with
   the template's tools and prompt; with computer-use off no template is used; Spaces do not
   list it; migrations 170 and 172 do not seed it; a desktop todo that is also coding work keeps the coding rules and merge policy; a
   coding todo and a Codex worker keep today's brief; a templated session is not reused for
   another todo and the reverse; the session has no file tool; a result whose
   accessibility text holds a token shape comes back with a marker and no screenshot; a todo
   claiming an app only by the human's message is refused; a capture for an app the Mac
   allows but the ask's card does not list is refused; the card shows the visibility line; a
   todo under an approved card without the mark, and one under a pending card created before
   the change, are refused until a fresh card is approved.
   Estimate: 10 files, 190 lines, 270 test lines.
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
a capture of an app that was not approved is refused; a password typed in a Safari page
appears masked in both the screenshot and the accessibility tree; a Safari page showing a
fake `ghp_` token returns the marker and no screenshot; asked to read the daemon's database
or another harness's auth file, the worker has no tool that can. A token in an unknown format, or one shown only as an image, in an approved app does
reach the model: the proof shows it, which is what the approval wording says.
