import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import {
  type NeoRoute,
  NeoRoutingLogRepository,
  neoExcerpt,
} from '../../storage/repositories/neo-routing-log-repository.ts';
import { classifyNeoRoute } from './route-classifier.ts';

const MIN_SIMILARITY = 0.55;
const MIN_MARGIN = 0.05;
const PROFILE_ASKS = 8;
const PROFILE_ASK_CHARS = 300;
const CLASSIFY_FLOOR = 0.35;
const TOPIC_LIMIT = 15;
const RECENT_TURNS = 20;
const TURNS_CHARS = 3_000;
const TURN_TEXT_CHARS = 300;
const TOPIC_SUMMARY_CHARS = 160;
export const NEO_INBOX_ID = 'inbox';
export const NEO_INBOX_SUMMARY = 'Self-contained one-off questions that need no continuing topic.';
const INBOX_CHOICE: NeoHolder = {
  concernId: NEO_INBOX_ID,
  sessionId: '',
  title: 'Inbox',
  summary: NEO_INBOX_SUMMARY,
};

export interface NeoHolder {
  concernId: string;
  sessionId: string;
  title: string;
  summary: string;
}

export interface NeoRouteChoice {
  concernId: string;
  sessionId: string;
  signal: 'embedding' | 'classifier';
  confidence: number;
}

export type NeoRouteAnswer = NeoHolder | 'main' | null;

export interface NeoRouterDeps {
  holders(): NeoHolder[];
  recentTurns(): NeoRoute[];
  topicTurns(): NeoRoute[];
  recentAsks(concernId: string, limit: number): string[];
  embed(text: string): Promise<Float32Array | null>;
  classify?(text: string, options: readonly NeoHolder[], context: string): Promise<NeoRouteAnswer>;
  inbox?(): Promise<NeoHolder | null>;
}

const profileVectors = new Map<string, Float32Array>();

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftSize = 0;
  let rightSize = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftSize += left[index] * left[index];
    rightSize += right[index] * right[index];
  }
  return leftSize === 0 || rightSize === 0 ? -1 : dot / Math.sqrt(leftSize * rightSize);
}

export function pickNeoHolder(
  scores: readonly { holder: NeoHolder; similarity: number }[]
): NeoRouteChoice | null {
  const [top, second] = [...scores].sort((a, b) => b.similarity - a.similarity);
  if (!top || top.similarity < MIN_SIMILARITY) return null;
  if (second && top.similarity - second.similarity < MIN_MARGIN) return null;
  return {
    concernId: top.holder.concernId,
    sessionId: top.holder.sessionId,
    signal: 'embedding',
    confidence: Math.round(top.similarity * 1000) / 1000,
  };
}

type Score = { holder: NeoHolder; similarity: number };
type Routed = { choice: NeoRouteChoice | null };
type Exit = { reason: Routed };

export function requireAskText(text: string): { value: string } | Exit {
  return text.trim() ? { value: text } : { reason: { choice: null } };
}

export function neoHolderProfile(holder: NeoHolder, asks: readonly string[]): string {
  return [holder.title, holder.summary, ...asks.map((ask) => neoExcerpt(ask, PROFILE_ASK_CHARS))]
    .filter(Boolean)
    .join('\n');
}

async function profileVector(profile: string, deps: NeoRouterDeps): Promise<Float32Array | null> {
  const cached = profileVectors.get(profile);
  if (cached) return cached;
  const vector = await deps.embed(profile);
  if (vector) profileVectors.set(profile, vector);
  return vector;
}

export async function scoreNeoHolders(
  text: string,
  topical: readonly NeoHolder[],
  deps: NeoRouterDeps
): Promise<Score[]> {
  const message = topical.length > 0 ? await deps.embed(text) : null;
  if (!message) return [];
  const scores: Score[] = [];
  for (const holder of topical) {
    const profile = neoHolderProfile(holder, deps.recentAsks(holder.concernId, PROFILE_ASKS));
    const vector = await profileVector(profile, deps);
    if (vector) scores.push({ holder, similarity: cosine(message, vector) });
  }
  return scores;
}

function topicOf(route: NeoRoute): string {
  return route.concernId ?? 'main';
}

export function neoTurnLine(route: NeoRoute, titles: ReadonlyMap<string, string>): string {
  const topic = topicOf(route);
  const ask = neoExcerpt(route.askSummary ?? route.ask, TURN_TEXT_CHARS);
  const answer = route.outcome ? neoExcerpt(route.outcome, TURN_TEXT_CHARS) : '(no reply yet)';
  return `[${titles.get(topic) ?? topic}] you: "${ask}" → ${answer}`;
}

export function neoRouteCandidates(
  holders: readonly NeoHolder[],
  scores: readonly Score[],
  recent: readonly NeoRoute[],
  latest: readonly NeoRoute[]
): NeoHolder[] {
  if (holders.length <= TOPIC_LIMIT) return [...holders];
  const keep = new Set(
    [...recent, ...latest.filter((route) => route.awaiting)].flatMap((route) =>
      route.concernId ? [route.concernId] : []
    )
  );
  for (const score of [...scores].sort((a, b) => b.similarity - a.similarity)) {
    if (keep.size >= TOPIC_LIMIT || score.similarity < CLASSIFY_FLOOR) break;
    keep.add(score.holder.concernId);
  }
  return holders.filter((holder) => keep.has(holder.concernId)).slice(0, TOPIC_LIMIT);
}

export function requireRouteQuestion(
  candidates: readonly NeoHolder[],
  recent: readonly NeoRoute[]
): { value: NeoHolder[] } | Exit {
  return candidates.length > 0 || recent.length > 0
    ? { value: [...candidates] }
    : { reason: { choice: null } };
}

