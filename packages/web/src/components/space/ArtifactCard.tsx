import type {
  ArtifactShape,
  CommitSetArtifactData,
  CheckArtifactData,
  DecisionArtifactData,
  LinkArtifactData,
  MetricArtifactData,
  NoteArtifactData,
  WorkflowRunArtifact,
} from '@hyperneo/shared';
import { isArtifactShape, normalizeLinkData, resolveLegacyShape } from '@hyperneo/shared';

const cardBase =
  'flex items-start gap-2 px-3 py-2 rounded bg-fill-strong/50 border border-line-strong w-full';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function formatCounts(counts: unknown): string {
  if (!counts || typeof counts !== 'object') return '';
  const entries = Object.entries(counts as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'number'
  );
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${v} ${k}`).join(' · ');
}

function safeHref(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

interface LinkKindMeta {
  label: string;
  color: string;
  fork: boolean;
}

function linkKindMeta(kind: string): LinkKindMeta {
  switch (kind) {
    case 'pr':
      return { label: 'Pull Request', color: 'text-cat-purple', fork: true };
    case 'issue':
      return { label: 'Issue', color: 'text-accent', fork: true };
    case 'preview':
      return { label: 'Preview', color: 'text-success', fork: false };
    case 'doc':
      return { label: 'Doc', color: 'text-fg-soft', fork: false };
    case 'post':
      return { label: 'Post', color: 'text-fg-soft', fork: false };
    default:
      return { label: kind ? capitalize(kind) : 'Link', color: 'text-accent', fork: false };
  }
}

function stateColor(state: string): string {
  switch (state) {
    case 'open':
      return 'text-success';
    case 'merged':
      return 'text-cat-purple';
    case 'closed':
      return 'text-danger';
    default:
      return 'text-fg-muted';
  }
}

function LinkIcon({ fork, color }: { fork: boolean; color: string }) {
  if (fork) {
    return (
      <svg
        class={`w-4 h-4 flex-shrink-0 mt-0.5 ${color}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
        />
      </svg>
    );
  }
  return (
    <svg
      class={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${color}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
      />
    </svg>
  );
}

function LinkCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const data = artifact.data as unknown as LinkArtifactData;
  const url = str(data.url);
  const kind = str(data.kind);
  const meta = linkKindMeta(kind);
  const number = typeof data.number === 'number' ? data.number : null;
  const title = str(data.title);
  const state = str(data.state);

  let label: string;
  if (number != null && (kind === 'pr' || kind === 'issue')) {
    label = `${meta.label} #${number}`;
    if (title) label += ` — ${title}`;
  } else if (title) {
    label = title;
  } else {
    label = url || meta.label;
  }

  let hostname = '';
  if (url) {
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = url;
    }
  }
  const showHost = !!hostname && label !== url && number == null;
  const href = safeHref(url);

  return (
    <div class={cardBase} data-testid="artifact-card-link">
      <LinkIcon fork={meta.fork} color={meta.color} />
      <div class="flex-1 min-w-0">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-accent hover:text-accent-soft truncate block"
          >
            {label}
          </a>
        ) : (
          <span class="text-xs text-fg-soft truncate block">{label}</span>
        )}
        {showHost && <p class="text-xs text-fg-muted font-mono mt-0.5 truncate">{hostname}</p>}
      </div>
      {state && (
        <span class={`text-xs font-medium flex-shrink-0 ${stateColor(state)}`}>{state}</span>
      )}
    </div>
  );
}

function CommitSetCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const data = artifact.data as CommitSetArtifactData;
  const commits = Array.isArray(data.commits)
    ? (data.commits as unknown[]).filter(
        (c): c is Record<string, unknown> => c !== null && typeof c === 'object'
      )
    : [];
  const additions = typeof data.additions === 'number' ? data.additions : null;
  const deletions = typeof data.deletions === 'number' ? data.deletions : null;
  const branch = str(data.branch);
  const head = str(data.head);
  const shown = commits.slice(0, 5);

  return (
    <div
      class="rounded border border-line-strong bg-fill-strong/50 overflow-hidden w-full"
      data-testid="artifact-card-commit-set"
    >
      <div class="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-line">
        <div class="flex items-center gap-1.5 min-w-0">
          <svg
            class="w-3.5 h-3.5 text-fg-muted flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <circle cx="12" cy="12" r="3" stroke-width={2} />
            <path stroke-linecap="round" stroke-width={2} d="M12 3v6m0 6v6M3 12h6m6 0h6" />
          </svg>
          <span class="text-xs text-fg-soft flex-shrink-0">
            {commits.length} commit{commits.length === 1 ? '' : 's'}
          </span>
          {(branch || head) && (
            <span class="text-xs text-fg-muted font-mono truncate">
              {branch}
              {head && ` @ ${head.slice(0, 7)}`}
            </span>
          )}
        </div>
        <div class="flex items-center gap-1 text-xs font-mono flex-shrink-0">
          {additions != null && <span class="text-success">+{additions}</span>}
          {deletions != null && <span class="text-danger">-{deletions}</span>}
        </div>
      </div>
      {shown.length > 0 && (
        <div class="px-3 py-1 space-y-0.5">
          {shown.map((c, i) => {
            const sha = str(c.sha).slice(0, 7);
            const message = str(c.message);
            return (
              <div key={i} class="flex items-center gap-2 text-xs min-w-0">
                {sha && <span class="font-mono text-fg-muted flex-shrink-0">{sha}</span>}
                <span class="text-fg-soft truncate">{message}</span>
              </div>
            );
          })}
          {commits.length > shown.length && (
            <p class="text-xs text-fg-muted">+{commits.length - shown.length} more</p>
          )}
        </div>
      )}
    </div>
  );
}

interface CheckStatusMeta {
  bg: string;
  color: string;
}

function checkStatusMeta(status: string): CheckStatusMeta {
  switch (status) {
    case 'pass':
    case 'passed':
      return { bg: 'bg-success/15', color: 'text-success' };
    case 'fail':
    case 'failed':
      return { bg: 'bg-danger/15', color: 'text-danger' };
    case 'running':
      return { bg: 'bg-accent/15', color: 'text-accent' };
    default:
      return { bg: 'bg-line-strong', color: 'text-fg-muted' };
  }
}

function CheckCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const data = artifact.data as unknown as CheckArtifactData;
  const name = str(data.name);
  const status = str(data.status);
  const counts = formatCounts(data.counts);
  const href = safeHref(str(data.url));
  const meta = checkStatusMeta(status);

  return (
    <div class={cardBase} data-testid="artifact-card-check">
      <span
        class={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${meta.bg} ${meta.color}`}
      >
        {status || 'unknown'}
      </span>
      <div class="flex-1 min-w-0">
        <span class="text-xs text-fg-soft">{name}</span>
        {counts && <span class="text-xs text-fg-muted ml-2">{counts}</span>}
      </div>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs text-accent hover:text-accent-soft flex-shrink-0"
        >
          view
        </a>
      )}
    </div>
  );
}

function MetricCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const data = artifact.data as unknown as MetricArtifactData;
  const name = str(data.name);
  const value = data.value;
  const unit = str(data.unit);
  const target = data.target;
  const hasValue = typeof value === 'number' || typeof value === 'string';
  const hasTarget = typeof target === 'number' || typeof target === 'string';

  return (
    <div class={cardBase} data-testid="artifact-card-metric">
      <svg
        class="w-3.5 h-3.5 text-fg-muted flex-shrink-0 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M3 12h4l3-8 4 16 3-8h4"
        />
      </svg>
      <div class="flex-1 min-w-0 text-xs flex items-baseline gap-1.5 flex-wrap">
        <span class="text-fg-muted font-mono">{name}</span>
        {hasValue && (
          <span class="text-fg font-medium">
            {String(value)}
            {unit && <span class="text-fg-muted font-normal ml-0.5">{unit}</span>}
          </span>
        )}
        {hasTarget && (
          <span class="text-fg-muted">
            → {String(target)}
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

interface DecisionMeta {
  bg: string;
  color: string;
}

function decisionMeta(recommendation: string): DecisionMeta {
  switch (recommendation) {
    case 'approve':
    case 'approved':
      return { bg: 'bg-success/15', color: 'text-success' };
    case 'request_changes':
      return { bg: 'bg-warning/15', color: 'text-warning' };
    case 'reject':
    case 'rejected':
      return { bg: 'bg-danger/15', color: 'text-danger' };
    default:
      return { bg: 'bg-line-strong', color: 'text-fg-muted' };
  }
}

function DecisionCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const data = artifact.data as unknown as DecisionArtifactData;
  const recommendation = str(data.recommendation);
  const summary = str(data.summary);
  const counts = formatCounts(data.counts);
  const urlHref = safeHref(str(artifact.data.url));
  const reviewHref = safeHref(str(artifact.data.review_url));
  const prHref = safeHref(str(artifact.data.pr_url));
  const picked = urlHref
    ? { href: urlHref, label: 'view' }
    : reviewHref
      ? { href: reviewHref, label: 'review' }
      : prHref
        ? { href: prHref, label: 'view' }
        : null;
  const meta = decisionMeta(recommendation);

  return (
    <div class={cardBase} data-testid="artifact-card-decision">
      <span
        class={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${meta.bg} ${meta.color}`}
      >
        {recommendation || 'decision'}
      </span>
      <div class="flex-1 min-w-0">
        {summary && <span class="text-xs text-fg-soft">{summary}</span>}
        {counts && <span class="text-xs text-fg-muted ml-2">{counts}</span>}
      </div>
      {picked && (
        <a
          href={picked.href}
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs text-accent hover:text-accent-soft flex-shrink-0"
        >
          {picked.label}
        </a>
      )}
    </div>
  );
}

function NoteCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const data = artifact.data as NoteArtifactData;
  const text = str(data.text) || str(data.summary);
  const ts = str(data.ts);

  return (
    <div class={cardBase} data-testid="artifact-card-note">
      <svg
        class="w-3.5 h-3.5 text-fg-muted flex-shrink-0 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <p class="flex-1 min-w-0 text-xs text-fg-soft whitespace-pre-wrap break-words leading-relaxed">
        {text}
      </p>
      {ts && <span class="text-xs text-fg-muted font-mono flex-shrink-0">{ts}</span>}
    </div>
  );
}

function GenericCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const keyCount = Object.keys(artifact.data).length;
  return (
    <div class={cardBase} data-testid="artifact-card-generic">
      <svg
        class="w-3.5 h-3.5 text-fg-muted flex-shrink-0 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
        />
      </svg>
      <div class="flex-1 min-w-0">
        {artifact.artifactKey && artifact.artifactKey !== 'default' && (
          <p class="text-xs text-fg-muted font-mono truncate">{artifact.artifactKey}</p>
        )}
        <p class="text-xs text-fg-muted">
          {artifact.artifactType || 'artifact'} · {keyCount} field{keyCount === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  );
}

interface ArtifactCardProps {
  artifact: WorkflowRunArtifact;
}

function resolveArtifactShape(artifact: WorkflowRunArtifact): ArtifactShape | null {
  const declared = artifact.artifactType;
  if (isArtifactShape(declared)) return declared;
  return resolveLegacyShape(declared, artifact.data) ?? null;
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  const shape = resolveArtifactShape(artifact);
  const linkArtifact =
    shape === 'link' ? { ...artifact, data: normalizeLinkData(artifact.data) } : artifact;

  switch (shape) {
    case 'link':
      return <LinkCard artifact={linkArtifact} />;
    case 'commit_set':
      return <CommitSetCard artifact={artifact} />;
    case 'check':
      return <CheckCard artifact={artifact} />;
    case 'metric':
      return <MetricCard artifact={artifact} />;
    case 'decision':
      return <DecisionCard artifact={artifact} />;
    case 'note':
      return <NoteCard artifact={artifact} />;
    default:
      return <GenericCard artifact={artifact} />;
  }
}
