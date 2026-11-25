import type { NeoTodoCheckResult } from '../../pack-contract.ts';
import { BUILD_METADATA } from '../../../build-metadata.ts';
import type { CodingAncestryFactsRepository } from './ancestry-facts.ts';

export async function checkCodingDeployed(
  repo: string,
  sha: string,
  ancestry: Pick<CodingAncestryFactsRepository, 'refresh'>,
  build = BUILD_METADATA.commit
): Promise<NeoTodoCheckResult> {
  if (!/^[0-9a-f]{40}$/.test(build)) return { done: false, evidence: null };
  const fact = await ancestry.refresh({ repo, baseOid: sha, headOid: build });
  return fact.ancestry.status === 'known' && fact.ancestry.contains
    ? { done: true, evidence: `The running daemon build ${build} contains ${repo}@${sha}` }
    : { done: false, evidence: null };
}
