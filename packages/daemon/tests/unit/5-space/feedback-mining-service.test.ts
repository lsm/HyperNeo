import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { FeedbackMiningService } from '../../../src/lib/space/feedback-mining-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('FeedbackMiningService', () => {
  let db: Database;
  let spaceRepo: SpaceRepository;
  let evolutionRepo: EvolutionRepository;
  let service: FeedbackMiningService;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    spaceRepo = new SpaceRepository(db as never);
    evolutionRepo = new EvolutionRepository(db as never);
    service = new FeedbackMiningService({ evolutionRepo });
    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/feedback-mining',
      slug: 'feedback-mining',
      name: 'Feedback Mining',
    }).id;
  });

  it('captures a GitHub issue as feedback evidence', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Public feedback',
      objective: 'Collect public feedback',
    });

    const item = service.captureFeedback({
      scopeId: scope.id,
      source: 'github_issue',
      url: 'https://github.com/neokai/neokai/issues/42',
      content: 'Dark mode toggle is missing in settings panel',
      author: 'user123',
      postedAt: 1_700_000_000_000,
      themes: ['ux_gap', 'feature_request'],
      sentiment: 'negative',
      urgency: 'medium',
    });

    expect(item.scopeId).toBe(scope.id);
    expect(item.source).toBe('github_issue');
    expect(item.url).toBe('https://github.com/neokai/neokai/issues/42');
    expect(item.author).toBe('user123');
    expect(item.themes).toEqual(['ux_gap', 'feature_request']);
    expect(item.sentiment).toBe('negative');
    expect(item.urgency).toBe('medium');
    expect(item.evidenceId).toBeTruthy();

    const evidence = evolutionRepo.getEvidence(item.evidenceId!);
    expect(evidence).not.toBeNull();
    expect(evidence!.kind).toBe('github_issue');
    expect(evidence!.summary).toContain('Dark mode toggle');
    expect(evidence!.metadata.source).toBe('github_issue');
    expect(evidence!.metadata.themes).toEqual(['ux_gap', 'feature_request']);
  });

  it('captures a social post with defaults', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Social feedback',
      objective: 'Track social mentions',
    });

    const item = service.captureFeedback({
      scopeId: scope.id,
      source: 'social_post',
      url: 'https://x.com/user/status/123',
      content: 'NeoKai looks promising but I cannot figure out how to switch models',
    });

    expect(item.sentiment).toBe('neutral');
    expect(item.urgency).toBe('medium');
    expect(item.themes).toEqual(['unclear']);
    expect(item.author).toBeNull();
    expect(evolutionRepo.getEvidence(item.evidenceId!)!.kind).toBe('social_post');
  });

  it('captures dogfood reaction with high urgency', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Dogfood',
      objective: 'Internal feedback',
    });

    const item = service.captureFeedback({
      scopeId: scope.id,
      source: 'dogfood_reaction',
      content: 'Crash on startup when DB path contains spaces',
      themes: ['bug', 'reliability'],
      sentiment: 'negative',
      urgency: 'high',
    });

    expect(item.source).toBe('dogfood_reaction');
    expect(item.themes).toEqual(['bug', 'reliability']);
    expect(item.sentiment).toBe('negative');
    expect(item.urgency).toBe('high');
    expect(evolutionRepo.getEvidence(item.evidenceId!)!.kind).toBe('dogfood_reaction');
  });

  it('clusters feedback by theme', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Cluster test',
      objective: 'Test clustering',
    });

    service.captureFeedback({
      scopeId: scope.id,
      source: 'github_issue',
      content: 'Bug: login fails with OAuth',
      themes: ['bug', 'reliability'],
      sentiment: 'negative',
      urgency: 'high',
    });

    service.captureFeedback({
      scopeId: scope.id,
      source: 'social_post',
      content: 'UI is confusing on mobile',
      themes: ['ux_gap'],
      sentiment: 'negative',
      urgency: 'medium',
    });

    service.captureFeedback({
      scopeId: scope.id,
      source: 'community_discussion',
      content: 'Another OAuth bug report',
      themes: ['bug', 'reliability'],
      sentiment: 'negative',
      urgency: 'high',
    });

    const clusters = service.clusterFeedback(scope.id);

    const bugCluster = clusters.find((c) => c.theme === 'bug');
    expect(bugCluster).toBeDefined();
    expect(bugCluster!.count).toBe(2);
    expect(bugCluster!.sentiment).toBe('negative');
    expect(bugCluster!.urgency).toBe('high');

    const uxCluster = clusters.find((c) => c.theme === 'ux_gap');
    expect(uxCluster).toBeDefined();
    expect(uxCluster!.count).toBe(1);
    expect(uxCluster!.sentiment).toBe('negative');
    expect(uxCluster!.urgency).toBe('medium');

    const reliabilityCluster = clusters.find((c) => c.theme === 'reliability');
    expect(reliabilityCluster).toBeDefined();
    expect(reliabilityCluster!.count).toBe(2);
  });

  it('preserves raw content when summary is truncated', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Long content',
      objective: 'Test truncation round-trip',
    });

    const longContent = 'a'.repeat(300);

    const item = service.captureFeedback({
      scopeId: scope.id,
      source: 'github_issue',
      url: 'https://github.com/neokai/neokai/issues/99',
      content: longContent,
      themes: ['bug'],
    });

    expect(item.content).toBe(longContent);
    expect(item.content.length).toBe(300);

    const evidence = evolutionRepo.getEvidence(item.evidenceId!);
    expect(evidence!.summary.endsWith('...')).toBe(true);
    expect(evidence!.summary.length).toBeLessThan(longContent.length);
    expect(evidence!.metadata.rawContent).toBe(longContent);

    const clusters = service.clusterFeedback(scope.id);
    const clusterItem = clusters.find((c) => c.theme === 'bug');
    expect(clusterItem).toBeDefined();
  });

  it('normalizes empty themes to unclear', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Empty themes',
      objective: 'Test empty theme normalization',
    });

    const item = service.captureFeedback({
      scopeId: scope.id,
      source: 'social_post',
      content: 'Some vague complaint',
      themes: [],
    });

    expect(item.themes).toEqual(['unclear']);

    const clusters = service.clusterFeedback(scope.id);
    const unclearCluster = clusters.find((c) => c.theme === 'unclear');
    expect(unclearCluster).toBeDefined();
    expect(unclearCluster!.count).toBe(1);
  });

  it('does not let metadata override canonical fields', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Metadata override',
      objective: 'Test canonical field authority',
    });

    const item = service.captureFeedback({
      scopeId: scope.id,
      source: 'github_issue',
      content: 'Bug report',
      themes: ['bug'],
      sentiment: 'negative',
      urgency: 'high',
      metadata: {
        source: 'social_post',
        themes: ['ux_gap'],
        sentiment: 'positive',
        urgency: 'low',
      },
    });

    expect(item.source).toBe('github_issue');
    expect(item.themes).toEqual(['bug']);
    expect(item.sentiment).toBe('negative');
    expect(item.urgency).toBe('high');

    const evidence = evolutionRepo.getEvidence(item.evidenceId!);
    expect(evidence!.metadata.source).toBe('github_issue');
    expect(evidence!.metadata.themes).toEqual(['bug']);
    expect(evidence!.metadata.sentiment).toBe('negative');
    expect(evidence!.metadata.urgency).toBe('high');
  });

  it('ignores non-feedback evidence when clustering', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Mixed',
      objective: 'Mixed evidence',
    });

    service.captureFeedback({
      scopeId: scope.id,
      source: 'human_provided',
      content: 'Feedback item',
      themes: ['feature_request'],
    });

    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'A manual note',
      metadata: {},
    });

    const clusters = service.clusterFeedback(scope.id);
    expect(clusters.length).toBe(1);
    expect(clusters[0].theme).toBe('feature_request');
  });
});
