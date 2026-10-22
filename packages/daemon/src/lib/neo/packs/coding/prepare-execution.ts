import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { gitWorktreeProject } from '../../../drivers/acp-agent-adapter.ts';
import type { NeoExecutionPreparation } from '../../pack-contract.ts';

type Request = Parameters<NeoExecutionPreparation>[0];
type Effects = Parameters<NeoExecutionPreparation>[1];
type Failure = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Failure };
type Plan = { directory: string; destination: string; ref: string; commits: string[] };
type CommandResult = Awaited<ReturnType<Effects['run']>>;

function refuse(reason: string): { reason: Failure } {
  return { reason: { ok: false, reason } };
}

function planPreparation(request: Request): Gate<Plan> {
  const { target = 'HEAD', prerequisiteCommits = [] } = request.parameters;
  if (
    !isAbsolute(request.directory) ||
    !isAbsolute(request.destination) ||
    resolve(request.directory) === resolve(request.destination)
  )
    return refuse('invalid_preparation_directory');
  if (
    typeof target !== 'string' ||
    !target ||
    target.startsWith('-') ||
    target === '@' ||
    /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(target) ||
    target.includes('..') ||
    target.includes('@{') ||
    target
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  )
    return refuse('invalid_preparation_target');
  if (
    !Array.isArray(prerequisiteCommits) ||
    !prerequisiteCommits.every(
      (commit) => typeof commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)
    )
  )
    return refuse('invalid_prerequisite_commits');
  return {
    value: {
      directory: request.directory,
      destination: request.destination,
      ref: request.parameters.target === undefined ? '' : `refs/remotes/origin/${target}`,
      commits: [...prerequisiteCommits],
    },
  };
}

const VERIFY_SKILL = /^\.claude\/skills\/verify[^/]*\/SKILL\.md$/m;
const VERIFY_SECTION = /^ {0,3}#{1,6}[ \t]+Verify\b/m;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function withoutFencedCode(markdown: string): string {
  let open: string | null = null;
  return markdown
    .split(/\r\n?|\n/)
    .filter((line) => {
      const fence = FENCE.exec(line);
      if (open === null) {
        if (!fence || (fence[1][0] === '`' && fence[2].includes('`'))) return true;
        open = fence[1];
        return false;
      }
      if (fence && fence[1][0] === open[0] && fence[1].length >= open.length && !fence[2].trim())
        open = null;
      return false;
    })
    .join('\n');
}

export function requireVerifySkill(
  mode: unknown,
  listed: CommandResult,
  agents: CommandResult | null
): Gate<true> {
  if (mode === 'create') return { value: true };
  if (listed.code !== 0) return refuse(`verify_skill_unreadable: ${listed.stderr.trim()}`);
  if (
    VERIFY_SKILL.test(listed.stdout) ||
    (agents?.code === 0 && VERIFY_SECTION.test(withoutFencedCode(agents.stdout)))
  )
    return { value: true };
  return refuse(
    'verify_skill_missing: this repository has no verify skill (.claude/skills/verify/SKILL.md or a Verify section in AGENTS.md). Add a todo before this one whose worker writes it and runs it end to end once, start that todo with target.preparationParameters.verifySkill "create", and merge its pull request under the repository’s normal merge rule; then retry this todo.'
  );
}

function requireCommand(result: CommandResult, phase: string): Gate<CommandResult> {
  return result.code === 0 ? { value: result } : refuse(`${phase}: ${result.stderr.trim()}`);
}

function requireCommit(result: CommandResult): Gate<string> {
  const commit = result.stdout.trim();
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)
    ? { value: commit }
    : refuse('invalid_prepared_commit');
}

