import superpipe, { type PipelineAPI } from 'superpipe';

export type MarkdownImageCandidate = {
  src: string;
  alt: string;
  title: string;
};

export type MarkdownImageAdmission =
  | { kind: 'admit'; src: string; alt: string; title: string }
  | { kind: 'downgrade'; text: string };

type AdmissionGate = { value: MarkdownImageCandidate } | { reason: MarkdownImageAdmission };

const uriSchemePattern = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function urlScheme(url: string) {
  const normalized = url
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
    .replace(/[\t\n\r]/g, '');
  return uriSchemePattern.exec(normalized)?.[1].toLowerCase();
}

export function isAllowedMarkdownUrl(url: string, kind: 'link' | 'image') {
  const scheme = urlScheme(url);
  return (
    !scheme || scheme === 'http' || scheme === 'https' || (kind === 'link' && scheme === 'mailto')
  );
}

function toDowngrade(candidate: MarkdownImageCandidate): MarkdownImageAdmission {
  if (urlScheme(candidate.src) === 'data') {
    return { kind: 'downgrade', text: candidate.alt ? `[image: ${candidate.alt}]` : '[image]' };
  }
  const title = candidate.title ? ` "${candidate.title}"` : '';
  return { kind: 'downgrade', text: `![${candidate.alt}](${candidate.src}${title})` };
}

export function gateSrcPresent(candidate: MarkdownImageCandidate): AdmissionGate {
  if (!candidate.src) return { reason: toDowngrade(candidate) };
  return { value: candidate };
}

export function gateSchemeAllowed(candidate: MarkdownImageCandidate): AdmissionGate {
  if (!isAllowedMarkdownUrl(candidate.src, 'image')) return { reason: toDowngrade(candidate) };
  return { value: candidate };
}

function toAdmission(candidate: MarkdownImageCandidate): MarkdownImageAdmission {
  return { kind: 'admit', src: candidate.src, alt: candidate.alt, title: candidate.title };
}

export const decideMarkdownImage = (superpipe({})('markdown-image-admission') as PipelineAPI)
  .input(['candidate'])
  .pipe(gateSrcPresent, 'candidate', 'result:admission')
  .pipe(gateSchemeAllowed, 'admission', 'result:admission')
  .pipe(toAdmission, 'admission', 'admission')
  .end('admission') as (candidate: MarkdownImageCandidate) => MarkdownImageAdmission;
