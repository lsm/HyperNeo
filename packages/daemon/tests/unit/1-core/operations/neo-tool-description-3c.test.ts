import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NEO_TOOL_DESCRIPTIONS, neoToolDescription } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
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
    text: 'Ask the human to apply typed pack settings. The daemon displays and binds this exact immutable proposal; no settings change until human yes. Reuse requestId for pending retries; question_closed means use a new requestId to ask again.',
  },
  {
    file: 'preference-questions.ts',
    name: 'pack.preferences.applyAnswer',
    text: 'Retry applying a bound settings question by questionId only. Requires the recorded human yes; accepts no replacement values. Already-applied answers never overwrite later human changes.',
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.resolve',
    text: 'Resolve an open worker card from a cited saved standing rule or earlier human answer owned by this Neo. Retires the card, stores the answer and citation, and uses its existing worker delivery/hold path. Neo or the local user on its behalf may call this. This is agent resolution, never human approval; start and confirmation cards are refused. source is {kind:"rule",text} with the exact saved text or {kind:"answer",questionId} for a human-answered card. Leave the card open when neither source applies.',
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.ask',
    text: 'Ask the human one question on an open ask you own. Refused unless a reply card asks something, no other card is open on the ask (pass replaces to change it), text fits 400 characters (the rest goes in document), it has no internal ids, and it is in the language set for the human. For a human request, pass input. When a plain human message (not a reply) continues an open ask you own, also pass that askId: the daemon records the message on that ask, and later calls with that input alone reach it. Without askId it opens a new ask. When it derives from one worker output, pass sourceSession {adapter,id,daemon?} from that worker; omit it for mixed or absent sources. The card opens that session without changing the answer controls. For a prepared human-led focused discussion, also pass focused:true: retain its sourceSession on the ask after this card retires, and relay its turns as status only. For a working document, put its absolute path on the owning daemon in text or document with one sentence about it; attach worker handoffs using publicReference and never expose private work or evidence paths. Preview only files on this daemon. Remote files return owner_unavailable; identify their owner rather than re-publishing their paths as local. Optional artifacts retains up to 16 saved or fixed-head Git references, or verified local Markdown/HTML handoff publicReference values, unchanged. Keep the question short instead of pasting the document. retireWhen is a pack check {pack,kind,params}, evaluated each sweep through the same pack check used by todos. Passing retires the card with its evidence, releases its holds and tells Neo; unreadable or unmet facts leave it open. Default: the linked todo check. Without a linked todo check, retireWhen is required (including legacy todos with no check). Its pack, kind and params must pass the same validation as a todo check; unsupported or malformed checks are refused before opening a card. Read returned records for pack warnings (for example missing PR URLs) and correct the condition before leaving a question waiting. For a question about one todo, pass its todoId; the card retires automatically when that todo is done, closed unverified, removed or gone. If a supplied todoId is unknown, belongs to another ask, or is done, closed unverified or removed, supply explicit retireWhen to open the question on the ask without linking that todo; otherwise it is refused. A successful unlinked card includes a todo_closed record. Optional replyTo cites received human message ids this question asks back about; it does not mark those inputs answered. Unknown, foreign, queued and non-human ids are omitted. Format text as Markdown: short title line, a few bullets or a small table, bold key choice; no walls of text. A home proposal uses kind yesno with confirm:{path,sha256}; the question text must show that exact path and 64-character lowercase content hash alongside the proposed change. This records the proposal, not permission to save. kind yesno: noLabel (left, keep things as they are) and yesLabel (right, the change it names). choice: 2-6 options, multiple for pick-any; the card labels them A, B, C… in order and the human may answer by letter, so never put letters in the option text. Every card also has Reply in chat, where the human can answer in their own words, so never add an "other" or "something else" option. reply: answered in chat. start: rewords the start question the daemon opens on this ask for todos waiting to start; the human unticks any they do not want, and answering starts the ticked ones. It never opens a second one. Ask only what you cannot read yourself; never a bookkeeping question. replaces names an open question on the same ask: it is retired as replaced by this one in the same step; a closed question id is ignored and the new question opens on its own. A successful question reply to a consumed human input automatically records one linked chat notice; do not publish a second notice. Options stay on the card and this does not mark the input answered.',
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.retire',
    text: 'Retire an open question on an ask you own when it no longer needs an answer, with the reason in one short sentence. It leaves the open questions and shows in Details as no longer needed. A card its todo is blocked on is refused until that todo is settled, so the work and the card end together. An already closed question comes back unchanged.',
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.relay',
    text: "Put a worker's question in front of the human, written in your own plain words as title and 2-6 options. Use it only when you cannot answer the worker yourself. The human's answer goes back to that worker. For a session with no todo, pass session (its notice key); the daemon opens an ask following that session. Refused while another card is open on the ask, so relay once it is answered, and by the same card rules as neo.question.ask.",
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.get',
    text: "Read one of Neo's questions to the human by id: its text, state, answer and optional home path/hash binding. Its document field, when present, returns the full text separately from the short card text. answeredByHuman is true only when the human answered it, by button or in their own chat; use it to check a decision another session reports. resolvedByAgent marks a cited Neo resolution, whose durable citation is in retiredReason; it is never human approval.",
  },
  {
    file: 'question-operations.ts',
    name: 'neo.question.answer',
    text: "The human's answer to an open question: no or yes, the chosen options, their words, or the todos to start. The answer goes to the ask's Neo session.",
  },
  {
    file: 'rule-questions.ts',
    name: 'neo.rule.ask',
    text: 'Default path for standing-rule edits in any Neo turn: ask human yes to the exact add/remove arrays. Removal uses exact saved text. No rule changes before human yes. Pending retries reuse requestId; question_closed needs a new requestId.',
  },
  {
    file: 'rule-questions.ts',
    name: 'neo.rule.applyAnswer',
    text: 'Apply only the immutable rule edit bound to questionId after recorded human yes, in any turn. Accepts no replacement values. Check this result after human yes: changed current rules can prevent application; a refusal leaves them unchanged. Repeated application never overwrites later changes.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.add',
    text: "Add a todo to an open ask you own. For a human request, pass input. When a plain human message (not a reply) continues an open ask you own, also pass that askId: the daemon records the message on that ask, and later calls with that input alone reach it. Without askId it opens a new ask. For multi-PR work, use one PR per todo with its pack merge check. Each todo after the first uses after with the previous todo id; the queue starts it when that todo finishes. Once its PR opens, name that PR with neo.todo.edit addUrls on its own todo. A coding PR already tracked by another live todo on that ask is recorded without blocking; prefer continuing the original todo. neo.todo.edit addUrls only pins URLs to an existing PR-merge check. Pass title and a required check {pack, kind, params}; doneWhen is generated, never supplied. Use a completion check the installed pack supports; core.human_confirmed {questionId}, core.evidence {} (preferred: the daemon assigns the path and gives it to the worker; {path: absolute file path} only for a result the human should see), or core.deployed {repo: lsm/HyperNeo, sha: full commit}. A pack may reject malformed checks or record bookkeeping conditions. Workers are long-lived sessions: name them for the project and a number, never a task title. For local starts, the daemon names a new worker '<engine> <project> <n>'; pass target.name only to choose another project-style name. instruction is the task for a session and target says where it runs ({verb: start, adapter, place?} or {verb: send, ref}). Spell out the task: every step that needs work done gets its instruction and target when you add it; leave both out only for a step that just waits on its check, such as a merge or a deploy, since nothing runs a step without them. non-coding todos share one visible user folder across projects when place is omitted: ~/HyperNeo by default, or exactly the instance workspace path. A different place needs an exact path the user named in chat, even inside the workspace; never invent folders under home. Coding keeps its repository place. Coding send targets must be in the todo repository; mismatched or unknown worker remotes are refused. To give a running worker this task use target {verb: send, ref}; to attach work that is already doing it, add the todo without instruction or target and call neo.todo.bind {todoId, ref}, with after: [] when it runs in parallel, since bind waits for unfinished prerequisites; without them the daemon checks the todo itself. named records what the human named for it (engine, session, repository, folder). A session the human named is sent to only through the ref work.find {session} returns as an exact match. start:true records that the human approved it: it starts once what it waits for is finished, so put it on every step of an approved plan. Otherwise the daemon lists it, ticked, in the start question of the ask, and one answer approves everything ticked. priority (urgent, high, normal, low; default normal) orders waiting work, urgent first: set it from how urgent the human made it; it can change later with neo.todo.edit. Steps the human approved start themselves in order as worker slots free; do not start them yourself. A step added after the ask started still waits for its own start answer.",
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.bind',
    text: 'Coding work requires worker remotes matching the todo repository; mismatched or unknown remotes are refused. Bind an unfinished todo on an open ask to an existing running worker, without sending or starting anything. Use this to repair a failed backfill instead of retrying its instruction. Records worker and doing, clears failure and old delivery evidence; does not stop the existing worker. A step with unfinished prerequisites is refused, so add independent running work with after: [].',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.edit',
    text: 'Change a todo on an open ask you own: title or check {pack, kind, params}; the completion sentence is generated from the check, or reword it directly with doneWhen. addUrls appends PR URLs to its PR-merge check. Duplicate claims and URLs unsupported by the check are recorded without blocking the edit. Prefer editing to adding a duplicate PR todo. For multi-PR work, use one PR per todo with its pack merge check; addUrls names only the PR for that todo once opened. Give each later todo after with the previous todo id so the queue starts it after that todo finishes. Or record completion evidence (done met for what you read, reported for a claim you cannot read); without a passed outcome check it stays open, blocked by its check, and finishes by itself once the check passes; give a working document or evidence file as its absolute path on the owning daemon with one sentence of evidence, not the pasted document. Preview only files on this daemon. Remote files return owner_unavailable; identify their owner rather than re-publishing their paths as local. The artifacts field remains for existing saved attachments and fixed-head Git references. A todo with an unanswered card is refused until the human answers it. Worker final-line blockers are recorded automatically: needs_human first wakes Neo: answer the worker and continue if you can; otherwise ask the human with neo.question.ask (yesno or choice with options) linked to the todo. A blocker you leave alone is never shown to the human: you get one reminder after 60 minutes. Handle environment blockers by retrying or escalating their cause. To hold or release a todo use neo.todo.hold. after is refused while a prerequisite is cancelled: neo.todo.proceed clears it. priority changes where waiting work starts in the queue. A check-only todo queued without instruction or target reminds Neo daily after 24 hours: provide both, or hold/remove it. instruction with target gives a todo that has not started and has no instruction its work; the queue then starts it like any approved step. A start target for a coding todo needs target.place from work.find. A send target requires worker remotes matching the todo repository; unknown remotes are refused.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.hold',
    text: 'Hold a todo that has not started so nothing starts it: reason says why. reason null releases a held todo. Hold only what the human said must wait.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.remove',
    text: 'Remove a todo from an open ask you own, with the reason: this is how to cancel or replace one, started or not; neo.todo.close is only for work really done. Its session stops if it is running, unless the todo only follows a session the human tracked. An invalid replacedBy is recorded while removal proceeds without a replacement link. Unstarted dependents wait and you are told once: neo.todo.proceed continues one, neo.todo.remove stops it. replacedBy names the todo that replaces it; a dependent you continue waits for it instead. A removed todo stays listed, struck through.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.continue',
    text: "Send a started todo's session its next step. Coding work requires worker remotes matching the todo repository; mismatched or unknown remotes are refused. The todo goes back to doing until the session reports again, and a card it was waiting on closes with it. An unstarted todo or settled ask returns a record without dispatching or approving a start.",
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.proceed',
    text: 'Continue an unstarted todo whose prerequisite was cancelled. It drops the cancelled prerequisite, or waits for its replacement, and keeps its other prerequisites. A step the human has not approved is refused: it stays on its Start card. Nothing else clears this wait, so a cancelled prerequisite never starts the next step by itself.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.retry',
    text: 'Retry a failed todo in place with a new attempt, keeping its todoId. A nonretryable todo or settled ask returns a record without dispatching. If it has a worker, send the original instruction to that worker; otherwise start its recorded target again. Do not remove and replace it. Choose the delivery channel or adapter for reaching the same worker session yourself; never ask the human to choose it. Ask the human before changing which worker or target does the work.',
  },
  {
    file: 'todo-operations.ts',
    name: 'neo.todo.close',
    text: 'Close a todo whose work is really done, with your reason; to cancel or replace it use neo.todo.remove. A todo that never started is refused, unchanged, unless its outcome check passes. A started todo is done only when its outcome check passes; otherwise it stays open, blocked by its check with the unmet reason, and finishes by itself once the check passes; if the check is wrong, fix it with neo.todo.edit check. Its session stops if it is running, unless the todo only follows a session the human tracked. A todo with an unanswered card is refused until the human answers it.',
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
