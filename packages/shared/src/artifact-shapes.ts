export const ARTIFACT_SHAPES = [
  'link',
  'commit_set',
  'check',
  'metric',
  'decision',
  'note',
] as const;

export type ArtifactShape = (typeof ARTIFACT_SHAPES)[number];

export interface LinkArtifactData {
  url: string;
  title?: string;
  kind?: string;
  state?: string;
  number?: number;
}

export interface CommitSetArtifactData {
  repo?: string;
  branch?: string;
  head?: string;
  commits?: Array<{ sha: string; message?: string; author?: string }>;
  additions?: number;
  deletions?: number;
  kind?: string;
}

export interface CheckArtifactData {
  name: string;
  status: string;
  counts?: Record<string, number>;
  url?: string;
  kind?: string;
}

export interface MetricArtifactData {
  name: string;
  value: number | string;
  unit?: string;
  target?: number | string;
  kind?: string;
}

export interface DecisionArtifactData {
  recommendation: string;
  summary?: string;
  counts?: Record<string, number>;
  kind?: string;
}

export interface NoteArtifactData {
  text?: string;
  summary?: string;
  ts?: string;
  kind?: string;
}

export type ArtifactShapeData =
  | LinkArtifactData
  | CommitSetArtifactData
  | CheckArtifactData
  | MetricArtifactData
  | DecisionArtifactData
  | NoteArtifactData;

export function resolveLegacyShape(
  type: string,
  data: Record<string, unknown> | undefined
): ArtifactShape | undefined {
  switch (type) {
    case 'pr':
      return 'link';
    case 'progress':
      return 'note';
    case 'review':
      return 'decision';
    case 'result': {
      const d = data ?? {};
      const hasSummary = typeof d.summary === 'string' && d.summary.length > 0;
      const hasUrl = findLinkUrl(d) !== null;
      return hasUrl && !hasSummary ? 'link' : 'decision';
    }
    default:
      return undefined;
  }
}

export function isArtifactShape(value: unknown): value is ArtifactShape {
  return typeof value === 'string' && (ARTIFACT_SHAPES as readonly string[]).includes(value);
}

function findLinkUrl(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  for (const [key, value] of Object.entries(data)) {
    if (
      (key === 'url' || key.endsWith('_url') || key.endsWith('Url')) &&
      typeof value === 'string' &&
      value
    ) {
      return value;
    }
  }
  return null;
}

export function normalizeLinkData(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.url === 'string' && data.url) return data;
  const url = findLinkUrl(data);
  if (!url) return data;
  return { ...data, url };
}

export function deriveArtifactKey(
  shape: ArtifactShape,
  data: Record<string, unknown>,
  explicitKey?: string
): string {
  const kind = typeof data.kind === 'string' && data.kind ? data.kind : '';
  switch (shape) {
    case 'note':
      if (explicitKey) return kind ? `${kind}:${explicitKey}` : explicitKey;
      return 'current';
    case 'link':
      return kind || 'default';
    case 'commit_set': {
      const repo = typeof data.repo === 'string' && data.repo ? data.repo : '';
      const branch = typeof data.branch === 'string' && data.branch ? data.branch : '';
      if (repo && branch) return `${repo}:${branch}`;
      return branch || repo || 'default';
    }
    case 'check':
    case 'metric': {
      const name = typeof data.name === 'string' && data.name ? data.name : '';
      return name || 'default';
    }
    case 'decision':
      if (explicitKey) return kind ? `${kind}:${explicitKey}` : explicitKey;
      return kind || 'current';
    default:
      return 'current';
  }
}

export type ArtifactValidation = { ok: true } | { ok: false; error: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateArtifactShape(
  shape: ArtifactShape,
  data: Record<string, unknown>
): ArtifactValidation {
  switch (shape) {
    case 'link': {
      if (!nonEmptyString(data.url)) {
        return { ok: false, error: "shape 'link' requires data.url (the URL)." };
      }
      try {
        const parsed = new URL(data.url as string);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            ok: false,
            error: `shape 'link' requires an http(s) URL (got '${parsed.protocol}').`,
          };
        }
      } catch {
        return { ok: false, error: "shape 'link' requires a valid http(s) URL." };
      }
      return { ok: true };
    }
    case 'check':
      if (!nonEmptyString(data.name)) {
        return { ok: false, error: "shape 'check' requires data.name (the check identity)." };
      }
      if (!nonEmptyString(data.status)) {
        return { ok: false, error: "shape 'check' requires data.status." };
      }
      return { ok: true };
    case 'metric':
      if (!nonEmptyString(data.name)) {
        return { ok: false, error: "shape 'metric' requires data.name (the metric identity)." };
      }
      if (
        data.value === undefined ||
        data.value === null ||
        (typeof data.value !== 'number' && typeof data.value !== 'string')
      ) {
        return {
          ok: false,
          error: "shape 'metric' requires data.value to be a number or string.",
        };
      }
      return { ok: true };
    case 'decision':
      if (!nonEmptyString(data.recommendation)) {
        return {
          ok: false,
          error: "shape 'decision' requires data.recommendation (e.g. 'approve').",
        };
      }
      return { ok: true };
    case 'commit_set':
      return { ok: true };
    case 'note':
      if (!nonEmptyString(data.text) && !nonEmptyString(data.summary) && !nonEmptyString(data.ts)) {
        return { ok: false, error: "shape 'note' requires data.text, data.summary, or data.ts." };
      }
      return { ok: true };
    default:
      return { ok: false, error: `Unknown shape '${shape as string}'.` };
  }
}
