import { homedir } from 'node:os';
import { z } from 'zod';
import { defineOperation } from '../../../operations/registry.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { buildGitHubLookupEnv } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';

export const createCodingHumanMergeOperation = (spawn: SpawnFn = spawnProcess) =>
  defineOperation({
    name: 'neo.coding.merge.human',
    description:
      'When the human chooses to merge a PR themselves, add its human-merge label with enabled:true; remove it with enabled:false when they change their mind. For mergeBy=daemon repos do not chase owners to merge. Configured humanSignoff labels hold daemon merging. Never changes repository preferences.',
    inputSchema: z.object({ url: z.string().url(), enabled: z.boolean() }).strict(),
    resultSchema: z.object({ accepted: z.boolean(), reason: z.string().optional() }),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async ({ url, enabled }) => {
      const pr = parsePrUrl(url.toLowerCase());
      const refused = {
        accepted: false,
        reason:
          'The human-merge label could not be updated. Use an allowed GitHub PR URL and retry the requested label change.',
      };
      if (!pr || (pr.host !== 'github.com' && pr.host !== process.env.GH_HOST?.toLowerCase()))
        return refused;
      const proc = spawn(
        ['gh', 'pr', 'edit', url, enabled ? '--add-label' : '--remove-label', 'human-merge'],
        { cwd: homedir(), env: buildGitHubLookupEnv(), stdout: 'ignore', stderr: 'ignore' }
      );
      const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
      try {
        const code = await proc.exited;
        return code === 0 ? { accepted: true } : refused;
      } finally {
        clearTimeout(timer);
      }
    },
  });
