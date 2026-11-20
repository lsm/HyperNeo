import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getDataDir } from '../data-dir.ts';
import { defineOperation } from '../operations/registry.ts';

const run = promisify(execFile);
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const Input = z.object({ app: z.string().trim().min(1).max(200) }).strict();
const Result = z.union([
  z.object({ ok: z.literal(true), bundleId: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string(), bundleId: z.string().optional() }),
]);
type Outcome = z.infer<typeof Result>;

const explanations: Record<string, string> = {
  app_not_found:
    'No installed app has that name. Pass its bundle id, or its English name as Finder shows it.',
  desktop_app_not_connected:
    'HyperNeo Desktop is not running on this Mac; ask the human to open it.',
  waiting_for_owner:
    'The Mac is still showing the dialog. Tell the human it may be behind other windows, then call again.',
  owner_declined:
    'The human declined this app; it will not be asked again for 10 minutes. Take another route or hand the step to the human.',
  app_not_grantable: 'HyperNeo cannot be given control of its own app.',
  target_unverified: 'The app is not signed by Apple, the Mac App Store or a Developer ID.',
  guards_unavailable:
    'HyperNeo Desktop could not read or store its grants; ask the human to check it.',
};

async function bundleIdFor(app: string): Promise<string | null> {
  if (BUNDLE_ID.test(app)) return app;
  if (process.platform !== 'darwin') return null;
  const name = app.replace(/\.app$/i, '').replace(/["\\]/g, '');
  const query = `kMDItemContentType == "com.apple.application-bundle" && (kMDItemDisplayName == "${name}"c || kMDItemAlternateNames == "${name}"c || kMDItemFSName == "${name}.app"c)`;
  const found = await run('mdfind', [query], { timeout: 5000 }).catch(() => null);
  const path = found?.stdout.split('\n').find((line) => line.endsWith('.app'));
  if (!path) return null;
  const id = await run('mdls', ['-raw', '-name', 'kMDItemCFBundleIdentifier', path], {
    timeout: 5000,
  }).catch(() => null);
  const bundleId = id?.stdout.trim() ?? '';
  return BUNDLE_ID.test(bundleId) ? bundleId : null;
}

function askDesktop(socket: string, bundleId: string): Promise<string> {
  const callId = randomUUID();
  return new Promise((resolve) => {
    const client = createConnection(socket);
    let text = '';
    const timer = setTimeout(() => finish('waiting_for_owner'), 50000);
    function finish(reason: string) {
      clearTimeout(timer);
      client.destroy();
      resolve(reason);
    }
    client.once('connect', () =>
      client.write(
        JSON.stringify({
          action: 'resolve',
          worker: 'neo',
          tool: 'launch_app',
          arguments: { bundle_id: bundleId },
          callId,
        }) + '\n'
      )
    );
    client.on('data', (chunk) => {
      text += chunk.toString();
      if (!text.includes('\n')) return;
      try {
        const reply = JSON.parse(text.slice(0, text.indexOf('\n')));
        if (reply?.ok === false) return finish(String(reply.error ?? 'guards_unavailable'));
        const result = reply?.result;
        finish(result?.value ? 'allowed' : String(result?.reason ?? 'guards_unavailable'));
      } catch {
        finish('guards_unavailable');
      }
    });
    client.once('end', () => finish('guards_unavailable'));
    client.once('error', (error: NodeJS.ErrnoException) =>
      finish(
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? 'desktop_app_not_connected'
          : 'guards_unavailable'
      )
    );
  });
}

export function createDesktopAccessOperation(
  options: { dataDir?: string; ask?: (bundleId: string) => Promise<string> } = {}
) {
  return defineOperation({
    name: 'desktop.access.request',
    description:
      'Ask the human, through a dialog on this Mac, to let HyperNeo workers control one app. Tell the human a dialog is coming before you call. Returns ok when the app is allowed, already or now.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async ({ app }, caller): Promise<Outcome> => {
      if (caller.role !== 'neo')
        return {
          ok: false,
          reason: 'neo_only: Only Neo asks for desktop access; report the need to Neo.',
        };
      const bundleId = await bundleIdFor(app);
      if (!bundleId) return { ok: false, reason: `app_not_found: ${explanations.app_not_found}` };
      const answer = await (
        options.ask ??
        ((id: string) =>
          askDesktop(join(options.dataDir ?? getDataDir(), 'desktop/control.sock'), id))
      )(bundleId);
      if (answer === 'allowed') return { ok: true, bundleId };
      return {
        ok: false,
        bundleId,
        reason: `${answer}: ${explanations[answer] ?? 'HyperNeo Desktop refused the request.'}`,
      };
    },
  });
}
