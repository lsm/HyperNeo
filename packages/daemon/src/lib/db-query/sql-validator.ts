/**
 * SQL validation layer for the db-query MCP server.
 *
 * Provides fast, helpful error messages for obviously invalid queries before
 * they reach SQLite. This is NOT a security boundary — write prevention is
 * handled by the read-only connection. The goal is to fail fast with clear
 * messages for common mistakes.
 */

/** Result of SQL validation, including extracted table references. */
export interface SqlValidationResult {
  /** Whether the statement passed all checks. */
  valid: boolean;
  /** Human-readable error message when validation fails. */
  error?: string;
  /** Table names referenced in FROM / JOIN clauses (CTE names excluded). */
  tableRefs: string[];
}

// ============ Internal helpers ============

/**
 * Strip line comments (--) and block comments (/* *​/) from SQL.
 * Does NOT handle nested block comments (SQL doesn't support them).
 */
function stripComments(sql: string): string {
  let result = sql;

  // Block comments first (so we don't match inside them with line-comment regex)
  result = result.replace(/\/\*[\s\S]*?\*\//g, ' ');

  // Line comments
  result = result.replace(/--[^\n]*/g, ' ');

  return result;
}

/**
 * Collapse runs of whitespace into single spaces and trim.
 */
function normalizeWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Replace contents of single-quoted string literals with spaces.
 * Handles SQL-standard escaped quotes ('') correctly.
 * Preserves the outer quote characters so string boundaries are maintained.
 *
 * This allows subsequent checks (semicolons, NULL bytes, FROM/JOIN extraction)
 * to ignore content inside string literals.
 */
function stripStringContents(sql: string): string {
  let result = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    if (sql[i] === "'") {
      result += "'";
      i++;
      // Scan string body, handling '' escaped quotes
      while (i < len) {
        if (sql[i] === "'" && i + 1 < len && sql[i + 1] === "'") {
          // Escaped quote — replace both quotes with spaces
          result += '  ';
          i += 2;
        } else if (sql[i] === "'") {
          // Closing quote
          result += "'";
          i++;
          break;
        } else {
          // Regular character inside string — replace with space
          result += ' ';
          i++;
        }
      }
    } else {
      result += sql[i];
      i++;
    }
  }

  return result;
}

/**
 * Extract CTE names from a WITH ... AS (...) preamble.
 * Returns an object with cteNames (a set of CTE names)
 * and remaining (the SQL after the WITH block).
 *
 * Handles both single and multiple CTEs, as well as WITH RECURSIVE:
 *   WITH x AS (...), y AS (...) SELECT ...
 *   WITH RECURSIVE x AS (...) SELECT ...
 */
