export type PostApprovalTemplateContext = Readonly<Record<string, unknown>>;

export const POST_APPROVAL_TEMPLATE_KEYS = [
  'autonomy_level',
  'task_id',
  'task_title',
  'reviewer_name',
  'approval_source',
  'space_id',
  'workspace_path',
] as const;

export type PostApprovalTemplateKey = (typeof POST_APPROVAL_TEMPLATE_KEYS)[number];

export interface PostApprovalTemplateResult {
  text: string;
  missingKeys: string[];
}

const TOKEN_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function shellQuoteSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function interpolatePostApprovalTemplate(
  template: string,
  context: PostApprovalTemplateContext
): PostApprovalTemplateResult {
  if (!template) {
    return { text: template ?? '', missingKeys: [] };
  }

  const missingSeen = new Set<string>();
  const missingKeys: string[] = [];

  const text = template.replace(TOKEN_PATTERN, (match, rawKey: string) => {
    const key = rawKey;
    if (key === 'workspace_path_sh') {
      const raw = (context as Record<string, unknown>)['workspace_path'];
      if (raw === undefined || raw === null) {
        missingSeen.add(key);
        missingKeys.push(key);
        return match;
      }
      return shellQuoteSingleQuoted(String(raw));
    }
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      const value = (context as Record<string, unknown>)[key];
      if (value === undefined || value === null) {
        if (!missingSeen.has(key)) {
          missingSeen.add(key);
          missingKeys.push(key);
        }
        return match;
      }
      return String(value);
    }
    if (!missingSeen.has(key)) {
      missingSeen.add(key);
      missingKeys.push(key);
    }
    return match;
  });

  return { text, missingKeys };
}
