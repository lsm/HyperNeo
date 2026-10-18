# Neo simplify: final shape, status and PR plan

Status: proposal for review. Docs only, no code until the human approves it.

This replaces the scratchpad plan `neo-simplify-design.md` (its re-cut of 2026-10-17, R1–R33) and the standalone PR-ledger draft. Code references are on `dev` at `7e27912834`. Unprefixed paths are under `packages/daemon/src/lib/neo/`.

## 1. Decisions

- **One kind of Neo session.** There is one default session, plus one session per project. Root Neo goes away, and nobody is special.
- **A todo with a PR is done when the PR merges.** GitHub is the source of truth. A coding todo with linked PRs is done only when the PR ledger reads `merged`. Neo cannot tick it by hand.
- **Every PR has a merge owner.** By default that is the session that opened it. Neo confirms the merge on the ledger itself and never trusts "someone will merge it".
- **One sweep follows up by state and deadline.** It re-tells the owner, and after two ignored nudges Neo acts itself. Earlier plans promised no timers at all. The human approved this one exception: the PR ledger and idle todo sessions. Every other notification still fires only on a state change.
- **PR knowledge lives only in the coding pack.** R30a–c and the ledger are now one item. Core and drivers report generic facts; only the pack decides what is a PR, who owns it, and when it merged.
- **These earlier decisions still hold:**
  - What the human named is a recorded fact.
  - A failure retries only its original target.
  - Failures and refusals are reported as facts.
  - Questions take one form: no on the left, yes on the right, start on yes.
  - The packs get a one-line brief in the prompt and are read in full with `neo.pack.read`.
  - Native tools are Read, Bash, WebSearch and WebFetch, and the guard only blocks reading credentials.
  - Migrations are reversible.

## 2. Why the ledger: the nag data

On 2026-10-18, between about 02:00Z and 14:00Z, 38 PRs in four repos merged only after the human coordinator nudged them, with 49 nags in all.

| Repo | PRs | With no linked todo |
|---|---|---|
| lsm/hyperneo-review | 18 | 15 |
| lsm/open-agent-protocol | 10 | 8 |
| lsm/HyperNeo | 6 | 1 |
| lsm/dolmen | 4 | 1 |
| Total | 38 | 25 |

- Neo's own relay reached 4 of them.
- The 13 PRs that had a todo had all been ticked done or removed before the nag.

Grouped roughly by what each nag said (a PR can be in more than one group):

| What the nag said | PRs |
|---|---|
| Approved and mergeable, but not merged | 18 |
| Approved but `DIRTY` | 6 |
| Changes requested or `COMMENTED` with no push | 5 |
| A check pending an hour or more | 5 |
| No review on the head | 4 |
| CI failing | 3 |

Source: `nag-cases.md`, `rc-prs.txt`, `rc-relays.txt` and `rc-tracked.json` in the Neo iOS session's scratchpad. A narrower "invisible to Neo" tally gave 22 rather than 25.

### Root causes

1. **Neo only learns about a PR from inside a live todo.**
   - It sees a URL the todo names, URLs in the session's report (`packs/coding/todo-prs.ts:140-153`), and `gh pr create` found in the last 2 MB of the transcript (`drivers/opened-prs.ts:30,47`, `drivers/claude-desktop-adapter.ts:59`).
   - Nothing watches the repos.
2. **Assigning PRs to todos loses PRs.**
   - A todo gets at most one branch PR (`todo-prs.ts:204`).
   - Any named or reported claim hides branch claims (`todo-prs.ts:198`).
   - A PR has to be newer than its todo (`todo-prs.ts:152`).
3. **A todo can be ticked done while its PR is still open.**
   - `neo.todo.edit` with `done: 'reported'` (`todo-operations.ts:176-195`) and `neo.todo.close` (`todo-operations.ts:221-230`) skip `pr_merged`.
   - Once the todo is done, all follow-up stops.
4. **Nothing follows up on a schedule.**
   - The stall and idle reminders loop over `legacy_neo_asks` (`service.ts:2116,2140-2150`; `neo-ask-repository.ts:134`), which no new work writes.
   - The todo runner's hooks are empty (`todo-runner.ts:301-302`).
5. **A relay is sent once per state.**
   - The same signature is never re-sent (`card-attention.ts:20`).
   - `needsOf` (`packs/coding/card-facts.ts:21-38`) has no rule for three states: approved with a pending check, `COMMENTED` with no push, and a head with no review.
   - #7477 now relays each PR event once per session. It still never re-tells.
