import { describe, expect, test } from 'bun:test';
import { scoreEvolutionEvidenceQuality } from '../src/evolution-preflight.ts';
import type { EvidenceKind, EvidenceRef } from '../src/types/evolution.ts';

describe('scoreEvolutionEvidenceQuality', () => {
  for (const kind of ['daemon_error', 'runtime_crash', 'runtime_warning', 'uncaught_exception']) {
    test(`scores ${kind} evidence as workflow artifact and error outcome`, () => {
      const result = scoreEvolutionEvidenceQuality({
        evidence: [createEvidence(kind as EvidenceKind)],
      });

      expect(result.counts.workflowArtifacts).toBe(1);
      expect(result.counts.outcomes).toBe(1);
      expect(result.reasons).toContain(
        'Evidence mentions concrete outcomes such as PR, QA, CI, merge, error, or completion.'
      );
      expect(result.warnings).not.toContain(
        'No concrete PR, QA, CI, merge, error, or task-completion outcome found.'
      );
    });
  }

  describe('artifactDiagnostics', () => {
    test('status is selected when selected evidence includes workflow artifacts', () => {
      const result = scoreEvolutionEvidenceQuality({
        evidence: [createEvidence('workflow_run', 'evidence-1')],
        availableScopeEvidence: [createEvidence('workflow_run', 'evidence-1')],
      });
      expect(result.artifactDiagnostics.status).toBe('selected');
      expect(result.artifactDiagnostics.recommendations).toEqual([]);
      expect(result.artifactDiagnostics.omittedCount).toBe(0);
    });

    test('status is available_omitted when scope has artifacts but none selected', () => {
      const taskEvidence = createEvidence('task', 'evidence-task');
      const availableWorkflowRun = createEvidence('workflow_run', 'evidence-run-1');
      const availableArtifact = createEvidence('artifact', 'evidence-artifact-1');
      const result = scoreEvolutionEvidenceQuality({
        evidence: [taskEvidence],
        availableScopeEvidence: [taskEvidence, availableWorkflowRun, availableArtifact],
      });
      expect(result.artifactDiagnostics.status).toBe('available_omitted');
      expect(result.artifactDiagnostics.availableKinds).toEqual(['artifact', 'workflow_run']);
      expect(result.artifactDiagnostics.omittedCount).toBe(2);
      const recommendationText = result.artifactDiagnostics.recommendations.join(' ');
      expect(recommendationText).toMatch(/workflow_run evidence/);
      expect(recommendationText).toMatch(/artifact evidence/);
      expect(recommendationText).toMatch(/2 workflow artifact evidence rows/);
    });

    test('status is none_available when scope has no workflow artifact kinds', () => {
      const taskEvidence = createEvidence('task', 'evidence-task');
      const result = scoreEvolutionEvidenceQuality({
        evidence: [taskEvidence],
        availableScopeEvidence: [taskEvidence],
      });
      expect(result.artifactDiagnostics.status).toBe('none_available');
      expect(result.artifactDiagnostics.availableKinds).toEqual([]);
      expect(result.artifactDiagnostics.omittedCount).toBe(0);
      expect(result.artifactDiagnostics.recommendations[0]).toMatch(
        /No workflow run or artifact evidence exists/
      );
    });

    test('falls back to selected-evidence-only when availableScopeEvidence omitted', () => {
      const taskEvidence = createEvidence('task', 'evidence-task');
      const result = scoreEvolutionEvidenceQuality({
        evidence: [taskEvidence],
      });
      expect(result.artifactDiagnostics.status).toBe('none_available');
      expect(result.artifactDiagnostics.availableKinds).toEqual([]);
    });

    test('runtime error kinds surface as artifact recommendations when omitted', () => {
      const taskEvidence = createEvidence('task', 'evidence-task');
      const daemonError = createEvidence('daemon_error', 'evidence-daemon');
      const result = scoreEvolutionEvidenceQuality({
        evidence: [taskEvidence],
        availableScopeEvidence: [taskEvidence, daemonError],
      });
      expect(result.artifactDiagnostics.status).toBe('available_omitted');
      expect(result.artifactDiagnostics.availableKinds).toEqual(['daemon_error']);
      const recommendationText = result.artifactDiagnostics.recommendations.join(' ');
      expect(recommendationText).toMatch(/daemon_error evidence/);
    });
  });
});

function createEvidence(kind: EvidenceKind, id?: string): EvidenceRef {
  return {
    id: id ?? `evidence-${kind}`,
    scopeId: 'scope-1',
    kind,
    summary: 'auto-captured daemon event',
    sourceId: `log:${kind}`,
    metadata: {},
    createdAt: Date.now(),
  };
}