function extractCtes(sql: string): { cteNames: Set<string>; remaining: string } {
  const trimmed = sql.trimStart();

  // Must start with WITH (case-insensitive)
  if (!/^[Ww][Ii][Tt][Hh]\b/.test(trimmed)) {
    return { cteNames: new Set(), remaining: sql };
  }

  const cteNames = new Set<string>();
  let pos = 4; // skip "WITH"
  const len = trimmed.length;

  // Skip whitespace after WITH
  while (pos < len && /\s/.test(trimmed[pos])) pos++;

  // Check for optional RECURSIVE keyword
  if (pos + 8 <= len && trimmed.slice(pos, pos + 9).toLowerCase() === 'recursive') {
    pos += 9;
    // Skip whitespace after RECURSIVE
    while (pos < len && /\s/.test(trimmed[pos])) pos++;
  }

  while (pos < len) {
    // Extract CTE name (identifier)
    const nameStart = pos;
    while (pos < len && /[\p{L}\p{N}_]/u.test(trimmed[pos])) pos++;
    if (pos === nameStart) break; // no name found
    const cteName = trimmed.slice(nameStart, pos).toLowerCase();
    cteNames.add(cteName);

    // Skip whitespace
    while (pos < len && /\s/.test(trimmed[pos])) pos++;

    // Skip optional CTE column list: cnt(col1, col2, ...)
    if (pos < len && trimmed[pos] === '(') {
      let depth = 1;
      pos++;
      while (pos < len && depth > 0) {
        if (trimmed[pos] === '(') depth++;
        else if (trimmed[pos] === ')') depth--;
        pos++;
      }
      // Skip whitespace after column list
      while (pos < len && /\s/.test(trimmed[pos])) pos++;
    }

    // Expect "AS" keyword
    if (
      pos + 1 < len &&
      trimmed[pos].toLowerCase() === 'a' &&
      trimmed[pos + 1].toLowerCase() === 's'
    ) {
      pos += 2;
    } else {
      break;
    }

    // Skip whitespace
    while (pos < len && /\s/.test(trimmed[pos])) pos++;

    // Skip parenthesised CTE body — track nesting depth
    if (pos < len && trimmed[pos] === '(') {
      let depth = 1;
      pos++;
      while (pos < len && depth > 0) {
        if (trimmed[pos] === '(') {
          depth++;
          pos++;
        } else if (trimmed[pos] === ')') {
          depth--;
          pos++;
        } else if (trimmed[pos] === "'") {
          // Skip string literal, handling '' escaped quotes
          pos++; // skip opening quote
          while (pos < len) {
            if (trimmed[pos] === "'" && pos + 1 < len && trimmed[pos + 1] === "'") {
              pos += 2; // skip escaped ''
            } else if (trimmed[pos] === "'") {
              pos++; // skip closing quote
              break;
            } else {
              pos++;
            }
          }
        } else {
          pos++;
        }
      }
    }

    // Skip whitespace
    while (pos < len && /\s/.test(trimmed[pos])) pos++;

    // Check for trailing comma (more CTEs) or end of WITH block
    if (pos < len && trimmed[pos] === ',') {
      pos++;
      // Skip whitespace after comma
      while (pos < len && /\s/.test(trimmed[pos])) pos++;
    } else {
      break;
    }
  }

  return { cteNames, remaining: trimmed.slice(pos) };
}

/**
 * Match a SQL identifier (letters, digits, underscores, Unicode letters/digits)
 * starting at the given position. Returns the matched string in lowercase,
 * or null if no identifier is found. Advances the position past the match.
 */
function matchIdentifier(sql: string, pos: number): { ident: string; end: number } | null {
  const start = pos;
  const len = sql.length;
  while (pos < len && /[\p{L}\p{N}_]/u.test(sql[pos])) pos++;
  if (pos === start) return null;
  return { ident: sql.slice(start, pos).toLowerCase(), end: pos };
}

/**
 * Extract table name candidates from FROM and JOIN clauses.
 * Matches FROM <name> and JOIN <name> (any JOIN variant).
 * Skips names that appear in the exclude set (e.g., CTE names).
 * Handles schema-qualified names (e.g., main.tasks) by taking the
 * table name after the dot.
 *
 * Expects string literal contents to already be stripped (use stripStringContents first).
 */
