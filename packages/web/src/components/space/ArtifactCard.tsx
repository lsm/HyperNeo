/**
 * ArtifactCard — data-driven renderer for workflow run artifacts.
 *
 * Rendering is determined entirely by inspecting the shape of `artifact.data`,
 * NOT by the `artifactType` string.  The type is shown as a small badge/chip
 * on every card for human scanning, but never drives rendering logic.
 *
 * Renderer selection (first match wins):
 *   1. data.url matches a GitHub PR URL           → PrCard
 *   2. data.url matches a GitHub commit URL       → CommitRefCard
 *   3. data.url is any URL                        → LinkCard
 *   4. data has test_output / stdout / stderr     → TerminalOutputCard
 *   5. data has ONLY a `summary` string key       → MarkdownCard
 *   6. all data values are JSON primitives        → StructuredTableCard
 *   7. (default)                                  → GenericCard
 */

import type { WorkflowRunArtifact } from '@hyperneo/shared';

// ── URL pattern helpers ──────────────────────────────────────────────────────

const GITHUB_PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const GITHUB_COMMIT_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/;

function isUrl(val: unknown): val is string {
  return typeof val === 'string' && /^https?:\/\//.test(val);
}

// ── Renderer detector ────────────────────────────────────────────────────────

type RendererKind = 'pr' | 'commit-ref' | 'link' | 'terminal' | 'markdown' | 'table' | 'generic';

function detectRenderer(data: Record<string, unknown>): RendererKind {
  const url = typeof data.url === 'string' ? data.url : null;

  if (url && GITHUB_PR_RE.test(url)) return 'pr';
  if (url && GITHUB_COMMIT_RE.test(url)) return 'commit-ref';
  if (url && isUrl(url)) return 'link';
  if ('test_output' in data || 'stdout' in data || 'stderr' in data) return 'terminal';

  const keys = Object.keys(data);
  if (keys.length === 1 && keys[0] === 'summary' && typeof data.summary === 'string')
    return 'markdown';
  if (keys.length > 0 && keys.every((k) => isPrimitive(data[k]))) return 'table';

  return 'generic';
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// ── Shared sub-components ────────────────────────────────────────────────────

/** Small badge showing the artifact type label. */
function TypeBadge({ type }: { type: string }) {
  if (!type) return null;
  return (
    <span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-dark-600 text-gray-400 uppercase tracking-wide">
      {type}
    </span>
  );
}

const cardBase =
  'flex items-start gap-2 px-3 py-2 rounded bg-dark-700/50 border border-dark-600 w-full';

// ── Individual renderers ─────────────────────────────────────────────────────

function PrCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const { data } = artifact;
  const url = typeof data.url === 'string' ? data.url : null;
  const match = url ? GITHUB_PR_RE.exec(url) : null;
  const prNumber =
    typeof data.number === 'number' ? data.number : match ? parseInt(match[3], 10) : null;
  const title = typeof data.title === 'string' ? data.title : null;
  const state = typeof data.state === 'string' ? data.state : null;
  const headBranch = typeof data.headBranch === 'string' ? data.headBranch : null;

  const stateColor =
    state === 'open'
      ? 'text-green-400'
      : state === 'merged'
        ? 'text-purple-400'
        : state === 'closed'
          ? 'text-red-400'
          : 'text-gray-400';

  return (
    <div class={cardBase} data-testid="artifact-card-pr">
      {/* PR icon */}
      <svg
        class="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5"
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
      <div class="flex-1 min-w-0">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-blue-400 hover:text-blue-300 truncate block"
          >
            {prNumber != null ? `PR #${prNumber}` : 'Pull Request'}
            {title && <span class="text-gray-400 ml-1.5">— {title}</span>}
          </a>
        ) : (
          <span class="text-xs text-gray-300">
            {prNumber != null ? `PR #${prNumber}` : 'Pull Request'}
            {title && <span class="text-gray-400 ml-1.5">— {title}</span>}
          </span>
        )}
        {headBranch && <p class="text-xs text-gray-400 font-mono mt-0.5 truncate">{headBranch}</p>}
      </div>
      {state && <span class={`text-xs font-medium ${stateColor} flex-shrink-0`}>{state}</span>}
      <TypeBadge type={artifact.artifactType} />
    </div>
  );
}

function CommitRefCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const { data } = artifact;
  const url = typeof data.url === 'string' ? data.url : null;
  const match = url ? GITHUB_COMMIT_RE.exec(url) : null;
  const sha = typeof data.sha === 'string' ? data.sha : match ? match[3] : null;
  const shortSha = sha ? sha.slice(0, 7) : null;
  const message = typeof data.message === 'string' ? data.message : null;
  const author = typeof data.author === 'string' ? data.author : null;

  return (
    <div class={cardBase} data-testid="artifact-card-commit-ref">
      {/* Commit icon */}
      <svg
        class="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <circle cx="12" cy="12" r="3" stroke-width={2} />
        <path stroke-linecap="round" stroke-width={2} d="M12 3v6m0 6v6M3 12h6m6 0h6" />
      </svg>
      <div class="flex-1 min-w-0">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs font-mono text-blue-400 hover:text-blue-300"
          >
            {shortSha ?? 'commit'}
          </a>
        ) : (
          <span class="text-xs font-mono text-gray-400">{shortSha ?? 'commit'}</span>
        )}
        {message && <p class="text-xs text-gray-300 truncate mt-0.5">{message}</p>}
        {author && <p class="text-xs text-gray-400 mt-0.5">{author}</p>}
      </div>
      <TypeBadge type={artifact.artifactType} />
    </div>
  );
}

function LinkCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const { data } = artifact;
  const url = typeof data.url === 'string' ? data.url : '';
  const title = typeof data.title === 'string' ? data.title : url;

  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  return (
    <div class={cardBase} data-testid="artifact-card-link">
      <svg
        class="w-3.5 h-3.5 text-blue-400 flex-shrink-0 mt-0.5"
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
      <div class="flex-1 min-w-0">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs text-blue-400 hover:text-blue-300 truncate block"
        >
          {title}
        </a>
        <p class="text-xs text-gray-400 font-mono mt-0.5 truncate">{hostname}</p>
      </div>
      <TypeBadge type={artifact.artifactType} />
    </div>
  );
}

function TerminalOutputCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const { data } = artifact;
  const output =
    (typeof data.test_output === 'string' && data.test_output) ||
    (typeof data.stdout === 'string' && data.stdout) ||
    (typeof data.stderr === 'string' && data.stderr) ||
    '';

  const preview = output.split('\n').slice(0, 5).join('\n');
  const truncated = output.split('\n').length > 5;

  return (
    <div
      class="rounded border border-dark-600 bg-dark-800 overflow-hidden w-full"
      data-testid="artifact-card-terminal"
    >
      <div class="flex items-center justify-between px-3 py-1.5 border-b border-dark-700 bg-dark-700/50">
        <div class="flex items-center gap-1.5">
          <svg
            class="w-3.5 h-3.5 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M8 9l3 3-3 3m5 0h3"
            />
          </svg>
          <span class="text-xs text-gray-400">
            {'test_output' in data ? 'Test output' : 'stdout' in data ? 'stdout' : 'stderr'}
          </span>
        </div>
        <TypeBadge type={artifact.artifactType} />
      </div>
      <pre class="px-3 py-2 text-xs font-mono text-gray-300 overflow-x-auto whitespace-pre-wrap break-words">
        {preview}
        {truncated && <span class="text-gray-400">{'\n…'}</span>}
      </pre>
    </div>
  );
}

function MarkdownCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const summary = typeof artifact.data.summary === 'string' ? artifact.data.summary : '';

  return (
    <div
      class="rounded border border-dark-600 bg-dark-700/50 px-3 py-2 w-full"
      data-testid="artifact-card-markdown"
    >
      <div class="flex items-start justify-between gap-2 mb-1">
        <TypeBadge type={artifact.artifactType} />
      </div>
      <p class="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">{summary}</p>
    </div>
  );
}

function StructuredTableCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const entries = Object.entries(artifact.data);

  return (
    <div
      class="rounded border border-dark-600 bg-dark-700/50 overflow-hidden w-full"
      data-testid="artifact-card-table"
    >
      <div class="flex items-center justify-between px-3 py-1.5 border-b border-dark-700">
        <span class="text-xs text-gray-400">
          {entries.length} field{entries.length === 1 ? '' : 's'}
        </span>
        <TypeBadge type={artifact.artifactType} />
      </div>
      <table class="w-full text-xs">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} class="border-b border-dark-700/50 last:border-0">
              <td class="px-3 py-1.5 text-gray-400 font-mono align-top whitespace-nowrap w-1/3">
                {key}
              </td>
              <td class="px-3 py-1.5 text-gray-300 break-all">
                {value === null ? (
                  <span class="text-gray-400 italic">null</span>
                ) : typeof value === 'boolean' ? (
                  <span class={value ? 'text-green-400' : 'text-red-400'}>{String(value)}</span>
                ) : (
                  String(value)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GenericCard({ artifact }: { artifact: WorkflowRunArtifact }) {
  const keyCount = Object.keys(artifact.data).length;
  return (
    <div class={cardBase} data-testid="artifact-card-generic">
      <div class="flex-1 min-w-0">
        {artifact.artifactKey && (
          <p class="text-xs text-gray-400 font-mono truncate">{artifact.artifactKey}</p>
        )}
        <p class="text-xs text-gray-400">
          {keyCount} field{keyCount === 1 ? '' : 's'}
        </p>
      </div>
      <TypeBadge type={artifact.artifactType} />
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

interface ArtifactCardProps {
  artifact: WorkflowRunArtifact;
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  const renderer = detectRenderer(artifact.data);

  switch (renderer) {
    case 'pr':
      return <PrCard artifact={artifact} />;
    case 'commit-ref':
      return <CommitRefCard artifact={artifact} />;
    case 'link':
      return <LinkCard artifact={artifact} />;
    case 'terminal':
      return <TerminalOutputCard artifact={artifact} />;
    case 'markdown':
      return <MarkdownCard artifact={artifact} />;
    case 'table':
      return <StructuredTableCard artifact={artifact} />;
    default:
      return <GenericCard artifact={artifact} />;
  }
}
