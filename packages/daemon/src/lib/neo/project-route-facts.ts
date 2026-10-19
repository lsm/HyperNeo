import { parseGitHubRefUrl } from '../github/parse-pr-url.ts';

export function neoRepoAlias(remote: string): string | null {
  const url = remote
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\/?$/, '')
    .replace(/\.git$/, '');
  const ref = parseGitHubRefUrl(`${url}/issues/1`);
  return ref ? `repo:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}\u0000` : null;
}
