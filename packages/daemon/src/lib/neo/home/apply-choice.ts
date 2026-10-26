import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { publicationLog, requireHomeSave, type HomeSavePlan, type HomeSaveResult } from './save.ts';

type Git = (
  args: string[],
  allowFailure?: boolean,
  network?: boolean,
  cwd?: string
) => Promise<{ code: number; text: string; bytes: Buffer; error: string }>;
const refuse = (reason: string): HomeSaveResult => ({ ok: false, reason });

export async function applyHomeChoice(
  root: string,
  input: HomeSavePlan,
  git: Git
): Promise<HomeSaveResult> {
  const local = await git(['rev-parse', 'HEAD'], true);
  const branch = await git(['symbolic-ref', 'HEAD'], true);
  const upstream = await git(['rev-parse', '--symbolic-full-name', '@{upstream}'], true);
  if (
    local.code ||
    branch.code ||
    upstream.code ||
    !upstream.text.startsWith('refs/remotes/origin/')
  )
    return refuse('stale_conflict: restore the selected home branch and its origin tracking.');
  const remoteBranch = `refs/heads/${upstream.text.slice('refs/remotes/origin/'.length)}`;
  const reference = `refs/neo-home-choice/${crypto.randomUUID()}`;
  const temporary = await mkdtemp(join(tmpdir(), 'neo-home-choice-stage-'));
  const stage = join(temporary, 'worktree');
  const inStage: Git = (args, failure = false) => git(args, failure, false, stage);
  let registered = false;
  try {
    const fetched = await git(
      ['fetch', '--no-write-fetch-head', 'origin', `${remoteBranch}:${reference}`],
      true,
      true
    );
    if (fetched.code) return refuse(`sync_failed: ${fetched.error}`);
    const remote = (await git(['rev-parse', reference])).text;
    const selected = input.resolution!.revision;
    const mode = (await git(['ls-tree', selected, '--', input.path], true)).text.slice(0, 6);
    const content = await git(['show', `${selected}:${input.path}`], true);
    if (!['100644', '100755'].includes(mode) || content.code)
      return refuse(
        'choice_requires_file: deletion or symbolic-link choices require human review.'
      );
    if (!content.bytes.equals(Buffer.from(input.content, 'utf8')))
      return refuse(
        'choice_content_mismatch: save the exact bytes of the recorded version choice.'
      );
    await git(['worktree', 'add', '--detach', stage, local.text]);
    registered = true;
    await inStage(['merge', '--no-commit', '--no-ff', remote], true);
    const conflicts = (await inStage(['diff', '--name-only', '--diff-filter=U', '-z'])).bytes
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    if (conflicts.length !== 1 || conflicts[0] !== input.path)
      return refuse(
        'choice_requires_review: this save resolves one conflicting document; review other conflicts separately.'
      );
    const put = async (path: string, bytes: Buffer, fileMode = '100644') => {
      const file = join(temporary, crypto.randomUUID());
      await writeFile(file, bytes, { flag: 'wx' });
      const blob = (await inStage(['hash-object', '-w', '--no-filters', file])).text;
      await inStage(['update-index', '--add', '--cacheinfo', fileMode, blob, path]);
    };
    for (const path of [
      input.path,
      ...(input.confirmation ? [join(dirname(input.path), 'decisions.md')] : []),
    ])
      if (!(await inStage(['check-ignore', '-q', '--', path], true)).code)
        return refuse('ignored_path: this document or decision log is git-ignored.');
    await put(input.path, content.bytes, mode);
    if (input.confirmation) {
      const log = join(dirname(input.path), 'decisions.md');
      const logMode = (await inStage(['ls-files', '--stage', '--', log])).text.slice(0, 6);
      if (logMode && !['100644', '100755'].includes(logMode))
        return refuse('invalid_path: the decision log must be a regular document.');
      const previous = await inStage(['show', `:${log}`], true);
      await put(
        log,
        Buffer.concat([
          previous.code ? Buffer.alloc(0) : previous.bytes,
          Buffer.from(input.confirmation.entry, 'utf8'),
        ]),
        logMode || '100644'
      );
    }
    const message = `${input.message}\n\nNeo-Conflict-Choice: question ${input.resolution!.questionId}${input.confirmation ? `\nNeo-Confirmed-By: question ${input.confirmation.questionId}` : ''}`;
    await inStage(['commit', '-m', message]);
    const commit = (await inStage(['rev-parse', 'HEAD'])).text;
    const publication = requireHomeSave({
      ...input,
      content: (await inStage([...publicationLog, `${remote}..HEAD`])).text,
    });
    if (publication.reason) return publication.reason;
    const installed = await git(
      ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', commit],
      true
    );
    if (installed.code)
      return refuse(`sync_failed: Git could not apply the resolution. ${installed.error}`);
    const pushed = await git(
      [
        'push',
        `--force-with-lease=${remoteBranch}:${remote}`,
        'origin',
        `${commit}:${remoteBranch}`,
      ],
      true,
      true
    );
    if (pushed.code)
      return refuse(
        `push_failed: local resolution commit ${commit} is saved; check origin before retrying. ${pushed.error}`
      );
    return { ok: true, path: input.path, commit };
  } finally {
    if (registered) await git(['worktree', 'remove', '--force', stage], true).catch(() => {});
    await git(['update-ref', '-d', reference], true).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}
