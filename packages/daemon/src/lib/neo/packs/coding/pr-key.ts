import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';

export function codingPrKey(url: string): string | null {
  const parsed = parsePrUrl(url);
  return parsed
    ? githubUrlKey(`https://${parsed.host}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`)
    : null;
}