export function renderNeoRouteContext(
  holders: readonly NeoHolder[],
  candidates: readonly NeoHolder[],
  recent: readonly NeoRoute[],
  latest: readonly NeoRoute[],
  withInbox: boolean
): string {
  const titles = new Map(holders.map((holder) => [holder.concernId, holder.title]));
  const notes = (topic: string) => {
    const route = latest.find((item) => topicOf(item) === topic);
    if (!route) return [];
    return [
      `    last: ${neoTurnLine(route, titles)}`,
      ...(route.awaiting
        ? [`    WAITING ON YOU: "${neoExcerpt(route.awaiting, TURN_TEXT_CHARS)}"`]
        : []),
    ];
  };
  const topics = [
    '- main: Neo itself, the default',
    ...notes('main'),
    ...candidates.flatMap((holder) => [
      `- ${holder.concernId}: ${holder.title}${holder.summary ? ` (${neoExcerpt(holder.summary, TOPIC_SUMMARY_CHARS)})` : ''}`,
      ...notes(holder.concernId),
    ]),
    ...(withInbox ? [`- ${NEO_INBOX_ID}: ${NEO_INBOX_SUMMARY}`, ...notes(NEO_INBOX_ID)] : []),
  ];
  const turns: string[] = [];
  let used = 0;
  for (const route of recent) {
    const line = `- ${neoTurnLine(route, titles)}`;
    if (used + line.length + 1 > TURNS_CHARS) break;
    turns.push(line);
    used += line.length + 1;
  }
  return [
    'Topics:',
    ...topics,
    '',
    'Recent turns (newest first):',
    ...(turns.length > 0 ? turns : ['(none)']),
  ].join('\n');
}

export async function classifyNeoAsk(
  text: string,
  candidates: readonly NeoHolder[],
  context: string,
  scores: readonly Score[],
  deps: NeoRouterDeps
): Promise<Routed> {
  const options = [...candidates, ...(deps.inbox ? [INBOX_CHOICE] : [])];
  const chosen = deps.classify ? await deps.classify(text, options, context) : null;
  if (chosen === 'main') return { choice: null };
  if (!chosen) return { choice: pickNeoHolder(scores) };
  const holder = chosen.concernId === NEO_INBOX_ID ? await deps.inbox?.() : chosen;
  return {
    choice: holder
      ? {
          concernId: holder.concernId,
          sessionId: holder.sessionId,
          signal: 'classifier',
          confidence: 0.6,
        }
      : null,
  };
}

const runNeoRoute = (superpipe({})('neo-route') as PipelineAPI)
  .input(['text', 'deps'])
  .pipe(requireAskText, 'text', 'result:route')
  .pipe(
    (deps: NeoRouterDeps) => deps.holders().filter((holder) => holder.concernId !== NEO_INBOX_ID),
    'deps',
    'holders'
  )
  .pipe((deps: NeoRouterDeps) => deps.recentTurns(), 'deps', 'recent')
  .pipe((deps: NeoRouterDeps) => deps.topicTurns(), 'deps', 'latest')
  .pipe(scoreNeoHolders, ['text', 'holders', 'deps'], 'scores')
  .pipe(neoRouteCandidates, ['holders', 'scores', 'recent', 'latest'], 'candidates')
  .pipe(requireRouteQuestion, ['candidates', 'recent'], 'result:route')
  .pipe((deps: NeoRouterDeps) => !!deps.inbox, 'deps', 'withInbox')
  .pipe(
    renderNeoRouteContext,
    ['holders', 'candidates', 'recent', 'latest', 'withInbox'],
    'context'
  )
  .pipe(classifyNeoAsk, ['text', 'candidates', 'context', 'scores', 'deps'], 'route')
  .endAsync('route') as (text: string, deps: NeoRouterDeps) => Promise<Routed>;

export async function chooseNeoRoute(
  text: string,
  deps: NeoRouterDeps
): Promise<NeoRouteChoice | null> {
  return (await runNeoRoute(text, deps)).choice;
}

export type NeoRouter = (text: string) => Promise<NeoRouteChoice | null>;

export function createNeoRouter(
  db: Database,
  repo: NeoRepository,
  openHolder?: (concernId: string) => Promise<string>
): NeoRouter {
  const log = new NeoRoutingLogRepository(db.getDatabase());
  const deps: NeoRouterDeps = {
    holders: () =>
      repo.listConcerns().flatMap((concern) => {
        const binding = repo.getBindingForConcern(concern.id);
        const session = binding ? db.getSession(binding.sessionId) : null;
        return binding && session && session.status !== 'archived'
          ? [
              {
                concernId: concern.id,
                sessionId: binding.sessionId,
                title: concern.title,
                summary: concern.summary,
              },
            ]
          : [];
      }),
    recentTurns: () => log.recent(RECENT_TURNS),
    topicTurns: () => log.latestPerTopic(),
    recentAsks: (concernId, limit) => log.recentAsks(concernId, limit),
    embed: async (text) => {
      if (process.env.NODE_ENV === 'test') return null;
      try {
        return Float32Array.from(await db.getEmbedder().embedQuery(text));
      } catch {
        return null;
      }
    },
    classify: classifyNeoRoute,
    inbox: openHolder
      ? async () => {
          repo.saveConcern(
            { id: NEO_INBOX_ID, title: 'Inbox', summary: NEO_INBOX_SUMMARY, context: '' },
            0
          );
          const sessionId = await openHolder(NEO_INBOX_ID);
          return { ...INBOX_CHOICE, sessionId };
        }
      : undefined,
  };
  return (text) => chooseNeoRoute(text, deps);
}