function extractTableRefs(sql: string, exclude: Set<string>): string[] {
  const refs: string[] = [];

  // Case-insensitive keyword match helpers
  function atKeyword(pos: number, keyword: string): boolean {
    return sql.slice(pos, pos + keyword.length).toUpperCase() === keyword;
  }

  function isWordBoundary(pos: number): boolean {
    if (pos >= sql.length) return true;
    if (/[\s]/.test(sql[pos])) return true;
    // Common punctuation that terminates keywords
    return sql[pos] === '(' || sql[pos] === ')' || sql[pos] === ',';
  }

  let i = 0;
  const len = sql.length;

  while (i < len) {
    // Try matching FROM keyword
    if (atKeyword(i, 'FROM') && (i === 0 || isWordBoundary(i - 1)) && isWordBoundary(i + 4)) {
      let pos = i + 4;
      // Skip whitespace
      while (pos < len && /\s/.test(sql[pos])) pos++;
      // Match identifier (potentially schema-qualified)
      const first = matchIdentifier(sql, pos);
      if (first) {
        pos = first.end;
        // Check for schema.name pattern
        if (pos < len && sql[pos] === '.') {
          const second = matchIdentifier(sql, pos + 1);
          if (second) {
            const tableName = second.ident;
            if (!exclude.has(tableName) && !refs.includes(tableName)) {
              refs.push(tableName);
            }
            i = second.end;
            continue;
          }
        }
        // No dot — first ident is the table name
        if (!exclude.has(first.ident) && !refs.includes(first.ident)) {
          refs.push(first.ident);
        }
        i = first.end;
        continue;
      }
    }

    // Try matching JOIN keyword with optional prefix
    let joinMatched = false;
    // Check for optional prefix keywords (case-insensitive)
    const prefixes = ['LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL'];
    for (const prefix of prefixes) {
      if (atKeyword(i, prefix) && isWordBoundary(i + prefix.length)) {
        let pos = i + prefix.length;
        // Skip whitespace between prefix and optional OUTER
        while (pos < len && /\s/.test(sql[pos])) pos++;
        // Check for OUTER after LEFT/RIGHT/FULL
        if (
          (prefix === 'LEFT' || prefix === 'RIGHT' || prefix === 'FULL') &&
          atKeyword(pos, 'OUTER') &&
          isWordBoundary(pos + 5)
        ) {
          pos += 5;
          // Skip whitespace between OUTER and JOIN
          while (pos < len && /\s/.test(sql[pos])) pos++;
        }
        // Now expect JOIN
        if (atKeyword(pos, 'JOIN') && isWordBoundary(pos + 4)) {
          let jpos = pos + 4;
          // Skip whitespace
          while (jpos < len && /\s/.test(sql[jpos])) jpos++;
          // Match identifier (potentially schema-qualified)
          const first = matchIdentifier(sql, jpos);
          if (first) {
            jpos = first.end;
            if (jpos < len && sql[jpos] === '.') {
              const second = matchIdentifier(sql, jpos + 1);
              if (second) {
                const tableName = second.ident;
                if (!exclude.has(tableName) && !refs.includes(tableName)) {
                  refs.push(tableName);
                }
                i = second.end;
                joinMatched = true;
                break;
              }
            }
            if (!exclude.has(first.ident) && !refs.includes(first.ident)) {
              refs.push(first.ident);
            }
            i = first.end;
            joinMatched = true;
            break;
          }
        }
        break;
      }
    }

    // Plain JOIN (no prefix)
    if (!joinMatched && atKeyword(i, 'JOIN') && isWordBoundary(i + 4)) {
      let jpos = i + 4;
      // Skip whitespace
      while (jpos < len && /\s/.test(sql[jpos])) jpos++;
      const first = matchIdentifier(sql, jpos);
      if (first) {
        jpos = first.end;
        if (jpos < len && sql[jpos] === '.') {
          const second = matchIdentifier(sql, jpos + 1);
          if (second) {
            const tableName = second.ident;
            if (!exclude.has(tableName) && !refs.includes(tableName)) {
              refs.push(tableName);
            }
            i = second.end;
            continue;
          }
        }
        if (!exclude.has(first.ident) && !refs.includes(first.ident)) {
          refs.push(first.ident);
        }
        i = first.end;
        continue;
      }
    }

    i++;
  }

  return refs;
}

// ============ Public API ============

/**
 * Check whether the SQL contains a top-level set operator
 * (UNION, INTERSECT, or EXCEPT) at depth 0 (outside parentheses).
 * This allows UNION ALL inside CTE bodies (e.g. WITH RECURSIVE)
 * while rejecting top-level compound queries.
 *
 * Precondition: `sql` must have string literal contents stripped
 * (via `stripStringContents`) so that parentheses inside strings don't
 * affect depth tracking.
 */
