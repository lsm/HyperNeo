import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OXAP_VERSION } from '../../../packages/daemon/src/lib/oap/oxap-install.ts';

const PROBE = 'https://api.openai.com/v1/responses';

export const OXAP_CODEX_MODEL = 'codex-6-luna';

export const oxapCodexProvider = {
  params: {
    providerId: 'anthropic-codex',
    displayName: 'Synthetic OXAP Codex',
    kind: 'built_in',
    authType: 'api_key',
    isEnabled: true,
    isDefault: false,
    sortOrder: 1,
    configJson: JSON.stringify({ harness: 'oxap-codex' }),
  },
  credentials: { apiKey: 'sk-synthetic-oxap-codex' },
};

export function answerCodexProbeLocally(): string[] {
  const probes: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === PROBE) {
        probes.push(url);
        return new Response('{}', { status: 200 });
      }
      if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return real(input, init);
      throw new Error(`Synthetic OXAP proof refused a network request to ${url}`);
    },
    { preconnect: real.preconnect }
  ) as typeof fetch;
  return probes;
}

export function serveLocalRelease(binary: string, name: string, directory: string): string[] {
  mkdirSync(directory, { recursive: true });
  copyFileSync(binary, join(directory, 'oxap'));
  execFileSync('tar', ['-czf', join(directory, `${name}.tar.gz`), '-C', directory, 'oxap']);
  const archive = readFileSync(join(directory, `${name}.tar.gz`));
  const sums = `${createHash('sha256').update(archive).digest('hex')}  ${name}.tar.gz\n`;
  const base = `https://github.com/lsm/oxap/releases/download/v${OXAP_VERSION}/`;
  const requests: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(base)) return real(input, init);
      const asset = url.slice(base.length);
      requests.push(asset);
      if (asset === 'SHA256SUMS.txt') return new Response(sums);
      if (asset === `${name}.tar.gz`) return new Response(archive);
      return new Response('missing', { status: 404 });
    },
    { preconnect: real.preconnect }
  ) as typeof fetch;
  return requests;
}
