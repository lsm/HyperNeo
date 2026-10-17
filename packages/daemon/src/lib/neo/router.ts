import {
  readNeoNamedProjectFacts,
  selectNeoNamedRouteFacts,
  type NeoNamedProject,
} from './named-route-facts.ts';
import { readNeoNamedRepositoryFacts } from './packs/coding/route-repository.ts';
import { neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import { readNeoSectionFacts } from './section-route-facts.ts';
import { neoFactOwners, readNeoProjectFacts, type NeoProjectFact } from './project-route-facts.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import {
  type NeoRoute,
  NeoRoutingLogRepository,
  neoExcerpt,
} from '../../storage/repositories/neo-routing-log-repository.ts';
import { getProviderService } from '../provider-service.ts';
import { effectiveNeoPreference } from './model-preference.ts';
import { classifyNeoRoute, neoRouteTimeoutMs } from './route-classifier.ts';
import { cosineSimilarity, embedQueryOrNull } from '../../storage/vector-similarity.ts';
import { fitLines } from './fit-lines.ts';

const MIN_SIMILARITY = 0.55;
const MIN_MARGIN = 0.05;
const PROFILE_ASKS = 8;
const PROFILE_ASK_CHARS = 300;
const RECENT_TURNS = 20;
const TURNS_CHARS = 3_000;
const TURN_TEXT_CHARS = 300;
const PROJECT_SUMMARY_CHARS = 160;
const PROFILE_VECTOR_LIMIT = 256;
export const NEO_INBOX_ID = 'inbox';
export const NEO_INBOX_SUMMARY =
  'Self-contained one-off questions that need no continuing project.';
const INBOX_CHOICE: NeoHolder = {
  projectId: NEO_INBOX_ID,
  sessionId: '',
  title: 'Inbox',
  summary: NEO_INBOX_SUMMARY,
};

export function neoDefaultSessionId(
  repo: Pick<NeoRepository, 'getBindingForProject'>
): string | undefined {
  return repo.getBindingForProject(NEO_INBOX_ID)?.sessionId;
}

export function openNeoDefaultSession(
  repo: Pick<NeoRepository, 'saveProject'>,
  open: (projectId: string) => Promise<string>
): Promise<string> {
  repo.saveProject(
    { id: NEO_INBOX_ID, title: 'Inbox', summary: NEO_INBOX_SUMMARY, context: '' },
    0
  );
  return open(NEO_INBOX_ID);
}

const NEW_PROJECT_TITLE_CHARS = 60;