6. **Nobody owns the merge.**
   - The prompts say "If another actor owns the merge, leave it to them" (`prompts/src/neo/packs/coding/goal-merge.md:5`, `instructions.md:58`).
   - No sweep exists to be that actor.

## 3. The finished Neo

### Sessions and routing

- One default session plus one session per project, all with the same powers and the same prompt.
- The router delivers each message straight to its owning session. A reply goes to the session that wrote the quoted item.
- A new topic creates a project and its session. Anything the router can't place goes to the default session.

### Tools

**Core operations (20), each with a one-line description in `invoke`:**

| Group | Operations |
|---|---|
| Reading | `neo.snapshot`, `neo.conversation.read`, `neo.pack.read`, `neo.github.read`, `work.find`, `work.read` |
| Asks | `neo.ask.open`, `neo.ask.settle`, `neo.ask.forward` |
| Todos | `neo.todo.add`, `neo.todo.edit`, `neo.todo.remove`, `neo.todo.continue`, `neo.todo.retry`, `neo.todo.close` |
| Questions | `neo.question.ask`, `neo.question.answer`, `neo.question.retire` |
| Publishing and state | `neo.publication.publish` (with `publicationId` it revises), `neo.project.save`, `neo.rule.save` |

**Native tools:** Read, Bash, WebSearch and WebFetch.

**Being deleted:**
- `neo.project.consult`, `neo.project.respond`, `neo.project.cancel`
- `neo.projects.dispatch`, `neo.receipt.read`
- `neo.route.correct` (now recorded on forward)
- `neo.inbox.promote`
- `neo.publication.edit` (merged into publish)
- `daemon.session.inspect`
- Write, Edit, NotebookEdit, Grep and Glob

**Humans only:** `neo.open`, `neo.message.send`, track/mute, the conversation readers, project move/section, and reorganize.

### The coding pack's PR ledger

There is one table, `pack_coding_pr_ledger`, with one row for each PR in a project repo (a `repo:` alias) that is open now or closed within the last 7 days.

| Column | Meaning |
|---|---|
| `repo`, `number` | Primary key |
| `head`, `branch`, `title` | As GitHub reports them |
| `state` | `draft`, `waiting_review`, `changes_requested`, `failing`, `dirty`, `approved_pending`, `approved_green`, `merged` or `closed` |
| `state_since` | When `state` or `head` last changed |
| `author_session` | The session whose working copy or dispatched todo is on `branch`. The GitHub author doesn't help, because every session pushes as one account. Transcripts are not read |
| `merge_owner` | Defaults to `author_session`. Neo may reassign it |
| `told_at`, `nudges` | The last tell, and how many tells in a row without progress |
| `read_at` | The last reconcile |

- **Sync.**
  - The pack subscribes to `github/<owner>/<repo>/pull_request/*`. The GitHub extension already delivers these from webhooks or its own polling (`external-events/github/github-event-extension.ts`).
  - Every 5 minutes, and for any repo an event marked stale, one batched GraphQL query reads all of that repo's open PRs: head, branch, reviews, check rollup and mergeability.
  - With 5 repos that is about 60 queries an hour, roughly 1% of the shared 5000/hr budget. If fewer than 500 remain, the next cycle is skipped.
- **Todos.**
  - `neo_todo_pr_refs` (m392) links a todo to ledger rows. A PR the todo's title or instruction names is linked automatically.
  - While a linked row is open, `neo.todo.edit` with `done` and `neo.todo.close` are refused with `pr_open: <url>`. To give up on a PR, Neo removes the todo with a reason.
- **Routing.** `project-route-facts.ts` `prOwners` reads the ledger owner's project, so a `#NNNN` with no todo still routes.

### The sweep

The sweep runs after each reconcile.

- An open row that has been in its state longer than that state's deadline gets the facts and an action told to `merge_owner`. The sweep then sets `told_at` and increments `nudges`.
- A change of `state` or `head` resets `nudges`.
- At 2 nudges, Neo acts:
  - It reassigns the PR to a free session (new `merge_owner`, one todo on the existing branch).
  - If no session is free, it asks the human one specific question.
- A row with no owner starts at that step.
- A todo that is `doing`, whose session has been idle for 20 minutes with no report, goes through the same ladder.

