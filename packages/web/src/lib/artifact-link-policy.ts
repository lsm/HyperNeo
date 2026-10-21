import superpipe, { type PipelineAPI } from 'superpipe';

export type ArtifactLinkDecision =
  | { kind: 'anchor'; href: string }
  | { kind: 'external'; url: string }
  | { kind: 'refused' };

export type ArtifactImageDecision = { kind: 'admit'; src: string } | { kind: 'refused' };

type LinkGate = { value: string } | { reason: ArtifactLinkDecision };

const refused = { kind: 'refused' as const };
const externalProtocols = new Set(['http:', 'https:', 'mailto:']);
const embeddedRaster = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;

const normalize = (href: string) =>
  href.replace(/^[\u0000-\x20]+|[\u0000-\x20]+$/g, '').replace(/[\t\n\r]/g, '');

export function gateFragment(href: string): LinkGate {
  return href.startsWith('#') ? { reason: { kind: 'anchor', href } } : { value: href };
}

export function gateExternalUrl(href: string): LinkGate {
  if (!URL.canParse(href)) return { reason: refused };
  const url = new URL(href);
  if (!externalProtocols.has(url.protocol) || url.username || url.password)
    return { reason: refused };
  return { value: url.href };
}

export const decideArtifactLink = (superpipe({})('artifact-link-decision') as PipelineAPI)
  .input(['href'])
  .pipe(normalize, 'href', 'href')
  .pipe(gateFragment, 'href', 'result:decision')
  .pipe(gateExternalUrl, 'decision', 'result:decision')
  .pipe((url: string) => ({ kind: 'external', url }), 'decision', 'decision')
  .end('decision') as (href: string) => ArtifactLinkDecision;

export function decideArtifactImage(src: string): ArtifactImageDecision {
  return embeddedRaster.test(src) ? { kind: 'admit', src } : refused;
}
