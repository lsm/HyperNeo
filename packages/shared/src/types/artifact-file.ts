export const ARTIFACT_KINDS = ['markdown', 'html', 'image', 'json', 'log', 'text'] as const;

export const ARTIFACT_DEFAULT_LIMITS = {
  artifactBytes: 64 * 1024 * 1024,
  documentPreviewBytes: 2 * 1024 * 1024,
  textPreviewBytes: 256 * 1024,
  imageBytes: 32 * 1024 * 1024,
  imagePixels: 16_000_000,
  retainedBytes: 10 * 1024 * 1024 * 1024,
  warningRatio: 0.8,
  readBytes: 256 * 1024,
  bundleEntries: 64,
  bundleBytes: 64 * 1024 * 1024,
} as const;

export type ArtifactLimits = { readonly [Key in keyof typeof ARTIFACT_DEFAULT_LIMITS]: number };

export const ARTIFACT_REFUSALS = [
  'outside_roots',
  'sensitive_path',
  'unsafe_path',
  'source_changed',
  'size_limit',
  'quota_full',
  'unsupported_type',
  'ambiguous_context',
  'safe_open_unavailable',
  'unavailable',
] as const;

export interface ArtifactRef {
  readonly daemonId: string;
  readonly artifactId: string;
  readonly title: string;
  readonly kind: (typeof ARTIFACT_KINDS)[number];
  readonly byteLength: number;
}

export interface ArtifactProjection {
  readonly artifacts?: readonly ArtifactRef[];
}

export interface ArtifactRefusal {
  readonly accepted: false;
  readonly reason: (typeof ARTIFACT_REFUSALS)[number];
}

export type ArtifactReadResult =
  | ArtifactRefusal
  | {
      readonly accepted: true;
      readonly data: string;
      readonly nextOffset: number;
      readonly byteLength: number;
      readonly sha256: string;
      readonly complete: boolean;
    };

export interface ArtifactFileMetadata {
  readonly context: { readonly kind: 'todo' | 'ask'; readonly id: string };
  readonly artifact: ArtifactRef;
  readonly sha256: string;
  readonly createdAt: number;
  readonly sourcePath: string;
  readonly producer: { readonly adapter: string; readonly id: string };
  readonly revision?:
    | { readonly kind: 'worktree'; readonly baseCommit?: string }
    | {
        readonly kind: 'commit';
        readonly repository: string;
        readonly commitSha: string;
        readonly blobSha: string;
      };
}
