/**
 * Post-approval instruction template interpolator.
 *
 * PR 1/5 of the task-agent-as-post-approval-executor refactor. See
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §1.6 for the grammar.
 *
 * Grammar (intentionally minimal):
 *   - Tokens look like `{{identifier}}`.
 *   - `identifier` matches `[A-Za-z_][A-Za-z0-9_]*` (ASCII snake/camel).
 *   - Substitution is **single-pass**: the replacement text for `{{foo}}` is
 *     never re-scanned for further tokens. This prevents accidental macro
 *     expansion (and injection) from signalled payloads.
 *   - Unknown identifiers render as the literal token (e.g. `{{pr_url}}`)
 *     AND emit a runtime warning so operators can see which template slot
 *     failed to bind.
 *   - There are **no conditionals, iteration, or helper functions** — this is
 *     a deliberate contract, not a limitation to be expanded. If you find
 *     yourself wanting logic in the template, the logic belongs in the code
 *     that builds the context map.
 *   - Values are rendered verbatim via `String(value)` — no HTML-, shell-, or
 *     JSON-escaping. Templates are delivered to LLMs as plain text; escaping
 *     would corrupt URLs, titles, and free-text reviewer summaries.
 *   - ONE exception: `workspace_path` is rendered as a single-quote-escaped
 *     shell literal (see {@link shellQuoteSingleQuoted}) because its only
 *     consumer is the bash assignment `SPACE_WS=…` in the merge template. The
 *     path's user-controlled content may contain a single quote, which would
 *     otherwise break the generated shell command.
 *
 * Recognised context keys (per §1.6 of the plan — callers may supply any
 * subset, and they may include arbitrary extra keys forwarded from an
 * end-node's signalled `data` payload):
 *
 *   autonomy_level     — current space autonomy level (number as string)
 *   task_id            — the SpaceTask UUID
 *   task_title         — the task's `title`
 *   reviewer_name      — slot name of the approving reviewer agent
 *   approval_source    — 'human' | 'auto_policy' | 'agent'
 *   space_id           — owning Space's UUID
 *   workspace_path     — absolute workspace path for the space (rendered as a
 *                        single-quote-escaped shell literal — the merge
 *                        template assigns it to `SPACE_WS` in bash)
 *
 * Every other key in `context` is made available under its own name so
 * workflow authors can thread arbitrary payload fields (e.g. `{{pr_url}}`,
 * `{{merge_sha}}`) through the instruction template.
 */

/**
 * Context map passed to {@link interpolatePostApprovalTemplate}. Keys are
 * identifier-shaped strings; values are stringified via `String(value)`.
 */
export type PostApprovalTemplateContext = Readonly<Record<string, unknown>>;

/**
 * Known context keys the runtime always supplies. Declared as a constant so
 * callers (and tests) have a single source of truth when asserting coverage.
 */
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

/**
 * Result of an interpolation call.
 *
 *   - `text`           — the rendered string.
 *   - `missingKeys`    — identifiers that appeared in the template but were
 *                        not present in the context. De-duplicated, in order
 *                        of first appearance.
 *
 * The runtime caller should surface `missingKeys` via its logger (and, in
 * dev, via the session so the LLM sees the problem in its conversation).
 */
export interface PostApprovalTemplateResult {
  text: string;
  missingKeys: string[];
}

/**
 * Matches `{{identifier}}` with optional internal whitespace, e.g.
 *   `{{pr_url}}`     → group 1 = "pr_url"
 *   `{{ task_id }}`  → group 1 = "task_id"
 *
 * The identifier grammar matches the plan: ASCII letters, digits, underscore,
 * no leading digit. No dotted paths, no brackets, no helpers.
 */
const TOKEN_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Render a string as a POSIX single-quoted shell literal.
 *
 * The value is wrapped in single quotes and every embedded `'` is escaped as
 * `'\''`, so the result round-trips through `sh -c` (or a bash assignment) to
 * the original string regardless of its contents. Only used for the
 * `workspace_path` token, whose only consumer is the `SPACE_WS=` bash
 * assignment in the merge instructions.
 */
export function shellQuoteSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Interpolate a post-approval instruction template in a single pass.
 *
 * See file-level docstring for the full grammar contract.
 *
 * @param template Raw instruction text. An empty or whitespace-only string
 *                 round-trips unchanged with no missing keys.
 * @param context  Map of identifier → value. Values are rendered via
 *                 `String(value)`; `null`/`undefined` are treated as "missing"
 *                 so the token stays literal and the key is reported.
 */
export function interpolatePostApprovalTemplate(
  template: string,
  context: PostApprovalTemplateContext
): PostApprovalTemplateResult {
  if (!template) {
    return { text: template ?? '', missingKeys: [] };
  }

  const missingSeen = new Set<string>();
  const missingKeys: string[] = [];

  // Use the String.prototype.replace callback form — it iterates matches
  // left-to-right in a single pass and never re-scans the replacement text.
  const text = template.replace(TOKEN_PATTERN, (match, rawKey: string) => {
    const key = rawKey;
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      const value = (context as Record<string, unknown>)[key];
      if (value === undefined || value === null) {
        if (!missingSeen.has(key)) {
          missingSeen.add(key);
          missingKeys.push(key);
        }
        return match;
      }
      // `workspace_path` is the one token destined for a shell assignment —
      // render it as a shell-quoted literal so user-controlled single quotes in
      // the path cannot break the generated `SPACE_WS=…` command.
      if (key === 'workspace_path') {
        return shellQuoteSingleQuoted(String(value));
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
