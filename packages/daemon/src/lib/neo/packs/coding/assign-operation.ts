import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { NeoTodoSessionRepository } from '../../../../storage/repositories/neo-todo-session-repository.ts';
import { StartWorkResultSchema } from '../../../drivers/work-operations.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';
import { defineOperation, type OperationCaller } from '../../../operations/registry.ts';
import type { OperationOutcome } from '../../../operations/invoke.ts';
import { CodingAssignment as Assignment, CodingAssignmentsRepository } from './assignments.ts';
import { sameCodingWorkRef } from './delivery-facts.ts';
import type { CodingPrLedgerRepository } from './pr-ledger.ts';
import type { CodingTodoPrRepository } from './todo-prs.ts';
import { CodingStageTarget } from './stage-preferences.ts';
import type { runCodingReview } from './review.ts';

const Input = z.object({
  todoId: z.string().min(1),
  url: z
    .string()
    .refine((url) => !!parsePrUrl(url))
    .meta({ examples: ['https://github.com/example/repo/pull/1'] }),
  head: z
    .string()
    .regex(/^[a-f\d]{40}$/i)
    .meta({ examples: ['a'.repeat(40)] }),
  acceptanceContract: z.string().trim().min(1),
  stage: z.enum(['review', 'verify']),
  candidates: z.array(CodingStageTarget).max(30),
  human: z.string().trim().min(1).optional(),
});
type Input = z.infer<typeof Input>;
const Pr = z.object({
  body: z.string(),
  headRefOid: z.string(),
  state: z.literal('OPEN'),
  isCrossRepository: z.boolean().optional(),
});
type Pr = z.infer<typeof Pr>;
type Deps = {
  db: Database;
  ledger: CodingPrLedgerRepository;
  todos: CodingTodoPrRepository;
  review: typeof runCodingReview;
  invoke: (name: string, input: unknown, caller: OperationCaller) => Promise<OperationOutcome>;
};
type Failure = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Failure };
const refuse = (reason: string): { reason: Failure } => ({ reason: { ok: false, reason } });
const storedStage = (input: Input) => (input.stage === 'verify' ? 'qa' : 'review');
const repoName = (input: Input) => {
  const pr = parsePrUrl(input.url)!;
  return `${pr.owner}/${pr.repo}`;
};

function admit(input: Input, deps: Deps): Gate<Assignment> {
  const todo = deps.db
    .prepare(
      `SELECT t.state FROM neo_todos t JOIN neo_asks a ON a.id=t.ask_id WHERE t.id=? AND a.status='open'`
    )
    .get(input.todoId) as { state: string } | undefined;
  const write = new NeoTodoSessionRepository(deps.db).readCard(input.todoId)?.ref;
  const contract = deps.db
    .prepare(
      "SELECT json_extract(value_json, '$.acceptanceContract') AS reference FROM pack_facts WHERE todo_id=? AND pack='coding' AND key LIKE 'assignment:%' LIMIT 1"
    )
    .get(input.todoId) as { reference: string } | undefined;
  const head = deps.db
    .prepare('SELECT head FROM pack_coding_stage_heads WHERE url=?')
    .get(githubUrlKey(input.url)) as { head: string } | undefined;
  if (
    !todo ||
    !['doing', 'blocked'].includes(todo.state) ||
    !write ||
    !deps.todos.urls(input.todoId).includes(githubUrlKey(input.url))
  )
    return refuse('A live coding todo with a linked author and PR is required.');
  if (contract && contract.reference !== input.acceptanceContract)
    return refuse('The acceptance contract is immutable; use the original reference.');
  if (head?.head !== input.head)
    return refuse('Observe the current PR head in the coding ledger before assigning an actor.');
  return {
    value: {
      url: githubUrlKey(input.url),
      head: input.head,
      acceptanceContract: input.acceptanceContract,
      newDispatch: true,
      write,
    },
  };
}