function hasTopLevelSetOperator(sql: string): boolean {
  const upper = sql.toUpperCase();
  const setOperators = ['UNION', 'INTERSECT', 'EXCEPT'];
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
    else if (depth === 0) {
      for (const op of setOperators) {
        if (upper.slice(i, i + op.length) === op) {
          const beforeOk = i === 0 || /\s/.test(sql[i - 1]);
          const afterChar = i + op.length < sql.length ? sql[i + op.length] : ' ';
          const afterOk = /\s/.test(afterChar);
          if (beforeOk && afterOk) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Validate a SQL statement for use with the db-query MCP server.
 *
 * Checks:
 * 1. Rejects NULL bytes (outside string literals)
 * 2. Rejects semicolons (outside string literals)
 * 3. Strips comments and normalizes whitespace
 * 4. Requires the statement to start with SELECT (or WITH followed by SELECT)
 * 5. Extracts table references from FROM / JOIN clauses (excluding CTE names)
 *
 * String literal contents are stripped before dangerous-character checks and
 * table-ref extraction, so legitimate queries containing semicolons or SQL
 * keywords inside string values are handled correctly.
 *
 * @param sql - The raw SQL string to validate.
 * @returns Validation result with valid flag, optional error, and extracted tableRefs.
 */
export function validateSql(sql: string): SqlValidationResult {
  // Strip comments first (so we can safely check for dangerous chars)
  const withoutComments = stripComments(sql);

  // Strip string literal contents so keywords/delimiters inside strings
  // don't trigger false positives.
  const withoutStrings = stripStringContents(withoutComments);

  // Reject NULL bytes (now only outside string literals)
  if (withoutStrings.includes('\0')) {
    return { valid: false, error: 'NULL byte in SQL is not allowed', tableRefs: [] };
  }

  // Reject semicolons (now only outside string literals)
  if (withoutStrings.includes(';')) {
    return {
      valid: false,
      error: 'Semicolons are not allowed (single statement only)',
      tableRefs: [],
    };
  }

  // Reject double-quoted identifiers ("table") and backtick-quoted identifiers
  // (`table`). These bypass table-ref extraction and scope filtering.
  if (withoutStrings.includes('"') || withoutStrings.includes('`')) {
    return {
      valid: false,
      error: 'Quoted identifiers (double-quoted or backtick) are not allowed',
      tableRefs: [],
    };
  }

  // Reject OFFSET — the subquery wrapper strips LIMIT and would silently
  // drop OFFSET, breaking pagination without any indication to the caller.
  if (/\bOFFSET\b/i.test(withoutStrings)) {
    return {
      valid: false,
      error: 'OFFSET is not supported (use LIMIT only)',
      tableRefs: [],
    };
  }

  // Reject UNION at the top level only (not inside parentheses/CTE bodies).
  // WITH RECURSIVE uses UNION ALL inside CTE bodies, which is fine.
  // Top-level UNION is incompatible with the scope-wrapping subquery because
  // each arm gets rewritten to SELECT * with different column counts.
  if (hasTopLevelSetOperator(withoutStrings)) {
    return {
      valid: false,
      error:
        'Compound queries (UNION, INTERSECT, EXCEPT) are not supported (use CTEs or subqueries instead)',
      tableRefs: [],
    };
  }

  // Normalize whitespace
  const cleaned = normalizeWhitespace(withoutStrings);

  if (!cleaned) {
    return { valid: false, error: 'Empty SQL statement', tableRefs: [] };
  }

  // Handle CTEs — extract CTE names and get the remaining query
  const { cteNames, remaining } = extractCtes(cleaned);

  // The remaining (or full cleaned) statement must start with SELECT
  const checkSql = remaining.trimStart();
  if (!/^[Ss][Ee][Ll][Ee][Cc][Tt]\b/.test(checkSql)) {
    return {
      valid: false,
      error: 'Only SELECT statements are allowed',
      tableRefs: [],
    };
  }

  // Extract table refs from both the CTE bodies and the main query,
  // excluding CTE names themselves.
  const allRefs = extractTableRefs(cleaned, cteNames);

  return { valid: true, tableRefs: allRefs };
}