export function neoNewProject(
  target: string,
  id: string
): { id: string; title: string; summary: string } {
  const line = target.trim().replace(/\s+/g, ' ');
  return {
    id,
    title:
      line.length <= NEW_PROJECT_TITLE_CHARS
        ? line
        : `${line.slice(0, NEW_PROJECT_TITLE_CHARS - 1).trimEnd()}…`,
    summary: neoExcerpt(target.trim(), PROJECT_SUMMARY_CHARS),
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
  parentId?: string | null;
  ancestorIds?: readonly string[];
  projectId: string;
  sessionId: string;
  title: string;
  summary: string;
  repository?: string;
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
  projectTitle?: string;
}
export interface NeoRouteMiss {
  miss: 'timeout' | 'failed' | 'unanswered';
  cause: string;
}
export type NeoRouteVerdict = NeoRouteAnswer | NeoRouteDecision | NeoRouteMiss;
const CLASSIFIER_CONFIDENCE = 0.6;
export type NeoRouteSignal =
  | 'facts'
  | 'embedding'
  | 'classifier'
  | `classifier:${NeoRouteBasis}`
  | 'default';

function classifierSignal(basis: NeoRouteBasis | null | undefined): NeoRouteSignal {
  return basis ? `classifier:${basis}` : 'classifier';
}

export interface NeoRouterDeps {
  facts?(text: string): readonly NeoProjectFact[] | Promise<readonly NeoProjectFact[]>;
  holders(): NeoHolder[] | Promise<NeoHolder[]>;
  recentTurns(): NeoRoute[];
  projectTurns(): NeoRoute[];
  recentAsks(projectId: string, limit: number): string[];
  embed(text: string): Promise<Float32Array | null>;
  classify?(text: string, options: readonly NeoHolder[], context: string): Promise<NeoRouteVerdict>;
  inbox?(): Promise<NeoHolder | null>;
  inboxRunnable?(): Promise<boolean>;
}

function readNamedRouteFacts(text: string, projects: readonly NeoNamedProject[]): NeoProjectFact[] {
  return selectNeoNamedRouteFacts([
    ...readNeoNamedProjectFacts(text, projects),
    ...readNeoNamedRepositoryFacts(text, projects),
  ]);
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
export type NeoRouted = { choice: NeoRouteChoice | null; fallback?: string; cause?: string };
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
  const runnable = holders.filter(
    (holder) => available.get(holder.provider ?? 'anthropic') !== false
  );
  const ids = new Set(runnable.map((holder) => holder.projectId));
  const tree = holders.map((holder) => ({ ...holder, id: holder.projectId }));
  return runnable.map((holder) => {
    if (!holder.parentId) return holder;
    const ancestorIds = neoProjectPath(tree, holder.projectId)
      .slice(0, -1)
      .map((node) => node.id);
    return {
      ...holder,
      ancestorIds,
      parentId: [...ancestorIds].reverse().find((id) => ids.has(id)) ?? null,
    };
  });
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

function requireRouteQuestion(
  candidates: readonly NeoHolder[],
  recent: readonly NeoRoute[]
): { value: NeoHolder[] } | Exit {
  return candidates.length > 0 || recent.length > 0
    ? { value: [...candidates] }
    : { reason: { choice: null } };
}

export function renderNeoRouteContext(
  holders: readonly NeoHolder[],
  recent: readonly NeoRoute[],
  latest: readonly NeoRoute[],
  withInbox: boolean
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
  const waiting = (project: string) => {
    const awaiting = latest.find((item) => projectOf(item) === project)?.awaiting;
    return awaiting ? [`    WAITING ON YOU: "${neoExcerpt(awaiting, TURN_TEXT_CHARS)}"`] : [];
  };
  const projects = [
    '- main: Neo itself, the last resort for questions across projects or when you cannot tell',
    ...notes('main'),
    ...holders.flatMap((holder) => [
      `- ${holder.projectId}: ${holder.title}${holder.repository ? ` [${holder.repository}]` : ''}${holder.summary ? ` (${neoExcerpt(holder.summary, PROJECT_SUMMARY_CHARS)})` : ''}`,
      ...waiting(holder.projectId),
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
  return verdict === null || (typeof verdict === 'object' && 'miss' in verdict);
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
  deps: NeoRouterDeps,
  holders: readonly NeoHolder[],
  withInbox: boolean
): Promise<Routed> {
  const decided = verdict && typeof verdict === 'object' && 'decision' in verdict ? verdict : null;
  const missed = verdict && typeof verdict === 'object' && 'miss' in verdict ? verdict : null;
  const chosen = decided ? decided.decision : missed ? null : (verdict as NeoRouteAnswer);
  const unheld = decided?.basis === 'new_subject' || decided?.basis === 'matches_project';
  if (chosen === 'main' && !unheld)
    return { choice: null, fallback: classifierSignal(decided?.basis) };
  if (!chosen)
    return {
      choice: pickNeoHolder(scores),
      fallback: `classifier-${missed?.miss ?? 'unanswered'}`,
      ...(missed ? { cause: missed.cause } : {}),
    };
  const title = decided?.projectTitle?.trim().toLowerCase();
  const titled = holders.filter((holder) => holder.title.trim().toLowerCase() === title);
  const target = chosen !== 'main' ? chosen : titled.length === 1 ? titled[0] : INBOX_CHOICE;
  const holder =
    target.projectId !== NEO_INBOX_ID
      ? target
      : withInbox
        ? await deps.inbox?.().catch(() => null)
        : null;
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

export function requireNeoFactRoute(
  facts: readonly NeoProjectFact[],
  holders: readonly NeoHolder[]
): { value: null } | Exit {
  if (!facts.length) return { value: null };
  const owners = neoFactOwners(facts);
  if (!owners) return { reason: { choice: null, fallback: 'facts:unresolved' } };
  if (owners.length > 1) return { reason: { choice: null, fallback: 'facts:cross_project' } };
  const holder = holders.find((holder) => holder.projectId === owners[0]);
  return {
    reason: holder
      ? {
          choice: {
            projectId: holder.projectId,
            sessionId: holder.sessionId,
            signal: 'facts',
            confidence: 1,
          },
        }
      : { choice: null, fallback: 'facts:root' },
  };
}

const runNeoRoute = (superpipe({})('neo-route') as PipelineAPI)
  .input(['text', 'deps'])
  .pipe(requireAskText, 'text', 'result:route')
  .pipe(
    async (text: string, deps: NeoRouterDeps) => (deps.facts ? await deps.facts(text) : []),
    ['text', 'deps'],
    'facts'
  )
  .pipe(
    async (deps: NeoRouterDeps) =>
      (await deps.holders()).filter((holder) => holder.projectId !== NEO_INBOX_ID),
    'deps',
    'holders'
  )
  .pipe(requireNeoFactRoute, ['facts', 'holders'], 'result:route')
  .pipe((deps: NeoRouterDeps) => deps.recentTurns(), 'deps', 'recent')
  .pipe((deps: NeoRouterDeps) => deps.projectTurns(), 'deps', 'latest')
  .pipe(scoreNeoHolders, ['text', 'holders', 'deps'], 'scores')
  .pipe(requireRouteQuestion, ['holders', 'recent'], 'result:route')
  .pipe(
    async (deps: NeoRouterDeps) => !!deps.inbox && (await deps.inboxRunnable?.()) !== false,
    'deps',
    'withInbox'
  )
  .pipe(renderNeoRouteContext, ['holders', 'recent', 'latest', 'withInbox'], 'context')
  .pipe(askNeoRouteModel, ['text', 'holders', 'context', 'withInbox', 'deps'], 'verdict')
  .pipe(classifyNeoAsk, ['text', 'verdict', 'scores', 'deps', 'holders', 'withInbox'], 'route')
  .endAsync('route') as (text: string, deps: NeoRouterDeps) => Promise<Routed>;

export function neoRouteLevel(holders: readonly NeoHolder[], parentId: string | null): NeoHolder[] {
  return holders.filter(
    (holder) => (holder.parentId ?? null) === parentId || holder.projectId === parentId
  );
}

export function neoLevelFactOwner(
  holders: readonly NeoHolder[],
  owner: string,
  parentId: string | null
): string | null {
  const path = neoProjectPath(
    holders.map((holder) => ({ ...holder, id: holder.projectId })),
    owner
  );
  if (parentId === owner) return owner;
  const index = parentId === null ? -1 : path.findIndex((holder) => holder.id === parentId);
  if (parentId !== null && index < 0) return null;
  return path[index + 1]?.id ?? null;
}

export function neoLevelTurns(
  turns: readonly NeoRoute[],
  holders: readonly NeoHolder[],
  parentId: string | null
): NeoRoute[] {
  return turns.flatMap((turn) => {
    if (!turn.projectId) return parentId === null ? [turn] : [];
    const projectId = neoLevelFactOwner(holders, turn.projectId, parentId);
    return projectId ? [{ ...turn, projectId }] : parentId === null ? [turn] : [];
  });
}

function neoUnavailableWorkspaceHolders(
  facts: readonly NeoProjectFact[],
  holders: readonly NeoHolder[]
): NeoHolder[] | null {
  const owners = neoFactOwners(facts);
  if (!owners || owners.length !== 1 || !owners[0] || facts.some((fact) => !fact.projectOnly))
    return null;
  const descendants = holders.filter((holder) => holder.ancestorIds?.includes(owners[0]!));
  const ids = new Set(descendants.map((holder) => holder.projectId));
  return descendants.length
    ? descendants.map((holder) => ({
        ...holder,
        parentId: holder.parentId && ids.has(holder.parentId) ? holder.parentId : null,
      }))
    : null;
}

export async function chooseNeoRoute(text: string, deps: NeoRouterDeps): Promise<NeoRouted> {
  if (!text.trim()) return { choice: null };
  let holders = await deps.holders();
  const recorded = (await deps.facts?.(text)) ?? [];
  const facts = recorded.length ? recorded : readNamedRouteFacts(text, holders);
  let chosen: NeoRouted = { choice: null };
  let scopedWorkspace = false;
  if (facts.length) {
    const gate = requireNeoFactRoute(facts, holders);
    if ('reason' in gate) {
      if (gate.reason.choice) {
        if (facts.some((fact) => !fact.projectOnly)) return gate.reason;
        chosen = gate.reason;
      } else {
        const descendants = neoUnavailableWorkspaceHolders(facts, holders);
        if (!descendants) return gate.reason;
        holders = descendants;
        scopedWorkspace = true;
      }
    }
  }
  const visited = new Set<string>();
  while (true) {
    const parentId = chosen.choice?.projectId ?? null;
    const level = neoRouteLevel(holders, parentId);
    if (parentId && !level.some((holder) => holder.projectId !== parentId)) return chosen;
    const next = await runNeoRoute(text, {
      ...deps,
      holders: () => level,
      facts: () => [],
      recentTurns: () => neoLevelTurns(deps.recentTurns(), holders, parentId),
      projectTurns: () => neoLevelTurns(deps.projectTurns(), holders, parentId),
      ...(parentId || scopedWorkspace ? { inbox: undefined } : {}),
    });
    if (!next.choice) return parentId ? chosen : next;
    if (next.choice.projectId === parentId) return next;
    if (visited.has(next.choice.projectId))
      return { choice: null, fallback: 'invalid-project-tree' };
    visited.add(next.choice.projectId);
    chosen = next;
    if (!holders.some((holder) => holder.projectId === next.choice!.projectId)) return chosen;
  }
}

export type NeoRouter = (text: string) => Promise<NeoRouted>;

export async function routeNeoDefault(
  routed: NeoRouted,
  inbox: NeoRouterDeps['inbox']
): Promise<NeoRouted> {
  const holder = routed.choice || !inbox ? null : await inbox().catch(() => null);
  return holder
    ? {
        ...routed,
        choice: {
          projectId: holder.projectId,
          sessionId: holder.sessionId,
          signal: 'default',
          confidence: 1,
        },
      }
    : routed;
}

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

function neoRedirectTurns(turns: readonly NeoRoute[], repo: NeoRepository): NeoRoute[] {
  return turns.map((turn) =>
    turn.projectId
      ? { ...turn, projectId: repo.projectMerges.resolve(turn.projectId) ?? turn.projectId }
      : turn
  );
}

export function neoProjectHolders(
  projects: readonly {
    project: { id: string; parentId?: string | null; title: string; summary: string };
    binding: { sessionId: string; kind: string } | null;
    provider?: string;
    repository?: string;
  }[],
  opening: string | undefined
): NeoHolder[] {
  return projects.flatMap(({ project, binding, provider, repository }) => {
    if (binding && binding.kind !== 'project') return [];
    const runs = binding ? provider : opening;
    return [
      {
        projectId: project.id,
        parentId: project.parentId,
        sessionId: binding?.sessionId ?? '',
        title: project.title,
        summary: project.summary,
        ...(repository ? { repository } : {}),
        ...(runs ? { provider: runs } : {}),
      },
    ];
  });
}

export function createNeoRouter(
  db: Database,
  repo: NeoRepository,
  openHolder?: (projectId: string) => Promise<string>,
  refreshFacts?: (text: string) => Promise<void>
): NeoRouter {
  const log = new NeoRoutingLogRepository(db.getDatabase());
  const deps: NeoRouterDeps = {
    facts: async (text) => {
      const projects = repo.listProjects();
      const repositories = repo.repositories();
      const named = projects.map((project) => ({
        projectId: project.id,
        title: project.title,
        repository: repositories.get(project.id),
      }));
      const recorded = readNeoProjectFacts(db.getDatabase(), text);
      const facts = recorded.length ? recorded : readNamedRouteFacts(text, named);
      if (facts.some((fact) => fact.projectId === undefined) && refreshFacts) {
        await refreshFacts(text);
        return readNeoSectionFacts(
          text,
          readNeoProjectFacts(db.getDatabase(), text),
          repo.listProjects()
        );
      }
      return readNeoSectionFacts(text, facts, projects);
    },
    holders: async () => {
      const fallback = neoDefaultSessionId(repo);
      const settings = db.getGlobalSettings();
      const opening = effectiveNeoPreference(
        settings.neo?.preferences,
        fallback ? (db.getSession(fallback)?.config ?? null) : null
      )?.provider;
      const repositories = repo.repositories();
      const holders = neoProjectHolders(
        repo.listProjects().map((project) => {
          const binding = repo.getBindingForProject(project.id);
          return {
            project,
            binding,
            provider: binding ? db.getSession(binding.sessionId)?.config.provider : undefined,
            repository: repositories.get(project.id),
          };
        }),
        opening
      );
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
    recentTurns: () => neoRedirectTurns(log.recent(RECENT_TURNS), repo),
    projectTurns: () => neoRedirectTurns(log.latestPerProject(), repo),
    recentAsks: (projectId, limit) => log.recentAsks(projectId, limit),
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
      ? async () => ({
          ...INBOX_CHOICE,
          sessionId: await openNeoDefaultSession(repo, openHolder),
        })
      : undefined,
    inboxRunnable: async () => {
      if (process.env.NODE_ENV === 'test') return true;
      const session = neoDefaultSessionId(repo);
      const provider =
        (session ? db.getSession(session)?.config.provider : undefined) ?? 'anthropic';
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
  return async (text) =>
    wakeNeoRoute(await routeNeoDefault(await chooseNeoRoute(text, deps), deps.inbox), holders);
}
