import { t } from '../../lib/i18n/index.ts';
import type { ArtifactHtml } from '../../lib/artifact-html-client.ts';

export function ArtifactHtmlDocument({ html }: { html: ArtifactHtml }) {
  const links = html.links.filter(({ href }) => {
    try {
      return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol);
    } catch {
      return false;
    }
  });
  return (
    <div class="flex h-full min-h-0 flex-col gap-3">
      {html.scriptsRemoved && (
        <p role="status" class="text-sm text-fg-muted">
          {t('artifact.scriptsDisabled')}
        </p>
      )}
      <iframe
        title={t('artifact.htmlFrame')}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={html.document}
        class="min-h-96 w-full flex-1 border-0 bg-surface"
      />
      {links.length > 0 && (
        <div class="flex flex-wrap gap-2" aria-label={t('artifact.externalLinks')}>
          {links.map((link, index) => (
            <button
              type="button"
              key={`${index}:${link.href}`}
              data-external-href={link.href}
              title={link.href}
              class="max-w-full break-all rounded-md px-3 py-1 text-sm text-fg-soft hover:bg-surface-raised"
            >
              {link.text || link.href}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
