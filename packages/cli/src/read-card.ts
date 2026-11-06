import { getDataDir } from '@hyperneo/daemon/lib/data-dir';
import {
  agentReadCredentialPath,
  readLocalCredential,
} from '@hyperneo/daemon/lib/pairing/local-credential';
import { isAgentReadRequest } from '@hyperneo/daemon/lib/pairing/read-page';

export async function readCard(args: string[], dataDir = getDataDir()): Promise<number> {
  try {
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
    const credential = readLocalCredential(agentReadCredentialPath(dataDir));
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${credential}` },
      redirect: 'error',
    });
    const markdown = await response.text();
    if (!response.ok) throw new Error(`Card read failed (${response.status}): ${markdown}`);
    if (!response.headers.get('content-type')?.startsWith('text/markdown'))
      throw new Error('The server did not return Markdown');
    process.stdout.write(markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
