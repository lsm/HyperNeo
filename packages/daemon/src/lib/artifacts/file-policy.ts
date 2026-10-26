import type { ArtifactRefusal } from '@hyperneo/shared/types/artifact-file';
import { posix } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { isLocalUser } from '../operations/caller.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { secretName } from '../secret-file-name.ts';

export interface ArtifactContext {
  readonly kind: 'todo' | 'ask';
  readonly id: string;
}

export interface ArtifactContextBinding {
  readonly context: ArtifactContext;
  readonly daemonId: string;
  readonly neoSessionId: string | null;
  readonly workerSessionId: string | null;
  readonly workerRef?: { readonly adapter: string; readonly id: string };
  readonly workspacePath: string | null;
  readonly approvedEvidenceRoots: readonly string[];
}

export interface ArtifactPolicyDependencies {
  readonly daemonId: string;
  readonly home: string;
  readonly loadBinding: (
    context: ArtifactContext
  ) => ArtifactContextBinding | null | Promise<ArtifactContextBinding | null>;
}

interface OpenPlan {
  readonly context: ArtifactContext;
  readonly root: string;
  readonly relativePath: string;
}

type Gate<T> = { value: T } | { reason: ArtifactRefusal };
const refused = (reason: ArtifactRefusal['reason']) => ({
  reason: { accepted: false as const, reason },
});

export function admitArtifactContext(context: ArtifactContext): Gate<ArtifactContext> {
  return context &&
    ['todo', 'ask'].includes(context.kind) &&
    typeof context.id === 'string' &&
    context.id.trim()
    ? { value: { kind: context.kind, id: context.id } }
    : refused('unavailable');
}

export async function loadArtifactContextBinding(
  context: ArtifactContext,
  deps: ArtifactPolicyDependencies
) {
  const binding = await deps.loadBinding(context);
  return {
    value: binding ?? {
      context,
      daemonId: deps.daemonId,
      neoSessionId: null,
      workerSessionId: null,
      workspacePath: null,
      approvedEvidenceRoots: [],
    },
  };
}

export function authorizeArtifactCaller(
  binding: ArtifactContextBinding,
  caller: OperationCaller
): Gate<ArtifactContextBinding> {
  const neo =
    caller.source === 'mcp' && caller.role === 'neo' && caller.sessionId === binding.neoSessionId;
  const worker =
    caller.source === 'mcp' &&
    ['workflow_worker', 'direct_task_worker'].includes(caller.role ?? '') &&
    caller.sessionId === binding.workerSessionId;
  return isLocalUser(caller) || neo || worker ? { value: binding } : refused('unavailable');
}

export function unsafePath(path: string): boolean {
  return (
    !path ||
    /[\u0000-\u001f\u007f\\:]/.test(path) ||
    /%(?:25)*[0-9a-f]{2}/i.test(path) ||
    path.split('/').includes('..')
  );
}

export function sensitivePath(path: string): boolean {
  if (
    /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|\.codex\/(?:config\.toml|auth\.json)|\.config\/(?:gcloud|gh))(?:$|\/)/i.test(
      posix.normalize(path)
    )
  )
    return true;
  if (
    /(?:^|\/)(?:\.config\/gh\/hosts\.ya?ml|\.claude\/projects\/.+\.jsonl)(?:$|\/)/i.test(
      posix.normalize(path)
    )
  )
    return true;
  return path.split('/').some((name) => {
    const lower = name.toLowerCase();
    return (
      secretName(name) ||
      lower.startsWith('.env') ||
      ['.claude.json', '.bash_history', '.zsh_history', 'cookies'].includes(lower) ||
      ['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'keychains'].includes(
        lower
      ) ||
      /^\.?auth(?:entication)?(?:[._-].*)?\.json$/.test(lower) ||
      /\.keychain(?:-db)?$/.test(lower) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(lower) ||
      /\.(?:p8|priv)$/.test(lower) ||
      /\.(?:db|sqlite3?)(?:$|[.\s-])/.test(lower)
    );
  });
}

function within(root: string, path: string): boolean {
  const relative = posix.relative(root, path);
  return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative);
}

export function resolveArtifactSource(
  binding: ArtifactContextBinding,
  source: string,
  deps: ArtifactPolicyDependencies
): Gate<OpenPlan> {
  if (typeof source !== 'string' || unsafePath(source)) return refused('unsafe_path');
  if (sensitivePath(source)) return refused('sensitive_path');
  if (
    !posix.isAbsolute(source) &&
    (!binding.workspacePath || !posix.isAbsolute(binding.workspacePath))
  )
    return refused('ambiguous_context');
  const path = posix.resolve(binding.workspacePath ?? '/', source);
  if (sensitivePath(path)) return refused('sensitive_path');
  const homeRelative = posix.relative(deps.home.toLowerCase(), path.toLowerCase());
  if (homeRelative.startsWith('.') && !homeRelative.startsWith('../') && homeRelative.includes('/'))
    return refused('sensitive_path');
  const root =
    binding.workspacePath &&
    posix.isAbsolute(binding.workspacePath) &&
    within(binding.workspacePath, path)
      ? binding.workspacePath
      : posix.dirname(path);
  return {
    value: {
      context: binding.context,
      root: posix.normalize(root),
      relativePath: posix.relative(root, path),
    },
  };
}

export const admitArtifactCapture = (superpipe({})('artifact-capture-policy') as PipelineAPI)
  .input(['context', 'source', 'caller', 'deps'])
  .pipe(admitArtifactContext, 'context', 'result:policy')
  .pipe(loadArtifactContextBinding, ['policy', 'deps'], 'result:policy')
  .pipe(resolveArtifactSource, ['policy', 'source', 'deps'], 'result:policy')
  .endAsync('policy') as (
  context: ArtifactContext,
  source: string,
  caller: OperationCaller,
  deps: ArtifactPolicyDependencies
) => Promise<OpenPlan | ArtifactRefusal>;