| State | Deadline | Action told to the owner |
|---|---|---|
| `approved_green` | 20 min | Merge now, manual squash |
| `approved_pending` | 60 min | Inspect or re-run the pending check, then merge |
| `dirty` | 20 min | Merge the base in, resolve conflicts, push |
| `failing` | 30 min | Read the failing check and fix it |
| `changes_requested` (also `COMMENTED` with no push) | 30 min | Address the review and push |
| `waiting_review` (also a head with no review) | 30 min | Request review, or re-run the review bot |
| `draft` | none | No action |
| `merged`, `closed` | — | Linked todos are met or flagged; the row is dropped after 7 days |

A todo whose session stopped and is waiting for its check (`awaitingReports`, `todo-runner.ts:489`) joins the same pass:
- The daemon runs the pack check within one sweep cycle.
- If the check can't decide, Neo is told the facts.
- A "waiting for Neo to check" line therefore never outlives one cycle.

### Follow-ups join the existing ask

One piece of work is one ask:
- **`neo.ask.open` refuses overlapping asks.** If the request names a PR, issue or todo that is already linked to an open ask in this project, or the human's message replies to an item of one, the call is refused with `ask_open: <askId> "<title>" already covers <ref>`. Neo adds a todo to that ask with `neo.todo.add`.
- **A PR links to one open todo.** Linking a ledger row that already has an open todo is refused with `pr_linked: <todoId>`. A follow-up change on the same PR is a new todo only once the earlier one is done.
- **A merged PR takes no more work.**
  - `neo.todo.continue` on a todo whose linked PR the ledger reads `merged` or `closed` is refused with `pr_merged: <url> merged at <time>`. Neo adds a new todo that starts from fresh `dev` instead.
  - A push event on a merged PR's branch tells the owner and Neo that the commit reaches nothing.

### Titles in the human's language

Ask and todo titles follow `GlobalSettings.language` (`'en' | 'zh-Hans' | 'system'`; `shared/src/types/settings.ts:136`), not the language the instruction arrived in:
- **The daemon resolves the language and tells Neo.** `'system'` resolves to the language of the human's latest message. The daemon passes the result to Neo as one line in each turn's context.
- **The daemon checks every title.** `neo.ask.open`, `neo.todo.add` and `neo.todo.edit` check the title's script against that language. A mismatch is refused with `title_language: write the title in zh-Hans`.
- **Code and names are exempt.** Code, PR and issue references, and proper names are exempt from the check.
- **Existing titles stay as they are.**

### What reaches Neo each turn

- **Unchanged:** the human's local time, the last 7 conversation items (untrusted), and the project snapshot after a context reset. The snapshot now includes the project's ledger rows.
- **Notifications, all facts:**
  - A todo reported, failed, or is waiting on the human.
  - The human answered.
  - A linked PR merged or closed.
  - An ask's outcome changed.
  - A message was forwarded.
  - The sweep escalated (two ignored tells, or no owner).
- **Removed:**
  - Card stall and stuck reminders, and ask idle and stall reminders over legacy asks.
  - Environment-move and rerouted notices.
  - Consultation traffic.
  - One-shot card-attention relays.

### System prompt

There is one prompt for every session, about 6 KB in 12 sections, taken from the scratchpad draft §0.3 with two changes:
- The operation names change from cards to todos.
- The "Failures" and "Notifications" sections say that a PR todo ends only when the ledger says merged, and that the owner session merges.

`goal-merge.md:5` and `instructions.md:58` change "leave it to them" to "your session is the merge owner unless Neo reassigns it".

## 4. Status against dev

**Done since the re-cut:**
- #7425: exact-title session match.
- #7426: project lookup.
- #7428: stable reply address.
- #7433: auth errors not retried.
- #7436: removed todos in Details. This covers #7397; that issue is still open and should be closed.
- #7448: retire or replace a question.
- #7487 and #7489: reply snapshot.
- Done before the re-cut: #7381, #7385, #7387, #7390, #7391, #7400, #7402, #7405, #7406, #7414 and #7415.

**Superseded by the ledger:**
- #7437 and #7456: per-todo claim rules.
- #7445: one-shot approved/green relay.
- #7477: per-event relay.

Each patched one symptom of gaps 2 and 5. Their code goes in L4.

