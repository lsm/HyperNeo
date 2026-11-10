import { getDataDir } from '@hyperneo/daemon/lib/data-dir';
import {
  agentReadCredentialPath,
  readLocalCredential,
} from '@hyperneo/daemon/lib/pairing/local-credential';
import { isAgentReadRequest } from '@hyperneo/daemon/lib/pairing/read-page';
import superpipe, { type PipelineAPI } from 'superpipe';

function cardUrl(args: string[]): URL {
  if (args.length !== 1) throw new Error('Usage: hyperneo read <link>');
  const url = new URL(args[0]);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isAgentReadRequest(new Request(url.href))
  )
    throw new Error('Expected a card link ending in /ask/<id>.md');
  return url;
}

function cardMarkdown(response: Response, markdown: string): string {
  if (!response.ok) throw new Error(`Card read failed (${response.status}): ${markdown}`);
  if (!response.headers.get('content-type')?.startsWith('text/markdown'))
    throw new Error('The server did not return Markdown');
  return markdown;
}

const read = (superpipe({})('read-card') as PipelineAPI)
  .input(['args', 'dataDir'])
  .pipe(cardUrl, 'args', 'url')
  .pipe(
    (url: URL, dataDir: string) =>
      readLocalCredential(agentReadCredentialPath(dataDir), url.origin),
    ['url', 'dataDir'],
    'credential'
  )
  .pipe(
    (url: URL, credential: string) =>
      fetch(url, { headers: { authorization: `Bearer ${credential}` }, redirect: 'error' }),
    ['url', 'credential'],
    'response'
  )
  .pipe((response: Response) => response.text(), 'response', 'markdown')
  .pipe(cardMarkdown, ['response', 'markdown'], 'markdown')
  .endAsync('markdown') as (args: string[], dataDir: string) => Promise<string>;

export async function readCard(args: string[], dataDir = getDataDir()): Promise<number> {
  try {
    process.stdout.write(await read(args, dataDir));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
