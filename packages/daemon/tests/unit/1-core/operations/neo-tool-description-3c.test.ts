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
    text: 'Ask the human to apply typed pack settings. The daemon displays and binds this exact immutable proposal as a choice to apply these settings or keep the current ones; no settings change until the human picks apply. To offer a pick among values, pass alternatives (2–5 value sets) instead of values: each becomes one option before keep, and only the option the human picks is applied. Reuse requestId for pending retries; question_closed means use a new requestId to ask again.',
  },
  {
    file: 'preference-questions.ts',
    name: 'pack.preferences.applyAnswer',
    text: "Retry applying a bound settings question by questionId only. Requires the human's recorded apply answer; accepts no replacement values. Already-applied answers never overwrite later human changes.",
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.ask',
    text: 'Ask the human one question on an open ask you own. Refused unless a reply card asks something, no other card is open on the ask (pass replaces to change it), text fits 400 characters (the rest goes in document), it has no internal ids, and it is in the language set for the human. For a human request, pass input. When a plain human message (not a reply) continues an open ask you own, also pass that askId: the daemon records the message on that ask, and later calls with that input alone reach it. Without askId it opens a new ask. When it derives from one worker output, pass sourceSession {adapter,id,daemon?} from that worker; omit it for mixed or absent sources. The card opens that session without changing the answer controls. For a prepared human-led focused discussion, also pass focused:true: retain its sourceSession on the ask after this card retires, and relay its turns as status only. For a working document, put its absolute path on the owning daemon in text or document with one sentence about it; attach worker handoffs using publicReference and never expose private work or evidence paths. Preview only files on this daemon. Remote files return owner_unavailable; identify their owner rather than re-publishing their paths as local. Optional artifacts retains up to 16 saved or fixed-head Git references, or verified local Markdown/HTML handoff publicReference values, unchanged. Keep the question short instead of pasting the document. retireWhen is a pack check {pack,kind,params}, evaluated each sweep through the same pack check used by todos. Passing retires the card with its evidence, releases its holds and tells Neo; unreadable or unmet facts leave it open. Default: the linked todo check. Without a linked todo check, retireWhen is required (including legacy todos with no check). Its pack, kind and params must pass the same validation as a todo check; unsupported or malformed checks are refused before opening a card. Read returned records for pack warnings (for example missing PR URLs) and correct the condition before leaving a question waiting. For a question about one todo, pass its todoId; the card retires automatically when that todo is removed or gone. Marking the todo done is refused while the linked card is open; a card linked to an already done todo stays open unless its retirement check passes. If a supplied todoId is unknown, belongs to another ask, or is done or removed, supply explicit retireWhen to open the question on the ask without linking that todo; otherwise it is refused. A successful unlinked card includes a todo_closed record. Optional replyTo cites received human message ids this question asks back about; it does not mark those inputs answered. Unknown, foreign, queued and non-human ids are omitted. Format text as Markdown: short title line, a few bullets or a small table, bold key choice; no walls of text. A home proposal is a choice with one option and confirm:{path,sha256}; the question text must show that exact path and 64-character lowercase content hash alongside the proposed change. This records the proposal, not permission to save. choice: 1-6 options, multiple for pick-any. Each option is an action the human can take; one option confirms that action. A card left open is undecided, so no option may mean later or not now: when the human decides a step must wait, record that with neo.todo.hold. The card numbers them 1, 2, 3… in order and the human may answer by number. Each option must say its whole choice; never refer to options by number, letter or nickname in text. Every card also has Reply in chat, where the human can answer in their own words, so never add an "other" or "something else" option. reply: answered in chat. New todos start by themselves, so when the human must say yes before the work runs, ask with a choice card (one option to confirm) before adding it. Ask only what you cannot read yourself; never a bookkeeping question. relay puts a worker\'s question in front of the human, written in your own plain words as text (one line, at most 80 characters) and 2-6 options; use it only when you cannot answer the worker yourself. The human\'s answer goes back to that worker. Pass todoId, or session (its notice key) for a session with no todo, and the daemon opens an ask following that session. A relay is refused while another card is open on the ask. A proposal or relayed-session work decision cannot be replaced; the human must answer it. replaces names an open question on the same ask: it is retired as replaced by this one in the same step; a closed question id is ignored and the new question opens on its own. A card the human holds (heldAt) cannot be replaced: leave it until they answer it or take it back. A successful question reply to a consumed human input automatically records one linked chat notice; do not publish a second notice. Options stay on the card and this does not mark the input answered.',
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.retire',
    text: 'Retire an open question on an ask you own when it no longer needs an answer, with the reason in one short sentence. It leaves the open questions and shows in Details as no longer needed. A proposal or relayed-session work decision must be answered by the human and cannot be retired. A card its todo is blocked on is refused until that todo is settled, so the work and the card end together. A card the human holds (heldAt) is refused too: they put it aside on purpose, so do not remind them about it. An already closed question comes back unchanged.',
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
    text: 'Default path for standing-rule edits in any Neo turn: ask the human to apply or keep the exact add/remove arrays. Removal uses exact saved text. No rule changes until the human picks apply. Pending retries reuse requestId; question_closed needs a new requestId.',
  },
  {
    file: 'rule-questions.ts',
    name: 'neo.rule.applyAnswer',
    text: "Apply only the immutable rule edit bound to questionId after the human's recorded apply answer, in any turn. Accepts no replacement values. Check this result after that answer: changed current rules can prevent application; a refusal leaves them unchanged. Repeated application never overwrites later changes.",
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.add',
    text: "Add a todo to an open ask you own. For a human request, pass input. When a plain human message (not a reply) continues an open ask you own, also pass that askId: the daemon records the message on that ask, and later calls with that input alone reach it. Without askId it opens a new ask. For multi-PR work, use one PR per todo with its pack merge check. after is required on every todo and there is no default order: after [] waits for nothing, after [ids] waits for exactly those todos, and a call without after is refused. In a chain each todo after the first names the previous todo id; the queue starts it when that todo finishes. Once its PR opens, name that PR with neo.todo.edit addUrls on its own todo. A coding PR already tracked by another live todo on that ask is recorded without blocking; prefer continuing the original todo. neo.todo.edit addUrls only pins URLs to an existing PR-merge check. Pass title and a required check {pack, kind, params}; doneWhen is generated, never supplied. Use a completion check the installed pack supports; core.human_confirmed {questionId}, core.evidence {path: absolute file path} for non-coding results in a persistent location visible to the human, or core.deployed {repo: lsm/HyperNeo, sha: full commit}. Coding todos use pr_merged, pr_approved, issue_closed, deployed, or human_confirmed. A pack may reject malformed checks or record bookkeeping conditions. Workers are long-lived sessions: name them for the project and a number, never a task title. For local starts, the daemon names a new worker '<engine> <project> <n>'; pass target.name only to choose another project-style name. instruction is the task for a session and target says where it runs ({verb: start, adapter, place?} or {verb: send, ref}). Spell out the task: every step that needs work done gets its instruction and target when you add it; leave both out only for a step that just waits on its check, such as a merge or a deploy, since nothing runs a step without them. non-coding todos share one visible user folder across projects when place is omitted: ~/HyperNeo by default, or exactly the instance workspace path. A different place needs an exact path the user named in chat, even inside the workspace; never invent folders under home. Coding keeps its repository place. Coding send and bind targets must be in the todo repository; mismatched or unknown worker remotes are refused. To give a running worker this task use target {verb: send, ref}; to attach work that is already doing it use target {verb: bind, ref} without instruction: the todo is recorded as doing on that worker and nothing is sent. Pass after [] when it runs in parallel, since a bind target is refused while what it waits for is unfinished. Without instruction or target the daemon checks the todo itself; if its check has not passed 24 hours after what it waits for finished, the next step is yours: ask the human with neo.question.ask when they must do it. named records what the human named for it (engine, session, repository, folder). A session the human named is sent to only through the ref work.find {session} returns as an exact match. A todo with an instruction and target starts by itself once what it waits for is finished and a worker slot is free; there is no start flag and no Start card. When the human must decide before the work runs, ask with neo.question.ask before you add it. priority (urgent, high, normal, low; default normal) orders waiting work, urgent first: set it from how urgent the human made it; it can change later with neo.todo.edit. Set producesFollowUp: true on a todo whose result is more work, such as a design, plan, research or inventory. When it finishes, add each follow-up it calls for with after [its id] (they may stay unstarted); until one exists its ask cannot settle done and the daemon wakes you to add them. Never start todos yourself.",
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.edit',
    text: 'Change a todo on an open ask you own: title or check {pack, kind, params}; the completion sentence is generated from the check, or reword it directly with doneWhen. addUrls appends PR URLs to its PR-merge check. Duplicate claims and URLs unsupported by the check are recorded without blocking the edit. Prefer editing to adding a duplicate PR todo. For multi-PR work, use one PR per todo with its pack merge check; addUrls names only the PR for that todo once opened. Give each later todo after with the previous todo id so the queue starts it after that todo finishes. Or record completion evidence (done met for what you read, reported for a claim you cannot read); without a passed outcome check it stays open, blocked by its check, and finishes by itself once the check passes; give a working document or evidence file as its absolute path on the owning daemon with one sentence of evidence, not the pasted document. Preview only files on this daemon. Remote files return owner_unavailable; identify their owner rather than re-publishing their paths as local. The artifacts field remains for existing saved attachments and fixed-head Git references. A todo with an unanswered card is refused until the human answers it. Worker final-line blockers are recorded automatically: needs_human first wakes Neo: answer the worker and continue if you can; otherwise ask the human with neo.question.ask (a choice with one option to confirm or several to choose, or a reply) linked to the todo. A blocker you leave alone is never shown to the human: it wakes you again until you resolve it. Handle environment blockers by retrying or escalating their cause. To hold or release a todo use neo.todo.hold. To continue a step whose prerequisite was removed, give it after without that prerequisite. priority changes where waiting work starts in the queue. A check-only todo queued without instruction or target waits on its check: the daemon polls it, and if it has not passed 24 hours after what it waits for finished, the next step is yours. Give it both when a worker should do it instead, or hold/remove it. instruction with target gives a todo that has not started and has no instruction its work; the queue then starts it like any other step. A start target for a coding todo needs target.place from work.find. A send target requires worker remotes matching the todo repository; unknown remotes are refused.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.hold',
    text: "Hold a todo that is waiting to start, or pause one that is running, to ask the human whether it goes ahead. reason is the card's whole text: your question to the human in their language, naming what waits, why it needs them, and that Start or Resume goes ahead and Remove drops it. The daemon stops a running todo's worker and opens that card with Start or Resume and Remove; the card is the hold, and the human's answer releases it. reason null releases a todo held by an older start answer. Hold only what the human said must wait.",
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.remove',
    text: 'Remove a todo from an open ask you own, with the reason: this is how to cancel or replace one, started or not; neo.todo.done is for finished work. Its session stops if it is running, unless the todo only follows a session the human tracked. An invalid replacedBy is recorded while removal proceeds without a replacement link. replacedBy names the todo that replaces it; todos that waited for the removed one wait for the replacement instead. Without a replacement, say what its unstarted dependents do with dependents: continue (they go on without it) or remove (they and the unstarted steps behind them are removed too). Leave dependents out only when the human has not said which: nothing behind it starts, and deciding whether those steps continue or go is your next step. Dependents that already started keep running. A removed todo stays listed, struck through.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.continue',
    text: "Send a started todo's session its next step. Coding work requires worker remotes matching the todo repository; mismatched or unknown remotes are refused. The todo goes back to doing until the session reports again, and a card it was waiting on closes with it. A pending relayed-session decision must be answered by the human before this todo can continue. An unstarted todo or settled ask returns a record without dispatching or approving a start. A failed todo gets a new attempt in place, keeping its todoId: its worker gets message, or its original instruction without one; with no worker its recorded target starts again. Do not remove and replace it. Only a failed todo may omit message.",
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
  expect(described('neo.todo.add')).toContain('the next step is yours');
  expect(described('neo.todo.remove')).not.toContain('the daemon then asks them');
  expect(described('neo.todo.remove')).toContain('deciding is your next step');
  expect(described('neo.todo.hold')).not.toContain('Why it must wait');
  expect(described('neo.todo.hold')).toContain('The card’s whole text: your question to the human');
});
