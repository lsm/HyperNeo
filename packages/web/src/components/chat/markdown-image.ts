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

const delegatableHrefSchemes = new Set([
  'http',
  'https',
  'mailto',
  'tel',
  'ftp',
  'ftps',
  'irc',
  'ircs',
  'urn',
]);

function normalizeUri(uri: string) {
  return uri.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '');
}

function isAllowedImageSrc(src: string) {
  const normalized = normalizeUri(src);
  const schemeMatch = uriSchemePattern.exec(normalized);
  if (!schemeMatch) return true;
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') return true;
  return scheme === 'data' && /^data:image\//i.test(normalized);
}

export function isNavigatableHref(href: string) {
  const schemeMatch = uriSchemePattern.exec(normalizeUri(href));
  if (!schemeMatch) return true;
  return delegatableHrefSchemes.has(schemeMatch[1].toLowerCase());
}

function toDowngrade(candidate: MarkdownImageCandidate): MarkdownImageAdmission {
  const title = candidate.title ? ` "${candidate.title}"` : '';
  return { kind: 'downgrade', text: `![${candidate.alt}](${candidate.src}${title})` };
}

export function gateSrcPresent(candidate: MarkdownImageCandidate): AdmissionGate {
  if (!candidate.src) return { reason: toDowngrade(candidate) };
  return { value: candidate };
}

export function gateSchemeAllowed(candidate: MarkdownImageCandidate): AdmissionGate {
  if (!isAllowedImageSrc(candidate.src)) return { reason: toDowngrade(candidate) };
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
