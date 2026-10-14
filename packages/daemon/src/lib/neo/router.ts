import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import {
  type NeoRoute,
  NeoRoutingLogRepository,
  neoExcerpt,
} from '../../storage/repositories/neo-routing-log-repository.ts';
import { getProviderService } from '../provider-service.ts';
import { classifyNeoRoute, neoRouteTimeoutMs } from './route-classifier.ts';
import { cosineSimilarity, embedQueryOrNull } from '../../storage/vector-similarity.ts';
import { isNeoAskSettled } from './done-check.ts';
import { fitLines } from './fit-lines.ts';

const MIN_SIMILARITY = 0.55;
const MIN_MARGIN = 0.05;
const PROFILE_ASKS = 8;
const PROFILE_ASK_CHARS = 300;
const CLASSIFY_FLOOR = 0.35;
const PROJECT_LIMIT = 15;
const RECENT_TURNS = 20;
const TURNS_CHARS = 3_000;
const TURN_TEXT_CHARS = 300;
const PROJECT_SUMMARY_CHARS = 160;
const PROFILE_VECTOR_LIMIT = 256;
const OPEN_ASKS = 5;
const OPEN_ASK_CHARS = 120;
export const NEO_INBOX_ID = 'inbox';
export const NEO_INBOX_SUMMARY =
  'Self-contained one-off questions that need no continuing project.';
const INBOX_CHOICE: NeoHolder = {
  projectId: NEO_INBOX_ID,
  sessionId: '',
  title: 'Inbox',
  summary: NEO_INBOX_SUMMARY,
};

const NEW_PROJECT_TITLE_CHARS = 60;

export function neoNewProject(
  text: string,
  id: string
): { id: string; title: string; summary: string } {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
  return {
    id,
    title:
      line.length <= NEW_PROJECT_TITLE_CHARS
        ? line
        : `${line.slice(0, NEW_PROJECT_TITLE_CHARS - 1).trimEnd()}…`,
    summary: neoExcerpt(text.trim(), PROJECT_SUMMARY_CHARS),
  };
}

export async function openNeoNewProject(
  repo: Pick<NeoRepository, 'saveProject' | 'getProject' | 'discardUnopenedProject'>,
  openHolder: (projectId: string) => Promise<string>,
  project: { id: string; title: string; summary: string }
): Promise<NeoHolder | null> {
  const saved = repo.saveProject({ ...project, context: '' }, 0) ?? repo.getProject(project.id);
  if (!saved) return null;
  try {
    const sessionId = await openHolder(saved.id);
    return { projectId: saved.id, sessionId, title: saved.title, summary: saved.summary };
  } catch {
    repo.discardUnopenedProject(saved.id);
    return null;
  }
}

export interface NeoHolder {
  projectId: string;
  sessionId: string;
  title: string;
  summary: string;
  provider?: string;
}

export interface NeoRouteChoice {
  projectId: string;
  sessionId: string;
  signal: NeoRouteSignal;
  confidence: number;
}

type NeoRouteAnswer = NeoHolder | 'main' | null;
export const NEO_ROUTE_BASES = [
  'continues_turn',
  'answers_waiting',
  'matches_project',
  'one_off',
  'new_subject',
  'cross_project',
  'unsure',
] as const;
export type NeoRouteBasis = (typeof NEO_ROUTE_BASES)[number];
export interface NeoRouteDecision {
  decision: NeoHolder | 'main';
  confidence: number | null;
  basis: NeoRouteBasis | null;
}
export type NeoRouteVerdict = NeoRouteAnswer | NeoRouteDecision | 'timeout' | 'failed';
const CLASSIFIER_CONFIDENCE = 0.6;
export type NeoRouteSignal = 'embedding' | 'classifier' | `classifier:${NeoRouteBasis}`;

function classifierSignal(basis: NeoRouteBasis | null | undefined): NeoRouteSignal {
  return basis ? `classifier:${basis}` : 'classifier';
}

