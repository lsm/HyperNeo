import { z } from 'zod';

export const HomeSaveInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  message: z.string().trim().min(1).max(2000),
});
export const HomeSaveResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), path: z.string(), commit: z.string() }),
]);
export type HomeSaveInput = z.infer<typeof HomeSaveInput>;
export type HomeSaveResult = z.infer<typeof HomeSaveResult>;

export function requireHomePath<T extends { path: string }>(input: T) {
  const parts = input.path.split('/');
  const invalid =
    input.path.includes('\\') ||
    input.path.includes('\0') ||
    /^[A-Za-z]:/.test(input.path) ||
    parts.some((part) => !part || part.startsWith('.'));
  return invalid
    ? {
        reason: {
          ok: false as const,
          reason: 'invalid_path: use a relative document path outside hidden folders.',
        },
      }
    : { value: input };
}

export function requireHomeSave(input: HomeSaveInput) {
  const parts = input.path.split('/');
  const protectedDocument = ['direction.md', 'mandate.md'].includes(parts.at(-1)!.toLowerCase());
  const sensitive =
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(input.content) ||
    /(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{16,}/.test(input.content) ||
    /(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[^\s"']{16,}/i.test(input.content);
  const reason = protectedDocument
    ? 'confirmation_required: direction and mandate saves await human-confirmation support.'
    : !input.content.isWellFormed()
      ? 'content_refused: content must be well-formed Unicode text.'
      : sensitive
        ? 'content_refused: private keys or credential-like content cannot be saved.'
        : null;
  return reason ? { reason: { ok: false as const, reason } } : { value: input };
}