async function prepareClone(
  plan: Plan,
  commit: string,
  effects: Effects
): Promise<Gate<{ directory: string; release: () => Promise<void> }>> {
  const remote = await effects.run(['git', 'remote', 'get-url', 'origin'], plan.directory);
  if (remote.code !== 0) return refuse(`clone_origin_failed: ${remote.stderr.trim()}`);
  const config = await effects.run(
    [
      'git',
      'config',
      '--local',
      '--null',
      '--get-regexp',
      '^(user\\.(name|email|signingkey)|commit\\.gpgsign|gpg\\.(format|program|ssh\\.program|openpgp\\.program|x509\\.program))$',
    ],
    plan.directory
  );
  if (config.code !== 0 && config.code !== 1)
    return refuse(`clone_config_failed: ${config.stderr.trim()}`);
  try {
    await mkdir(dirname(plan.destination), { recursive: true });
    await mkdir(plan.destination);
  } catch (error) {
    return refuse(`clone_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let ready = false;
  try {
    const commands = [
      {
        args: [
          'git',
          'clone',
          '--no-hardlinks',
          '--dissociate',
          '--no-checkout',
          '--',
          plan.directory,
          plan.destination,
        ],
        cwd: plan.directory,
        phase: 'clone_failed',
      },
      {
        args: ['git', 'remote', 'set-url', 'origin', remote.stdout.trim()],
        cwd: plan.destination,
        phase: 'clone_origin_failed',
      },
      {
        args: ['git', 'checkout', '--detach', commit],
        cwd: plan.destination,
        phase: 'clone_checkout_failed',
      },
    ];
    for (const { args, cwd, phase } of commands) {
      const result = await effects.run(args, cwd);
      if (result.code !== 0) return refuse(`${phase}: ${result.stderr.trim()}`);
    }
    const refs = await effects.run(
      ['git', 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'],
      plan.destination
    );
    if (refs.code !== 0) return refuse(`clone_refs_failed: ${refs.stderr.trim()}`);
    for (const ref of refs.stdout.split('\n').filter(Boolean)) {
      const removed = await effects.run(
        ['git', 'update-ref', '--no-deref', '-d', ref],
        plan.destination
      );
      if (removed.code !== 0) return refuse(`clone_refs_failed: ${removed.stderr.trim()}`);
    }
    const pinned = await effects.run(['git', 'update-ref', plan.ref, commit], plan.destination);
    if (pinned.code !== 0) return refuse(`clone_refs_failed: ${pinned.stderr.trim()}`);
    for (const setting of config.stdout.split('\0').filter(Boolean)) {
      const split = setting.indexOf('\n');
      const written = await effects.run(
        ['git', 'config', '--local', '--add', setting.slice(0, split), setting.slice(split + 1)],
        plan.destination
      );
      if (written.code !== 0) return refuse(`clone_config_failed: ${written.stderr.trim()}`);
    }
    await writeFile(
      join(plan.destination, '.git', 'hyperneo-source-checkout'),
      await gitWorktreeProject(plan.directory)
    );
    ready = true;
    return {
      value: {
        directory: plan.destination,
        release: () => rm(plan.destination, { recursive: true }),
      },
    };
  } finally {
    if (!ready) await rm(plan.destination, { recursive: true });
  }
}

export const prepareCodingExecution = (superpipe({})('neo-coding-prepare-execution') as PipelineAPI)
  .input(['request', 'effects'])
  .pipe(planPreparation, 'request', 'result:prepared')
  .pipe(
    (plan: Plan, effects: Effects) =>
      plan.ref
        ? null
        : effects.run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], plan.directory),
    ['prepared', 'effects'],
    'advertised'
  )
  .pipe(
    (plan: Plan, request: Request, advertised: CommandResult | null): Gate<Plan> => {
      if (plan.ref) return { value: plan };
      if (!advertised || advertised.code !== 0) return refuse('remote_default_unavailable');
      const targets = [...advertised.stdout.matchAll(/^ref: refs\/heads\/(.+)\tHEAD$/gm)];
      return targets.length === 1
        ? planPreparation({
            ...request,
            parameters: { ...request.parameters, target: targets[0][1] },
          })
        : refuse('remote_default_unavailable');
    },
    ['prepared', 'request', 'advertised'],
    'result:prepared'
  )
  .pipe((prepared: Plan) => prepared, 'prepared', 'plan')
  .pipe(
    async (plan: Plan, effects: Effects) =>
      effects.run(
        [
          'git',
          'fetch',
          '--no-tags',
          'origin',
          `+refs/heads/${plan.ref.slice('refs/remotes/origin/'.length)}:${plan.ref}`,
        ],
        plan.directory
      ),
    ['plan', 'effects'],
    'fetched'
  )
  .pipe(
    (fetched: CommandResult) => requireCommand(fetched, 'fetch_failed'),
    'fetched',
    'result:prepared'
  )
  .pipe(
    async (plan: Plan, effects: Effects) =>
      effects.run(['git', 'rev-parse', '--verify', `${plan.ref}^{commit}`], plan.directory),
    ['plan', 'effects'],
    'resolved'
  )
  .pipe(
    (resolved: CommandResult) => requireCommand(resolved, 'resolve_failed'),
    'resolved',
    'result:prepared'
  )
  .pipe(requireCommit, 'prepared', 'result:prepared')
  .pipe((prepared: string) => prepared, 'prepared', 'commit')
  .pipe(
    async (plan: Plan, commit: string, effects: Effects): Promise<Gate<string>> => {
      for (const prerequisite of plan.commits) {
        const checked = await effects.run(
          ['git', 'merge-base', '--is-ancestor', prerequisite, commit],
          plan.directory
        );
        if (checked.code !== 0) return refuse(`prerequisite_not_in_base: ${prerequisite}`);
      }
      return { value: commit };
    },
    ['plan', 'commit', 'effects'],
    'result:prepared'
  )
  .pipe(
    async (plan: Plan, commit: string, effects: Effects) =>
      effects.run(
        ['git', 'ls-tree', '-r', '--name-only', commit, '--', '.claude/skills', 'AGENTS.md'],
        plan.directory
      ),
    ['plan', 'commit', 'effects'],
    'listed'
  )
  .pipe(
    async (plan: Plan, commit: string, listed: CommandResult, effects: Effects) =>
      /^AGENTS\.md$/m.test(listed.stdout)
        ? effects.run(['git', 'show', `${commit}:AGENTS.md`], plan.directory)
        : null,
    ['plan', 'commit', 'listed', 'effects'],
    'agents'
  )
  .pipe(
    (request: Request, listed: CommandResult, agents: CommandResult | null) =>
      requireVerifySkill(request.parameters.verifySkill, listed, agents),
    ['request', 'listed', 'agents'],
    'result:prepared'
  )
  .pipe(prepareClone, ['plan', 'commit', 'effects'], 'result:prepared')
  .pipe(
    (prepared: { directory: string; release: () => Promise<void> }) => ({
      ok: true,
      value: prepared,
    }),
    'prepared',
    'prepared'
  )
  .endAsync('prepared') as NeoExecutionPreparation;