export interface NeoRouterDeps {
  holders(): NeoHolder[] | Promise<NeoHolder[]>;
  recentTurns(): NeoRoute[];
  projectTurns(): NeoRoute[];
  recentAsks(projectId: string, limit: number): string[];
  openAsks?(projectId: string): string[];
  embed(text: string): Promise<Float32Array | null>;
  classify?(text: string, options: readonly NeoHolder[], context: string): Promise<NeoRouteVerdict>;
  inbox?(): Promise<NeoHolder | null>;
  newProject?(text: string, key?: string): Promise<NeoHolder | null>;
  inboxRunnable?(): Promise<boolean>;
}

const profileVectors = new Map<string, Float32Array>();

export function pickNeoHolder(
  scores: readonly { holder: NeoHolder; similarity: number }[]
): NeoRouteChoice | null {
  const [top, second] = [...scores].sort((a, b) => b.similarity - a.similarity);
  if (!top || top.similarity < MIN_SIMILARITY) return null;
  if (second && top.similarity - second.similarity < MIN_MARGIN) return null;
  return {
    projectId: top.holder.projectId,
    sessionId: top.holder.sessionId,
    signal: 'embedding',
    confidence: Math.round(top.similarity * 1000) / 1000,
  };
}

type Score = { holder: NeoHolder; similarity: number };
export type NeoRouted = { choice: NeoRouteChoice | null; fallback?: string };
type Routed = NeoRouted;
type Exit = { reason: Routed };

function requireAskText(text: string): { value: string } | Exit {
  return text.trim() ? { value: text } : { reason: { choice: null } };
}

export function neoHolderProfile(holder: NeoHolder, asks: readonly string[]): string {
  return [holder.title, holder.summary, ...asks.map((ask) => neoExcerpt(ask, PROFILE_ASK_CHARS))]
    .filter(Boolean)
    .join('\n');
}

async function profileVector(profile: string, deps: NeoRouterDeps): Promise<Float32Array | null> {
  const cached = profileVectors.get(profile);
  if (cached) {
    profileVectors.delete(profile);
    profileVectors.set(profile, cached);
    return cached;
  }
  const vector = await deps.embed(profile);
  if (!vector) return null;
  profileVectors.set(profile, vector);
  for (const stale of profileVectors.keys()) {
    if (profileVectors.size <= PROFILE_VECTOR_LIMIT) break;
    profileVectors.delete(stale);
  }
  return vector;
}

export async function scoreNeoHolders(
  text: string,
  projectal: readonly NeoHolder[],
  deps: NeoRouterDeps
): Promise<Score[]> {
  const message = projectal.length > 0 ? await deps.embed(text) : null;
  if (!message) return [];
  const scores: Score[] = [];
  for (const holder of projectal) {
    const profile = neoHolderProfile(holder, deps.recentAsks(holder.projectId, PROFILE_ASKS));
    const vector = await profileVector(profile, deps);
    if (vector) scores.push({ holder, similarity: cosineSimilarity(message, vector) ?? -1 });
  }
  return scores;
}

export function runnableNeoHolders(
  holders: readonly NeoHolder[],
  available: ReadonlyMap<string, boolean>
): NeoHolder[] {
  return holders.filter((holder) => available.get(holder.provider ?? 'anthropic') !== false);
}

function projectOf(route: NeoRoute): string {
  return route.projectId ?? 'main';
}

export function neoTurnLine(route: NeoRoute, titles: ReadonlyMap<string, string>): string {
  const project = projectOf(route);
  const ask = neoExcerpt(route.askSummary ?? route.ask, TURN_TEXT_CHARS);
  const answer = route.outcome ? neoExcerpt(route.outcome, TURN_TEXT_CHARS) : '(no reply yet)';
  return `[${titles.get(project) ?? project}] you: "${ask}" → ${answer}`;
}

