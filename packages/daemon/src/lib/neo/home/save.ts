import type { HomeFailure } from './conflicts.ts';
import { z } from 'zod';

export const HomeSaveInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  message: z.string().trim().min(1).max(2000),
  questionId: z.string().min(1).optional(),
  conflictQuestionId: z
    .string()
    .min(1)
    .optional()
    .describe('The answered conflict choice; separate from protected-file questionId.'),
});
export const HomeSaveResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string(), questionId: z.string().optional() }),
  z.object({ ok: z.literal(true), path: z.string(), commit: z.string() }),
]);
export type HomeSaveInput = z.infer<typeof HomeSaveInput>;
export type HomeSavePlan = HomeSaveInput & {
  resolution?: { questionId: string; version: 'local' | 'remote' };
  confirmation?: { questionId: string; entry: string };
};
export type HomeSaveResult = z.infer<typeof HomeSaveResult> | HomeFailure;

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

export function requireHomeSave(input: HomeSaveInput, publish = true) {
  const sensitive =
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(input.content) ||
    /(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{16,}/.test(input.content) ||
    /(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[^\s"']{16,}/i.test(input.content);
  const reason = !input.content.isWellFormed()
    ? 'content_refused: content must be well-formed Unicode text.'
    : publish && sensitive
      ? 'content_refused: private keys or credential-like content cannot be published.'
      : null;
  return reason ? { reason: { ok: false as const, reason } } : { value: input };
}

export function isVisibleHomeProposal(text: string, confirm: { path: string; sha256: string }) {
  const pathText = confirm.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiter = String.raw`[\s"'\x60()\[\]{}:;,!?<>]`;
  const shownPath = new RegExp(
    `(?:^|${delimiter})(\\*{1,3}|_{1,3}|~~)?${pathText}\\1(?=$|${delimiter})`,
    'u'
  ).test(text);
  const shownHash = new RegExp(`(?<![a-f0-9])${confirm.sha256}(?![a-f0-9])`, 'iu').test(text);
  return shownPath && shownHash;
}
