import type { NeoProjectCleanup } from './project-cleanup.ts';
import type { NeoService } from './service.ts';

export function createNeoProjectCleanupApply(
  service: Pick<NeoService, 'repo'>
): (step: NeoProjectCleanup) => Promise<void> {
  return (step) => service.repo.applyCleanup(step);
}