export function neoRouteCandidates(
  holders: readonly NeoHolder[],
  scores: readonly Score[],
  recent: readonly NeoRoute[],
  latest: readonly NeoRoute[]
): NeoHolder[] {
  if (holders.length <= PROJECT_LIMIT) return [...holders];
  const keep = new Set(
    [...recent, ...latest.filter((route) => route.awaiting)].flatMap((route) =>
      route.projectId ? [route.projectId] : []
    )
  );
  for (const score of [...scores].sort((a, b) => b.similarity - a.similarity)) {
    if (keep.size >= PROJECT_LIMIT || score.similarity < CLASSIFY_FLOOR) break;
    keep.add(score.holder.projectId);
  }
  return holders.filter((holder) => keep.has(holder.projectId)).slice(0, PROJECT_LIMIT);
}

function requireRouteQuestion(
  candidates: readonly NeoHolder[],
  recent: readonly NeoRoute[]
): { value: NeoHolder[] } | Exit {
  return candidates.length > 0 || recent.length > 0
    ? { value: [...candidates] }
    : { reason: { choice: null } };
}

export function neoProjectOpenAsks(
  candidates: readonly NeoHolder[],
  deps: Pick<NeoRouterDeps, 'openAsks'>
): Map<string, string[]> {
  return new Map(
    candidates.map((holder) => [
      holder.projectId,
      (deps.openAsks?.(holder.projectId) ?? [])
        .slice(0, OPEN_ASKS)
        .map((ask) => neoExcerpt(ask, OPEN_ASK_CHARS)),
    ])
  );
}

export function renderNeoRouteContext(
  holders: readonly NeoHolder[],
  candidates: readonly NeoHolder[],
  recent: readonly NeoRoute[],
  latest: readonly NeoRoute[],
  withInbox: boolean,
  openAsks: ReadonlyMap<string, readonly string[]> = new Map()
): string {
  const titles = new Map(holders.map((holder) => [holder.projectId, holder.title]));
  const notes = (project: string) => {
    const route = latest.find((item) => projectOf(item) === project);
    if (!route) return [];
    return [
      `    last: ${neoTurnLine(route, titles)}`,
      ...(route.awaiting
        ? [`    WAITING ON YOU: "${neoExcerpt(route.awaiting, TURN_TEXT_CHARS)}"`]
        : []),
    ];
  };
  const asks = (project: string) => {
    const open = openAsks.get(project) ?? [];
    return open.length > 0 ? [`    open asks: ${open.map((ask) => `"${ask}"`).join('; ')}`] : [];
  };
  const projects = [
    '- main: Neo itself, the last resort for questions across projects or when you cannot tell',
    ...notes('main'),
    ...candidates.flatMap((holder) => [
      `- ${holder.projectId}: ${holder.title}${holder.summary ? ` (${neoExcerpt(holder.summary, PROJECT_SUMMARY_CHARS)})` : ''}`,
      ...asks(holder.projectId),
      ...notes(holder.projectId),
    ]),
    ...(withInbox ? [`- ${NEO_INBOX_ID}: ${NEO_INBOX_SUMMARY}`, ...notes(NEO_INBOX_ID)] : []),
  ];
  const turns = fitLines(
    recent
      .filter((route) => route.projectId !== null)
      .map((route) => `- ${neoTurnLine(route, titles)}`),
    TURNS_CHARS
  );
  return [
    'Projects:',
    ...projects,
    '',
    'Recent turns (newest first):',
    ...(turns.length > 0 ? turns : ['(none)']),
  ].join('\n');
}

function unanswered(verdict: NeoRouteVerdict): boolean {
  return verdict === null || verdict === 'timeout' || verdict === 'failed';
}

export async function askNeoRouteModel(
  text: string,
  candidates: readonly NeoHolder[],
  context: string,
  withInbox: boolean,
  deps: Pick<NeoRouterDeps, 'classify'>
): Promise<NeoRouteVerdict> {
  if (!deps.classify) return null;
  const options = [...candidates, ...(withInbox ? [INBOX_CHOICE] : [])];
  const first = await deps.classify(text, options, context);
  return unanswered(first) ? deps.classify(text, options, context) : first;
}

