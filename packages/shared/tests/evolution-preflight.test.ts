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
});

function createEvidence(kind: EvidenceKind): EvidenceRef {
	return {
		id: `evidence-${kind}`,
		scopeId: 'scope-1',
		kind,
		summary: 'auto-captured daemon event',
		sourceId: `log:${kind}`,
		metadata: {},
		createdAt: Date.now(),
	};
}
