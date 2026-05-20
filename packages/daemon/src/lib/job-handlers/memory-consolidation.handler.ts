import type { Job } from '../../storage/repositories/job-queue-repository';
import type { AgentMemoryRepository } from '../../storage/repositories/agent-memory-repository';

export function createMemoryConsolidationHandler(memoryRepo: AgentMemoryRepository) {
	return async (job: Job): Promise<Record<string, unknown>> => {
		const result = memoryRepo.consolidate({
			spaceId: readOptionalString(job.payload.spaceId),
			staleTtlMs: readOptionalNumber(job.payload.staleTtlMs),
			duplicateJaccardThreshold: readOptionalNumber(job.payload.duplicateJaccardThreshold),
			coreLimit: readOptionalNumber(job.payload.coreLimit),
		});
		return { ...result };
	};
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