async function classifyNeoAsk(
  text: string,
  verdict: NeoRouteVerdict,
  scores: readonly Score[],
  deps: NeoRouterDeps
): Promise<Routed> {
  const decided = verdict && typeof verdict === 'object' && 'decision' in verdict ? verdict : null;
  const chosen = decided
    ? decided.decision
    : (verdict as Exclude<NeoRouteVerdict, NeoRouteDecision>);
  const unheld = decided?.basis === 'new_subject' || decided?.basis === 'matches_project';
  if (chosen === 'main' && unheld && deps.newProject) {
    const project = await deps.newProject(text);
    if (project)
      return {
        choice: {
          projectId: project.projectId,
          sessionId: project.sessionId,
          signal: classifierSignal(decided.basis),
          confidence: decided.confidence ?? CLASSIFIER_CONFIDENCE,
        },
      };
  }
  if (chosen === 'main') return { choice: null, fallback: classifierSignal(decided?.basis) };
  if (!chosen || chosen === 'timeout' || chosen === 'failed')
    return { choice: pickNeoHolder(scores), fallback: `classifier-${chosen ?? 'unanswered'}` };
  const holder = chosen.projectId === NEO_INBOX_ID ? await deps.inbox?.() : chosen;
  return {
    choice: holder
      ? {
          projectId: holder.projectId,
          sessionId: holder.sessionId,
          signal: classifierSignal(decided?.basis),
          confidence: decided?.confidence ?? CLASSIFIER_CONFIDENCE,
        }
      : null,
    fallback: holder ? undefined : 'inbox-unavailable',
  };
}

const runNeoRoute = (superpipe({})('neo-route') as PipelineAPI)
  .input(['text', 'deps'])
  .pipe(requireAskText, 'text', 'result:route')
  .pipe(
    async (deps: NeoRouterDeps) =>
      (await deps.holders()).filter((holder) => holder.projectId !== NEO_INBOX_ID),
    'deps',
    'holders'
  )
  .pipe((deps: NeoRouterDeps) => deps.recentTurns(), 'deps', 'recent')
  .pipe((deps: NeoRouterDeps) => deps.projectTurns(), 'deps', 'latest')
  .pipe(scoreNeoHolders, ['text', 'holders', 'deps'], 'scores')
  .pipe(neoRouteCandidates, ['holders', 'scores', 'recent', 'latest'], 'candidates')
  .pipe(requireRouteQuestion, ['candidates', 'recent'], 'result:route')
  .pipe(
    async (deps: NeoRouterDeps) => !!deps.inbox && (await deps.inboxRunnable?.()) !== false,
    'deps',
    'withInbox'
  )
  .pipe(neoProjectOpenAsks, ['candidates', 'deps'], 'openAsks')
  .pipe(
    renderNeoRouteContext,
    ['holders', 'candidates', 'recent', 'latest', 'withInbox', 'openAsks'],
    'context'
  )
  .pipe(askNeoRouteModel, ['text', 'candidates', 'context', 'withInbox', 'deps'], 'verdict')
  .pipe(classifyNeoAsk, ['text', 'verdict', 'scores', 'deps'], 'route')
  .endAsync('route') as (text: string, deps: NeoRouterDeps) => Promise<Routed>;

export function chooseNeoRoute(text: string, deps: NeoRouterDeps): Promise<NeoRouted> {
  return runNeoRoute(text, deps);
}

export type NeoRouter = (text: string, requestId?: string) => Promise<NeoRouted>;

export interface NeoHolderWake {
  asleep(sessionId: string): boolean;
  wake?(projectId: string): Promise<string | null>;
}

export function reopenNeoHolder(
  repo: Pick<NeoRepository, 'getBindingForProject' | 'retireArchivedBinding'>,
  db: Pick<Database, 'getSession'>,
  openHolder: (projectId: string) => Promise<string>,
  projectId: string
): Promise<string> {
  const binding = repo.getBindingForProject(projectId);
  if (binding && db.getSession(binding.sessionId)?.status === 'archived')
    repo.retireArchivedBinding(projectId, binding.sessionId);
  return openHolder(projectId);
}