**Still open (code present at `7e27912834`):**
- R1–R3, i.e. issues #7420 and #7424.
- R4–R9: `work-reroute.ts` 134 lines, `work-blocker.ts`, `ask-idle.ts`, `ask-stall.ts`.
- R10–R17: `cross-project-operation.ts`, `consultation-*.ts`.
- R18–R21: `inbox-promote-operation.ts`, `binding-roles.ts`.
- R22–R24: `look-up-guard.ts` is still 1,094 lines.
- R25–R29.
- R31–R33 in neo-ios.
- #7422 and #7423.

**Obsolete:** the re-cut's list stands (#1, #3, #5, #14, #19, #21, #23, #30, #34, #40, #42, #49 and the propose half of #53).

## 5. Deletions

| What | Where | Replaced by |
|---|---|---|
| Transcript-tail PR probe | `drivers/opened-prs.ts`; the `openedPrs` fields in the Claude, Codex and CLI adapters; `packs/coding/branch-prs.ts` `neoCardPrUrls` | Ledger reconcile |
| Per-todo claim rules | `todo-prs.ts` `planCodingTodoClaims`, `codingTodoOwnPrs`, `CLAIM_RANK`, the window; table `pack_coding_pr_claims` | Ledger rows plus `neo_todo_pr_refs` |
| Legacy ask reminders | `service.ts:2140-2150`, `ask-idle.ts`, `ask-stall.ts`, the stall/stuck code in `driver-work.ts` (R5, R6) | The sweep |
| One-shot relay signature | `card-attention.ts`; `needsOf` / `neoCardPrAttention` in `card-facts.ts` | Ledger state plus `told_at` / `nudges` |
| Old route-fact PR tables | `neo_route_pr_refs` reads in `project-route-facts.ts` | Ledger owner |
| Root Neo, consultations, reroute, guard branches | As in R4–R24 | Unchanged from the re-cut |

## 6. PR plan

Each PR is about 100–200 lines of production code, opened from fresh `dev`, and deploys and verifies on its own. The order is set by how many nags each PR removes.