export function createCodingAssignmentOperation(deps: Deps) {
  const assignments = new CodingAssignmentsRepository(deps.db),
    running = new Set<string>();
  async function startActor(
    input: Input,
    caller: OperationCaller,
    base: Assignment,
    pr: Pr
  ): Promise<Gate<Assignment>> {
    const review = assignments.read(input.todoId, input.url, input.head).review;
    if (input.stage === 'verify' && (!review || !sameCodingWorkRef(review.write, base.write)))
      return refuse('Assign Review on this head before Verify.');
    if (input.stage === 'review' && input.human)
      return {
        value: {
          ...base,
          actor: { kind: 'human', id: input.human },
          ref: { adapter: 'human', id: input.human },
        },
      };
    if (!input.candidates.length) return refuse('Configure an available independent actor.');
    const select = (candidates: Input['candidates']) =>
      assignments.planTargetCurrent({
        repo: repoName(input),
        stage: input.stage,
        candidates,
        body: pr.body,
      });
    const plan = await select(input.candidates);
    if (!plan.ok) return refuse(plan.reason);
    const message = `Coding-pack ${input.stage === 'verify' ? 'Verify' : 'Review'} run. Before inspecting code, resolve git rev-parse --git-common-dir and read hyperneo-stage-contract.md there; it is your full role contract and its coding-only override. Todo: ${input.todoId}. PR: ${input.url}. Exact head: ${input.head}. Acceptance contract: ${input.acceptanceContract}. Read that acceptance contract and cover every criterion and allowed scope. ${input.stage === 'verify' ? "Use the repository's .claude/skills/verify/SKILL.md (list and read relevant journeys) or Verify section in AGENTS.md. Return durable evidence per criterion; stop owned test resources." : 'Return a soundness verdict across every review-contract dimension, with separate bug/integration and goal/scope passes.'} Do not merge, close or complete the todo. Report facts through Neo with this exact head and contract.`;
    const start = (target: z.infer<typeof CodingStageTarget>) =>
      deps.invoke(
        'work.start',
        {
          ...target,
          todoId: input.todoId,
          title: `${input.stage === 'verify' ? 'Verify' : 'Review'}: ${input.todoId}`,
          message,
          preparation: {
            pack: 'coding',
            parameters: {
              pullRequest: Number(parsePrUrl(input.url)!.number),
              head: input.head,
              role: input.stage,
            },
            ...(pr.isCrossRepository ? { sandbox: true } : {}),
          },
        },
        caller
      );
    let outcome = await start(plan.target);
    if (outcome.kind !== 'completed') return refuse(outcome.message);
    let started = StartWorkResultSchema.parse(outcome.value);
    if (
      !started.ok &&
      [
        'unsupported_model',
        'unsupported_effort',
        'unsupported_preparation',
        'unknown_adapter',
      ].includes(started.reason) &&
      !isDeepStrictEqual(plan.target, input.candidates[0])
    ) {
      const fallback = await select([input.candidates[0]]);
      if (!fallback.ok) return refuse(fallback.reason);
      plan.fallback.push(
        `${started.reason}: preferred configuration unavailable; using the qualifying default.`,
        ...fallback.fallback
      );
      outcome = await start(fallback.target);
      if (outcome.kind !== 'completed') return refuse(outcome.message);
      started = StartWorkResultSchema.parse(outcome.value);
    }
    if (!started.ok) return refuse(`${started.reason}: ${started.detail}`);
    const { ref, model, effort } = started.value;
    if (sameCodingWorkRef(ref, base.write) || (review?.ref && sameCodingWorkRef(ref, review.ref)))
      return refuse('The actor must be a fresh session distinct from author and reviewer.');
    const actor = { kind: 'agent' as const, id: ref.id, harness: ref.adapter, model: model ?? '' };
    if (
      !model ||
      (input.stage === 'review' &&
        !deps.ledger.reviewerPolicy(repoName(input), pr.body, actor).qualifies)
    ) {
      await deps.invoke('work.stop', { ref }, caller);
      return refuse(
        'The started actor did not confirm a qualifying model; configure another actor.'
      );
    }
    return { value: { ...base, ref, actor, effort, fallback: plan.fallback } };
  }

  const assign = (superpipe({})('coding.assign-actor') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe((input: Input) => admit(input, deps), 'input', 'result:assignment')
    .pipe(
      async (input: Input): Promise<Gate<Pr>> => {
        const read = await runGhJson(
          ['gh', 'pr', 'view', input.url, '--json', 'body,headRefOid,state,isCrossRepository'],
          homedir(),
          spawnProcess
        );
        const pr = Pr.safeParse(read.ok ? read.data : null);
        return pr.success && pr.data.headRefOid === input.head
          ? { value: pr.data }
          : refuse('Read the current PR head before assigning an actor.');
      },
      'input',
      'result:assignment'
    )
    .pipe((assignment: Pr) => assignment, 'assignment', 'pr')
    .pipe(
      async (input: Input, caller: OperationCaller, pr: Pr): Promise<Gate<Assignment>> => {
        const base = admit(input, deps);
        if (!('value' in base)) return base;
        const existing = assignments.read(input.todoId, input.url, input.head)[storedStage(input)];
        if (existing && !sameCodingWorkRef(existing.write, base.value.write))
          return refuse('The author changed after assignment; resolve the existing actors first.');
        if (input.stage === 'verify')
          return existing ? { value: existing } : startActor(input, caller, base.value, pr);
        const provenance = deps.ledger.reviewerPolicy(repoName(input), pr.body, {
          kind: 'human',
          id: 'provenance-check',
        });
        if (!provenance.qualifies) return refuse(provenance.reason);
        const reviewBot = deps.ledger.policy(repoName(input)).reviewBot;
        if (
          existing &&
          (existing.bot?.toLowerCase() ?? null) !== (reviewBot?.toLowerCase() ?? null)
        )
          return refuse(
            'Review configuration changed after assignment; resolve it before continuing.'
          );
        let started: Gate<Assignment> | undefined;
        const route = await deps.review(
          { head: input.head, reviews: [], reviewBot },
          {
            startReviewer: async () => {
              started =
                existing && !existing.bot
                  ? { value: existing }
                  : await startActor(input, caller, base.value, pr);
              return 'value' in started ? started.value.ref!.id : '';
            },
          }
        );
        return route.kind === 'bot' ? { value: { ...base.value, bot: route.login } } : started!;
      },
      ['input', 'caller', 'pr'],
      'result:assignment'
    )
    .pipe(
      async (input: Input, caller: OperationCaller, assignment: Assignment) => {
        const existing = assignments.read(input.todoId, input.url, input.head)[storedStage(input)];
        if (existing) return { ok: true, assignment: existing };
        if (await assignments.recordLater(input.todoId, storedStage(input), assignment))
          return { ok: true, assignment };
        if (assignment.ref && assignment.actor?.kind === 'agent')
          await deps.invoke('work.stop', { ref: assignment.ref }, caller);
        return {
          ok: false,
          reason: 'The head or assignment changed; read it again before continuing.',
        };
      },
      ['input', 'caller', 'assignment'],
      'assignment'
    )
    .endAsync('assignment') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<{ ok: true; assignment: Assignment } | Failure>;
  return defineOperation({
    name: 'neo.coding.assign',
    description:
      'Assign Review or Verify on one existing coding todo/PR/head/acceptance contract. Configured bot means no reviewer session; otherwise select a provenance-qualified fresh reviewer or explicit human. Verify starts independently. Candidates are available configurations (default first); shared prefer settings return fallback explanations. Existing exact-head assignments are reused; no merge/completion decisions.',
    inputSchema: Input,
    resultSchema: z.union([
      z.object({ ok: z.literal(true), assignment: Assignment }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ]),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async (input, caller) => {
      if (running.has(input.todoId))
        return { ok: false, reason: 'Actor assignment is already in progress for this todo.' };
      running.add(input.todoId);
      try {
        return await assign(input, caller);
      } finally {
        running.delete(input.todoId);
      }
    },
  });
}
