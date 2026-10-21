import type { ArtifactPrSummary as PrSummary } from '@hyperneo/shared/types/artifact-pr';
import { previewReferenceCandidates } from '@hyperneo/shared/types/artifact-reference';
import { t } from '../../lib/i18n/index.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import { PreviewHeader } from './ArtifactPreview.tsx';

const STATES = {
  OPEN: 'artifact.prOPEN',
  MERGED: 'artifact.prMERGED',
  CLOSED: 'artifact.prCLOSED',
} as const;
const CHECKS = {
  pending: 'artifact.checks_pending',
  failing: 'artifact.checks_failing',
  passing: 'artifact.checks_passing',
} as const;
const REVIEWS = {
  approved: 'artifact.review_approved',
  changes_requested: 'artifact.review_changes_requested',
} as const;

const previewable = (path: string) => previewReferenceCandidates(path)[0]?.kind === 'local';

export function ArtifactPrSummary({
  pr,
  onBack,
  onOpenFile,
}: {
  pr: PrSummary;
  onBack: () => void;
  onOpenFile: (path: string) => void;
}) {
  const facts = [
    `${pr.repository} #${pr.number}`,
    t(STATES[pr.state]),
    pr.checks === 'none' ? '' : t(CHECKS[pr.checks]),
    pr.review === 'none' ? '' : t(REVIEWS[pr.review]),
    t('artifact.head', { sha: pr.headSha.slice(0, 7) }),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section class="flex h-full min-h-0 flex-col bg-surface text-fg">
      <PreviewHeader title={pr.title} facts={facts} onBack={onBack}>
        <button
          type="button"
          onClick={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}
          class="rounded-md px-3 py-1 text-sm text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          {t('artifact.openGitHub')}
        </button>
      </PreviewHeader>
      <div class="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-4">
        {pr.body.trim() && <MarkdownRenderer content={pr.body} artifactLinks />}
        <div>
          <h2 class="text-sm font-medium">
            {t('artifact.changedFiles', { count: pr.changedFiles })}
          </h2>
          <ul class="mt-2 space-y-1 text-sm">
            {pr.files.map((file) => {
              const label = (
                <>
                  <span class="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                  <span class="shrink-0 text-xs text-fg-muted">{`+${file.additions} −${file.deletions}`}</span>
                </>
              );
              return (
                <li key={file.path}>
                  {previewable(file.path) ? (
                    <button
                      type="button"
                      onClick={() => onOpenFile(file.path)}
                      class="flex w-full items-center gap-3 rounded-md px-2 py-1 text-left hover:bg-fill-soft"
                    >
                      {label}
                    </button>
                  ) : (
                    <div class="flex items-center gap-3 px-2 py-1 text-fg-muted">{label}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {pr.filesTruncated && (
            <p class="mt-2 text-xs text-fg-muted">
              {t('artifact.filesTruncated', { shown: pr.files.length, total: pr.changedFiles })}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