| # | PR | Prod lines | Verify after deploy |
|---|---|---|---|
| L1 | Ledger table, state function and reconcile (repo topics plus batched GraphQL), feeding the snapshot's PR view | +180 | `neo.snapshot` lists every open PR in hyperneo-review, OAP, dolmen and HyperNeo, including PRs no todo opened |
| L2 | Sweep: deadlines, re-tell the owner, act at 2 nudges; branch→session owner | +170 | An `approved_green` PR with an idle owner is told at 20 min and 40 min, then reassigned or asked about |
| L3 | Todo gate: link named PRs; refuse `done` or `close` while a linked PR is open; reopen done todos with open PRs (once, logged) | +120 | `neo.todo.close` on a todo with an open PR returns `pr_open`; merging the PR marks it met |
| L4 | Delete the transcript probe, claim rules, `pack_coding_pr_claims`, the card-attention relay and the old route-PR reads | −400, split by caller | No `openedPrs` in `work.status`; todos still show their PRs, now from the ledger |
| L5 | Idle and awaiting-check todo sessions on the sweep; delete the legacy ask stall/idle loops (R5, R6) | +60 / −250, split | A doing todo whose session is idle 20 min is told, then escalated; an awaiting-check todo is checked within one cycle |
| L6 | Prompts: merge owner, ledger-only done; `goal-merge.md` and `instructions.md` | text | A new coding todo's instruction names its session as the merge owner |
| L7 | Follow-ups join the existing ask: the `ask_open` refusal on `neo.ask.open`; the one-open-todo-per-PR link (`pr_linked`); the `pr_merged` refusal on `neo.todo.continue`; the push-to-merged-branch notice | +130 | Asking for a change to work an open ask already covers adds a todo there; `neo.ask.open` naming that PR is refused; continuing a todo whose PR merged is refused, and a push to that branch is reported |
| L8 | Titles in the human's language: resolve `GlobalSettings.language`, add it to the turn context, check the script in `ask.open`, `todo.add` and `todo.edit` | +90 | With language `zh-Hans`, an English instruction still produces Chinese ask and todo titles; an English title is refused with `title_language` |
| R1–R3 | Snapshot is the same for every caller; project links (#7420); don't echo Neo's own changes (#7424) | as in the re-cut | as in the re-cut |
| R4, R7–R9 | Close in-flight legacy cards; delete reroute, environment-move, old approvals | as in the re-cut | as in the re-cut |
| R10–R17 | Retire, then delete, consultations and dispatch | as in the re-cut | as in the re-cut |
| R18–R21 | Web flat session list; router creates projects; delete `inbox.promote`; migrate root Neo out | as in the re-cut | as in the re-cut |
| R22–R29 | Guard down to credentials; publish absorbs edit; pack brief; `work.read`; single-role prompt; `operations.list` scoped | as in the re-cut | as in the re-cut |
| R31–R33 | neo-ios session list, voice to default, push opens the owning session | as in the re-cut | as in the re-cut |

**Order and conflicts:**
- L1 → L2 → L3 → L4 in sequence. L5 needs L2, L6 needs L3, and L7 needs L3.
- L8 is independent and can run alongside.
- R1–R3 and the guard lane (R22–R24) don't touch the ledger files and can run alongside.
- R5 and R6 are absorbed into L5.
- `service.ts` stays a one-holder file, as in the re-cut.

## 7. Open questions for the human

1. **Repos.** Should the ledger cover every project repo alias, or an allowlist? hyperneo-review, OAP and dolmen produced 32 of the 38 nags.
2. **Deadlines.** Accept the deadlines in the table? Each one trades nag noise against merge delay.
3. **When Neo acts.** After two ignored tells, should Neo reassign first and ask you only when no session is free, or always ask you?
4. **Neo merging.** May a Neo session run `gh pr merge` itself on an `approved_green` PR whose owner is gone, or must a coding session always do it?
5. **Unowned PRs.** PRs no session owns, including ones a human opened, should be tracked, assigned, or ignored?
6. **Closed without merging.** When a linked PR is closed unmerged, should the todo fail, or should Neo ask?
7. **The timer exception.** Is the sweep the only timer-driven notice, with every other notice still state-only?
8. **Overlapping asks.** Should an overlapping `neo.ask.open` be refused outright (L7), or accepted and folded into the existing ask automatically?
9. **Title language.** Should `'system'` resolve to the language of the human's latest message, or to the device locale the client reports?

## 8. Acceptance

These are the cases seen on two live Neo cards on 2026-10-18. After the plan ships, each line can be ticked by reading `neo.snapshot` and GitHub.

| # | Seen | Accepted when | Fixed by |
|---|---|---|---|
| 1 | The "Web details header row (fullstack 1)" todo is ticked done while lsm/HyperNeo#7492 is still `OPEN` | The web todo is ticked only when the ledger reads #7492 `merged`. Until then, `neo.todo.edit` with `done` and `neo.todo.close` return `pr_open` | Ledger-only done (L3) |
| 2 | "iOS: details copy button (iOS-2)" says "approved, waiting to merge", but lsm/neo-ios#130 merged at 15:02Z | A todo's PR status line always shows the PR's current ledger state, no older than one reconcile (5 min, sooner after an event). Within a cycle of #130 merging it reads merged, and the todo is met | Ledger reconcile and snapshot view (L1, L3) |
| 3 | One piece of work became two asks. The header-row follow-up opened a new ask, and #7492 sits on a todo in each | The two cards are one ask. The follow-up is a todo on the original ask, and #7492 is linked to exactly one open todo | Follow-ups join the existing ask (L7) |
| 4 | A todo shows "session stopped, waiting for Neo to check", and nothing checks it | A stopped session is noticed within one sweep cycle: the daemon runs the check, or Neo is told the facts. The line never sits longer than one cycle | Sweep for idle and awaiting-check sessions (L5) |
| 5 | Card and todo titles mix Chinese and English, following whichever language the instruction came in | Every new ask and todo title is in `GlobalSettings.language`; a title in another script is refused with `title_language` | Titles in the human's language (L8) |
| 6 | Neo and the working session treated lsm/HyperNeo#7492 as still open after it merged at 15:22:20Z (head `d8066d8`, merge commit `040c67df67`). A follow-up change (code-block copy button always visible) was pushed at 15:40Z to the merged branch as `37ac5142`, where it reached nothing: dev still hid the button until hover. A corrective PR re-lands it from fresh dev | Within one reconcile of the merge, the ledger reads #7492 `merged` and its todo is met. `neo.todo.continue` on that todo is refused with `pr_merged`, so the follow-up becomes a new todo from fresh `dev`. A push to the merged branch is reported to the owner and Neo instead of passing silently | Live ledger state (L1), ledger-only done (L3), merged-PR refusal and push notice (L7) |
