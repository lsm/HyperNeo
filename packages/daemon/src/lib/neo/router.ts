import type { Database } from '../../storage/database.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import {
  type NeoRoute,
  NeoRoutingLogRepository,
} from '../../storage/repositories/neo-routing-log-repository.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { classifyNeoRoute } from './route-classifier.ts';

const STICKY_MS = 5 * 60_000;
const STICKY_CHARS = 120;
const MIN_SIMILARITY = 0.55;
const MIN_MARGIN = 0.05;
const PROFILE_ASKS = 8;
const CLASSIFY_FLOOR = 0.35;
const CLASSIFY_CANDIDATES = 4;

export interface NeoHolder {
  concernId: string;
  sessionId: string;
  title: string;
  summary: string;
}

export interface NeoRouteChoice {
  concernId: string;
  sessionId: string;
  signal: 'sticky' | 'embedding' | 'classifier';
  confidence: number;
}

export interface NeoRouterDeps {
  holders(): NeoHolder[];
  latestRoute(): NeoRoute | null;
  recentAsks(concernId: string, limit: number): string[];
  embed(text: string): Promise<Float32Array | null>;
  classify?(text: string, candidates: readonly NeoHolder[]): Promise<NeoHolder | null>;
  now(): number;
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

export function stickyNeoRoute(
  text: string,
  holders: readonly NeoHolder[],
  latest: NeoRoute | null,
  now: number
): NeoRouteChoice | null {
  if (!latest || latest.destination !== 'holder' || !latest.concernId) return null;
  if (now - latest.askedAt > STICKY_MS || text.trim().length > STICKY_CHARS) return null;
  const holder = holders.find((item) => item.concernId === latest.concernId);
  return holder
    ? {
        concernId: holder.concernId,
        sessionId: holder.sessionId,
        signal: 'sticky',
        confidence: 0.9,
      }
    : null;
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

export function stickyExit(
  text: string,
  holders: readonly NeoHolder[],
  latest: NeoRoute | null,
  now: number
): { value: NeoHolder[] } | Exit {
  const sticky = stickyNeoRoute(text, holders, latest, now);
  return sticky ? { reason: { choice: sticky } } : { value: [...holders] };
}

export function neoHolderProfile(holder: NeoHolder, asks: readonly string[]): string {
  return [holder.title, holder.summary, ...asks].filter(Boolean).join('\n');
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

export function embeddingExit(scores: readonly Score[]): { value: Score[] } | Exit {
  const picked = pickNeoHolder(scores);
  return picked ? { reason: { choice: picked } } : { value: [...scores] };
}

export function classifierCandidates(scores: readonly Score[]): NeoHolder[] {
  return scores
    .filter((score) => score.similarity >= CLASSIFY_FLOOR)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, CLASSIFY_CANDIDATES)
    .map((score) => score.holder);
}

export async function classifyNeoAsk(
  text: string,
  candidates: readonly NeoHolder[],
  deps: NeoRouterDeps
): Promise<Routed> {
  if (!deps.classify || candidates.length === 0) return { choice: null };
  const chosen = await deps.classify(text, candidates);
  return {
    choice: chosen
      ? {
          concernId: chosen.concernId,
          sessionId: chosen.sessionId,
          signal: 'classifier',
          confidence: 0.6,
        }
      : null,
  };
}

const runNeoRoute = (superpipe({})('neo-route') as PipelineAPI)
  .input(['text', 'deps'])
  .pipe(requireAskText, 'text', 'result:route')
  .pipe((deps: NeoRouterDeps) => deps.holders(), 'deps', 'holders')
  .pipe((deps: NeoRouterDeps) => deps.latestRoute(), 'deps', 'latest')
  .pipe((deps: NeoRouterDeps) => deps.now(), 'deps', 'now')
  .pipe(stickyExit, ['route', 'holders', 'latest', 'now'], 'result:route')
  .pipe(scoreNeoHolders, ['text', 'route', 'deps'], 'scores')
  .pipe(embeddingExit, 'scores', 'result:route')
  .pipe(classifierCandidates, 'route', 'candidates')
  .pipe(classifyNeoAsk, ['text', 'candidates', 'deps'], 'route')
  .endAsync('route') as (text: string, deps: NeoRouterDeps) => Promise<Routed>;

export async function chooseNeoRoute(
  text: string,
  deps: NeoRouterDeps
): Promise<NeoRouteChoice | null> {
  return (await runNeoRoute(text, deps)).choice;
}

export type NeoRouter = (text: string) => Promise<NeoRouteChoice | null>;

export function createNeoRouter(db: Database, repo: NeoRepository): NeoRouter {
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
    latestRoute: () => log.latest(),
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
    now: () => Date.now(),
  };
  return (text) => chooseNeoRoute(text, deps);
}
