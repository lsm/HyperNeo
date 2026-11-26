import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NEO_TOOL_DESCRIPTIONS, neoToolDescription } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { describeOperationDefinition } from '../../../../src/lib/operations/discovery.ts';
import { createNeoService, createNeoOperations } from '../../helpers/neo-service.ts';
import { createTestDb } from '../../../helpers/database.ts';
const moved = [
  {
    file: 'preference-operations.ts',
    name: 'pack.preferences.set',
    text: 'Set a declared pack setting. Only the local human may write; agents cannot change settings.',
  },
  {
    file: 'preference-operations.ts',
    name: 'pack.preferences.get',
    text: 'Read a setting at exact scope, then pack global. Missing is unanswered.',
  },
  {
    file: 'preference-operations.ts',
    name: 'pack.preferences.list',
    text: 'List saved pack settings with scope and human provenance. Missing defaults are never applied.',
  },
  {
    file: 'preference-questions.ts',
    name: 'pack.preferences.ask',
    text: 'Ask the human to apply typed pack settings. The daemon displays and binds this exact immutable proposal as a choice to apply these settings or keep the current ones; no settings change until the human picks apply. The daemon opens the card on its own ask, which holds no other work and settles once a value is applied or the current ones are kept; omit askId, which is ignored. To offer a pick among values, pass alternatives (2–5 value sets) instead of values: each becomes one option before keep, and only the option the human picks is applied. Reuse requestId for pending retries; question_closed means use a new requestId to ask again.',
  },
  {
    file: 'preference-questions.ts',
    name: 'pack.preferences.applyAnswer',
    text: "Retry applying a bound settings question by questionId only. Requires the human's recorded apply answer; accepts no replacement values. Already-applied answers never overwrite later human changes.",
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.ask',
    text: "Ask one necessary question on an open ask you own. In the human's language, give a short Markdown title and the decision, why it needs them and what the choices do. Use a few bullets or a small table and bold the key choice. text is at most 400 characters without internal IDs; put longer supporting material in document. Ask only for what you cannot determine yourself, never for bookkeeping.\n\n- For one worker's output, set sourceSession {adapter,id,daemon?}; omit for mixed or absent sources. It adds an Open session link without changing the answer controls. focused:true needs a readable sourceSession and preserves the ask's link after the card retires. Its discussion relays are status only. artifacts retains up to 16 saved attachments, fixed-head Git references or verified local Markdown/HTML handoff publicReference values.\n- For a question about one todo, pass its todoId. Otherwise supply retireWhen {pack,kind,params}. It defaults to the linked todo's check; supply it explicitly for a missing check or invalid, foreign, done or removed todo. With an explicit check, an unusable todo produces an unlinked card and todo_closed. Choose an installed pack check that proves the question is unnecessary. Fix returned check warnings before waiting. Sweeps retire the card on a pass, record evidence, release holds and notify Neo. Unmet or unreadable facts leave it open. Unsupported or malformed checks are refused. A linked todo's removal or disappearance also retires it; an open linked card blocks manual todo completion.\n- replyTo cites human input without marking it answered. Unknown, foreign, queued and non-human IDs are omitted. Success on a consumed input writes one linked chat notice; do not publish a second. Options remain on the card.\n- choice: 1–6 action options; one option confirms, multiple enables pick-any. Use self-contained action text such as “Merge” or “Close it”; omit todo operations. Use one short details line keyed by exact option text, and the exact recommended option in recommended. The card numbers choices and accepts replies by number; never refer to options by number, letter or nickname in text. Use Reply in chat for free text; omit catch-all and defer options. A home proposal requires one option, no multiple, and confirm:{path,sha256}; show the proposed change, exact path and 64-character lowercase hash in text. This records a proposal only.\n- reply: ask a question answered in chat. relay: relay a worker question you cannot answer in your own words, one line of at most 80 characters, with 2–6 options. Its answer goes to the worker. Use todoId, or session (its notice key) if there is no todo; the daemon follows that session in an ask. Relay requires no other open card.\n\nFor other kinds use replaces to replace an open same-ask card atomically. A closed same-ask replaces ID is ignored. Unknown or other-ask IDs are refused. Without replacement, an open card blocks a new one. A proposal, relayed-session work decision or card the human held cannot be replaced; wait for the human (who can also take back a held card).",
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.retire',
    text: 'Retire an open question on an ask you own when it no longer needs an answer, with the reason in one short sentence. It leaves the open questions and shows in Details as no longer needed. A proposal or relayed-session work decision must be answered by the human and cannot be retired. A card its todo is blocked on, or whose todo has no instruction and no check, is refused until that todo is settled, so the work and the card end together. A card the human holds (heldAt) is refused too: they put it aside on purpose, so do not remind them about it. An already closed question comes back unchanged.',
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.get',
    text: "Read one of Neo's questions to the human by id: its text, state, answer and optional home path/hash binding. Its document field, when present, returns the full text separately from the short card text. answeredByHuman is true only when the human answered it, by button or in their own chat; use it to check a decision another session reports. resolvedByAgent marks a cited Neo resolution, whose durable citation is in retiredReason; it is never human approval.",
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.answer',
    text: "The human's answer to an open question: no or yes, the chosen options, their words, or the todos to start. The answer goes to the ask's Neo session. Through the local session door, an allowed relay sender passes the human's exact words as answer, with where and when they said them.",
  },
  {
    file: 'rule-questions.ts',
    name: 'neo.rule.ask',
    text: 'Default path for standing-rule edits in any Neo turn: ask the human to apply or keep the exact add/remove arrays. Removal uses exact saved text. No rule changes until the human picks apply. The daemon opens the card on its own ask and settles that ask once the edit is applied or the rules are kept; omit askId, which is ignored. Pending retries reuse requestId; question_closed needs a new requestId.',
  },
  {
    file: 'rule-questions.ts',
    name: 'neo.rule.applyAnswer',
    text: "Apply only the immutable rule edit bound to questionId after the human's recorded apply answer, in any turn. Accepts no replacement values. Check this result after that answer: changed current rules can prevent application; a refusal leaves them unchanged. Repeated application never overwrites later changes.",
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.add',
    text: "Add a titled todo. For a human's direct request that the root does not send to neo.ask.propose, pass input: the daemon opens its ask or finds the open one, and the todo starts without a card; pass a topic of up to 12 display cells when this opens a new ask. For follow-up work pass askId of an open ask you own; a settled ask refuses with ask_settled, adds nothing and names the next step. Use the root's human-input routing and add every step with after: [] for parallel work, or the exact prerequisite IDs. Missing after is refused. A chain waits on the previous step. For multi-PR work, use one PR per todo with a merge check, chain the todos with after, and pin each opened PR with neo.todo.edit addUrls.\n\nPass check {pack,kind,params}. The daemon generates doneWhen; do not supply it. Use an installed pack's supported check, such as core.human_confirmed {questionId} or core.evidence {path: absolute path} or {url: link}. Coding uses pr_merged, pr_approved, issue_closed, deployed {repo,sha: full commit}, or core.evidence {url} for a review or comment link. Checks can refuse or return bookkeeping records. Prefer the existing live todo if a PR is already tracked; duplicate claims are recorded without blocking.\n\n- Give every step that needs execution its instruction and target: {verb:start,adapter,place?,model?,effort?} or {verb:send,ref}. For a send that may need a prepared replacement, include this todo's preparationParameters and sandbox so the checkout is not guessed. Omit both instruction and target for a check-only wait; the daemon checks it and gives you the next step if the check is unmet 24 hours after prerequisite completion.\n- For a start that requires a specific model or thinking effort, set target.model or target.effort. The instruction text never selects either. After dispatch, use neo.todo.read to verify the recorded settings before reporting that the requested worker started.\n- Bind work already underway with {verb:bind,ref}, no instruction, and satisfied prerequisites (after: [] if parallel). It records doing without sending. Coding send and bind refuse unknown or mismatched worker remotes.\n- Workers are long-lived sessions. Name them for the project and a number, never for a task. New local workers default to '<engine> <project> <n>'; use target.name only for another name that follows this rule. named records the engine, session, repository or folder the human named. For a named session require an exact work.find {session} ref.\n- A step that must use this computer lists its apps' bundle ids in desktopApps; only that todo gets them. Each app must be on the ask's approved proposal card with the visibility disclosure; otherwise propose the work with desktopApps. Follow the computer-use pack guidance, and leave named.desktopControl out.\n\nA runnable todo starts once its prerequisites pass and a slot is free. Never start todos yourself. There is no start flag or Start card. Set priority from human urgency: urgent, high, normal (default), low. Set producesFollowUp:true for work that yields later steps. On completion, add those steps with after:[its id]; the daemon wakes you and done settlement waits for a successor, which can be unstarted.\nFor Copilot (adapter ID copilot-cli), set target.copilotClient to desktop or cli when the human requires that client. Otherwise use auto or omit it. After dispatch, work.status reports the actual copilotClient alongside the session reference.",
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.edit',
    text: "Edit a todo on an open ask you own. Change title or check {pack,kind,params}; the check generates the completion sentence. To reword only that sentence, set doneWhen without changing the check. Changing the check regenerates the sentence even if doneWhen is supplied. Keep one PR per todo. Use addUrls to pin only this todo's PR to its existing merge check; use after to preserve dependencies. Duplicate claims and unsupported URLs are recorded without blocking; edit the existing PR todo instead of adding a duplicate.\n\nRecord evidence as done met for facts you read or reported for a claim you cannot read. The todo remains blocked until its check passes, then finishes automatically. artifacts retains existing saved attachments and fixed-head Git references. An unanswered card refuses the edit.\n\nChange waiting work's priority, or update after to omit a prerequisite that was removed to let the step proceed. Give both instruction and target to assign a worker to an unstarted check-only todo with no instruction. Use a work.find target.place for coding starts and a matching worker repository for coding sends; unknown remotes refuse. At a check-only todo’s next-step reminder, assign it, hold it or remove it as appropriate. Use neo.todo.hold to hold or release.",
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.hold',
    text: 'Hold a todo that must wait: give the reason, and the daemon stops a running worker without asking the human again. Pass reason null to release it. After releasing a started todo, use neo.todo.continue to resume its worker. To ask the human to start, resume or remove it, pass decision true and make reason the question in their language; the daemon opens a decision card instead. Never hold a todo to wait for another step of the same ask: use after.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.remove',
    text: 'Remove a todo from an open ask you own, with the reason: this is how to cancel or replace one, started or not; neo.todo.done is for finished work. Its session stops if it is running, unless the todo only follows a session the human tracked. An invalid replacedBy is recorded while removal proceeds without a replacement link. replacedBy names the todo that replaces it; todos that waited for the removed one wait for the replacement instead. Without a replacement, say what its unstarted dependents do with dependents: continue (they go on without it) or remove (they and the unstarted steps behind them are removed too). Leave dependents out only when the human has not said which: nothing behind it starts, and deciding whether those steps continue or go is your next step. Dependents that already started keep running. A removed todo stays listed, struck through.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.continue',
    text: "Send a started todo's session its next step. Coding work requires worker remotes matching the todo repository; mismatched or unknown remotes are refused. The todo goes back to doing until the session reports again, and a card it was waiting on closes with it. A pending relayed-session decision must be answered by the human before this todo can continue. An unstarted todo or settled ask returns a record without dispatching or approving a start. A failed todo gets a new attempt in place, keeping its todoId: its worker gets message, or its original instruction without one; with no worker its recorded target starts again. Only a failed todo may omit message.",
  },
];
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let registry: ReturnType<typeof createOperationRegistry>;
beforeAll(async () => {
  db = await createTestDb();
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus()
  );
  registry = createOperationRegistry(createNeoOperations(service));
});
afterAll(async () => {
  await service.dispose();
  db.close();
});
test.each(moved)('$name is loaded verbatim from the prompts package', ({ file, name, text }) => {
  expect(NEO_TOOL_DESCRIPTIONS[name]).toBe(text);
  expect(neoToolDescription(name)).toBe(text);
  expect(registry.get(name)?.description).toBe(text);
  const source = readFileSync(new URL(`../../../../src/lib/neo/${file}`, import.meta.url), 'utf8');
  expect(source).toContain(`description: neoToolDescription('${name}')`);
  expect(source).not.toContain(text);
});

test('todo tools no longer promise cards the daemon stopped writing', () => {
  const described = (name: string) =>
    JSON.stringify(describeOperationDefinition(registry.get(name)!));
  expect(described('neo.todo.add')).not.toContain('Mark done and Remove');
  expect(described('neo.todo.add')).toContain('gives you the next step');
  expect(described('neo.todo.remove')).not.toContain('the daemon then asks them');
  expect(described('neo.todo.remove')).toContain('deciding is your next step');
  expect(described('neo.todo.hold')).not.toContain('Why it must wait');
  expect(described('neo.todo.hold')).toContain('Why this step waits; null releases it.');
});
