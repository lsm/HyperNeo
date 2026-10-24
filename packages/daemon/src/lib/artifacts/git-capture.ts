import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { ArtifactFileRepository } from '../../storage/repositories/artifact-file-repository.ts';
import type { ArtifactContext } from './file-policy.ts';
import { loadRegistrationBinding } from './registration-binding.ts';
import { artifactCaptureOwner } from './capture-owner.ts';
import { storedKind } from './register-operation.ts';
import { readBoundGitBlob } from './git-blob.ts';

type Plan = { repository: string; sha: string; path: string; context: ArtifactContext };
const lanes = new WeakMap<Database, Promise<unknown>>();
export function captureGitArtifact(
  db: Database,
  data: string,
  plan: Plan,
  requestId: string,
  current: () => Promise<boolean>,
  readBlob = readBoundGitBlob,
  home = homedir()
) {
  const repo = new ArtifactFileRepository(db);
  const key = `git:${requestId}`;
  const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const unavailable = () => ({ accepted: false as const, reason: 'unavailable' as const });
  async function publish(
    blob: Extract<Awaited<ReturnType<typeof readBoundGitBlob>>, { accepted: true }>
  ) {
    const binding = loadRegistrationBinding(db, repo.daemonId, plan.context, home);
    if (!binding || !(await current())) return unavailable();
    const snapshot = await (await artifactCaptureOwner(db, data)).capture(blob.bytes);
    if (!snapshot.accepted) return snapshot;
    if (snapshot.sha256 !== blob.sha256) return unavailable();
    const kind = await storedKind(join(data, 'artifacts'), snapshot.sha256, plan.path);
    if (!kind.accepted) return kind;
    if (!kind.value) return { accepted: false, reason: 'unsupported_type' };
    if (
      !(await current()) ||
      JSON.stringify(loadRegistrationBinding(db, repo.daemonId, plan.context, home)) !==
        JSON.stringify(binding)
    )
      return unavailable();
    return repo.save(
      plan.context,
      key,
      fingerprint,
      snapshot.sha256,
      {
        daemonId: repo.daemonId,
        artifactId: randomUUID(),
        title: plan.path.split('/').at(-1)!.slice(0, 200),
        kind: kind.value,
        byteLength: snapshot.byteLength,
      },
      JSON.stringify(
        binding.workerRef ?? {
          adapter: 'hyperneo',
          id: binding.workerSessionId ?? binding.neoSessionId,
        }
      ),
      plan.path,
      { kind: 'commit', repository: plan.repository, commitSha: plan.sha, blobSha: blob.blobSha }
    );
  }
  const run = (superpipe({})('artifact-git-capture') as PipelineAPI)
    .input(['plan'])
    .pipe(
      async (plan: Plan) => {
        if (!(await current())) return { reason: unavailable() };
        const blob = await readBlob({
          repository: plan.repository,
          sha: plan.sha,
          path: plan.path,
        });
        return blob.accepted ? { value: blob } : { reason: blob };
      },
      'plan',
      'result:captured'
    )
    .pipe(publish, 'captured', 'captured')
    .endAsync('captured') as (plan: Plan) => Promise<unknown>;
  const result = (lanes.get(db) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const previous = repo.receipt(plan.context, key);
      if (!previous) return run(plan);
      return previous.fingerprint === fingerprint && (await current())
        ? { accepted: true, artifact: JSON.parse(previous.receipt).artifact }
        : unavailable();
    });
  lanes.set(db, result);
  return result;
}
