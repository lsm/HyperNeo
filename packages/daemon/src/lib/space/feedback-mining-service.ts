import type {
  CaptureFeedbackParams,
  EvidenceKind,
  EvidenceRef,
  FeedbackCluster,
  FeedbackItem,
  FeedbackSentiment,
  FeedbackSource,
  FeedbackTheme,
  FeedbackUrgency,
} from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';

export interface FeedbackMiningServiceDeps {
  evolutionRepo: EvolutionRepository;
}

const DEFAULT_SENTIMENT: FeedbackSentiment = 'neutral';
const DEFAULT_URGENCY: FeedbackUrgency = 'medium';

const SOURCE_TO_EVIDENCE_KIND: Record<FeedbackSource, EvidenceKind> = {
  github_issue: 'github_issue',
  github_discussion: 'community_discussion',
  social_post: 'social_post',
  community_discussion: 'community_discussion',
  livestream_chat: 'livestream_chat',
  dogfood_reaction: 'dogfood_reaction',
  human_provided: 'public_feedback',
};

export class FeedbackMiningService {
  constructor(private deps: FeedbackMiningServiceDeps) {}

  captureFeedback(params: CaptureFeedbackParams): FeedbackItem {
    const now = Date.now();
    const themes = params.themes ?? ['unclear'];
    const sentiment = params.sentiment ?? DEFAULT_SENTIMENT;
    const urgency = params.urgency ?? DEFAULT_URGENCY;

    const kind = SOURCE_TO_EVIDENCE_KIND[params.source];
    const evidence = this.deps.evolutionRepo.createEvidence({
      scopeId: params.scopeId,
      kind,
      sourceId: params.url ?? null,
      summary: buildFeedbackSummary(params),
      metadata: {
        source: params.source,
        url: params.url ?? null,
        author: params.author ?? null,
        postedAt: params.postedAt ?? null,
        rawContent: params.content,
        themes,
        sentiment,
        urgency,
        ...params.metadata,
      },
      createdAt: now,
    });

    return evidenceRefToFeedbackItem(evidence);
  }

  clusterFeedback(scopeId: string): FeedbackCluster[] {
    const evidence = this.deps.evolutionRepo.listEvidence(scopeId);
    const feedbackItems = evidence
      .filter((e) => isFeedbackEvidenceKind(e.kind))
      .map(evidenceRefToFeedbackItem);

    const byTheme = new Map<FeedbackTheme, FeedbackItem[]>();
    for (const item of feedbackItems) {
      for (const theme of item.themes) {
        const group = byTheme.get(theme) ?? [];
        group.push(item);
        byTheme.set(theme, group);
      }
    }

    return Array.from(byTheme.entries()).map(([theme, items]) => {
      const sentiments = items.map((i) => i.sentiment);
      const dominantSentiment = dominantValue(sentiments, DEFAULT_SENTIMENT);
      const urgencies = items.map((i) => i.urgency);
      const dominantUrgency = dominantValue(urgencies, DEFAULT_URGENCY);

      return {
        theme,
        items: items.map((i) => i.evidenceId ?? i.id),
        summary: `${theme}: ${items.length} feedback item${items.length === 1 ? '' : 's'}`,
        sentiment: dominantSentiment,
        urgency: dominantUrgency,
        count: items.length,
      };
    });
  }
}

function buildFeedbackSummary(params: CaptureFeedbackParams): string {
  const parts: string[] = [];
  parts.push(`[${params.source}]`);
  if (params.author) parts.push(`${params.author}:`);
  const contentPreview =
    params.content.length > 200 ? `${params.content.slice(0, 200)}...` : params.content;
  parts.push(contentPreview);
  return parts.join(' ');
}

function evidenceRefToFeedbackItem(evidence: EvidenceRef): FeedbackItem {
  const m = evidence.metadata;
  return {
    id: generateUUID(),
    scopeId: evidence.scopeId,
    source: (m.source as FeedbackSource) ?? 'human_provided',
    url: (m.url as string | null) ?? null,
    content: (m.rawContent as string) ?? evidence.summary,
    author: (m.author as string | null) ?? null,
    postedAt: (m.postedAt as number | null) ?? null,
    themes: Array.isArray(m.themes) ? (m.themes as FeedbackTheme[]) : ['unclear'],
    sentiment: (m.sentiment as FeedbackSentiment) ?? DEFAULT_SENTIMENT,
    urgency: (m.urgency as FeedbackUrgency) ?? DEFAULT_URGENCY,
    metadata: m,
    evidenceId: evidence.id,
    createdAt: evidence.createdAt,
  };
}

function isFeedbackEvidenceKind(kind: string): boolean {
  return (
    kind === 'public_feedback' ||
    kind === 'social_post' ||
    kind === 'github_issue' ||
    kind === 'community_discussion' ||
    kind === 'livestream_chat' ||
    kind === 'dogfood_reaction'
  );
}

function dominantValue<T>(values: T[], fallback: T): T {
  if (values.length === 0) return fallback;
  const counts = new Map<T, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let max = fallback;
  let maxCount = -1;
  for (const [value, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      max = value;
    }
  }
  return max;
}