export async function wakeNeoRoute(routed: NeoRouted, holders: NeoHolderWake): Promise<NeoRouted> {
  const choice = routed.choice;
  if (!choice || !holders.asleep(choice.sessionId)) return routed;
  const sessionId = holders.wake ? await holders.wake(choice.projectId) : null;
  return sessionId
    ? { ...routed, choice: { ...choice, sessionId } }
    : { choice: null, fallback: 'holder-unavailable' };
}

export function createNeoRouter(
  db: Database,
  repo: NeoRepository,
  openHolder?: (projectId: string) => Promise<string>
): NeoRouter {
  const log = new NeoRoutingLogRepository(db.getDatabase());
  const asks = new NeoAskRepository(db.getDatabase());
  const deps: NeoRouterDeps = {
    holders: async () => {
      if (openHolder) {
        for (const project of repo.listProjects()) {
          if (!repo.getBindingForProject(project.id)) await openHolder(project.id);
        }
      }
      const holders: NeoHolder[] = repo.listProjects().flatMap((project) => {
        const binding = repo.getBindingForProject(project.id);
        const session = binding ? db.getSession(binding.sessionId) : null;
        return binding?.kind === 'project'
          ? [
              {
                projectId: project.id,
                sessionId: binding.sessionId,
                title: project.title,
                summary: project.summary,
                ...(session?.config.provider ? { provider: session.config.provider } : {}),
              },
            ]
          : [];
      });
      if (process.env.NODE_ENV === 'test') return holders;
      const providers = [...new Set(holders.map((holder) => holder.provider ?? 'anthropic'))];
      const available = new Map(
        await Promise.all(
          providers.map(
            async (provider) =>
              [
                provider,
                await getProviderService()
                  .isProviderAvailable(provider)
                  .catch(() => false),
              ] as const
          )
        )
      );
      return runnableNeoHolders(holders, available);
    },
    recentTurns: () => log.recent(RECENT_TURNS),
    projectTurns: () => log.latestPerProject(),
    recentAsks: (projectId, limit) => log.recentAsks(projectId, limit),
    openAsks: (projectId) =>
      asks
        .list(projectId)
        .filter((ask) => !isNeoAskSettled(ask))
        .map((ask) => ask.title),
    embed: async (text) =>
      process.env.NODE_ENV === 'test' ? null : embedQueryOrNull(db.getEmbedder(), text),
    classify: (text, options, context) => {
      const neo = db.getGlobalSettings().neo;
      return classifyNeoRoute(
        text,
        options,
        context,
        neo?.routeModel,
        neoRouteTimeoutMs(neo?.routeTimeoutMs)
      );
    },
    inbox: openHolder
      ? async () => {
          repo.saveProject(
            { id: NEO_INBOX_ID, title: 'Inbox', summary: NEO_INBOX_SUMMARY, context: '' },
            0
          );
          const sessionId = await openHolder(NEO_INBOX_ID);
          return { ...INBOX_CHOICE, sessionId };
        }
      : undefined,
    newProject: openHolder
      ? (text, key) =>
          openNeoNewProject(repo, openHolder, neoNewProject(text, key ?? crypto.randomUUID()))
      : undefined,
    inboxRunnable: async () => {
      if (process.env.NODE_ENV === 'test') return true;
      const binding = repo.getBindingForProject(NEO_INBOX_ID) ?? repo.getBindingForProject(null);
      const provider =
        (binding ? db.getSession(binding.sessionId)?.config.provider : undefined) ?? 'anthropic';
      return getProviderService()
        .isProviderAvailable(provider)
        .catch(() => false);
    },
  };
  const holders: NeoHolderWake = {
    asleep: (sessionId) => {
      const session = db.getSession(sessionId);
      return !session || session.status === 'archived';
    },
    wake: openHolder
      ? async (projectId) => {
          try {
            return await reopenNeoHolder(repo, db, openHolder, projectId);
          } catch {
            return null;
          }
        }
      : undefined,
  };
  const newProject = deps.newProject;
  return async (text, requestId) =>
    wakeNeoRoute(
      await chooseNeoRoute(text, {
        ...deps,
        newProject: newProject && ((ask) => newProject(ask, requestId)),
      }),
      holders
    );
}
