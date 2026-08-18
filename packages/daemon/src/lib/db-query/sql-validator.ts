export interface SqlValidationResult {
  valid: boolean;
  error?: string;
  tableRefs: string[];
}

function stripComments(sql: string): string {
  let result = sql;

  result = result.replace(/\/\*[\s\S]*?\*\//g, ' ');

  result = result.replace(/--[^\n]*/g, ' ');

  return result;
}

function normalizeWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function stripStringContents(sql: string): string {
  let result = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    if (sql[i] === "'") {
      result += "'";
      i++;
      while (i < len) {
        if (sql[i] === "'" && i + 1 < len && sql[i + 1] === "'") {
          result += '  ';
          i += 2;
        } else if (sql[i] === "'") {
          result += "'";
          i++;
          break;
        } else {
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

function extractCtes(sql: string): { cteNames: Set<string>; remaining: string } {
  const trimmed = sql.trimStart();

  if (!/^[Ww][Ii][Tt][Hh]\b/.test(trimmed)) {
    return { cteNames: new Set(), remaining: sql };
  }

  const cteNames = new Set<string>();
  let pos = 4;
  const len = trimmed.length;

  while (pos < len && /\s/.test(trimmed[pos])) pos++;

  if (pos + 8 <= len && trimmed.slice(pos, pos + 9).toLowerCase() === 'recursive') {
    pos += 9;
    while (pos < len && /\s/.test(trimmed[pos])) pos++;
  }

  while (pos < len) {
    const nameStart = pos;
    while (pos < len && /[\p{L}\p{N}_]/u.test(trimmed[pos])) pos++;
    if (pos === nameStart) break;
    const cteName = trimmed.slice(nameStart, pos).toLowerCase();
    cteNames.add(cteName);

    while (pos < len && /\s/.test(trimmed[pos])) pos++;

    if (pos < len && trimmed[pos] === '(') {
      let depth = 1;
      pos++;
      while (pos < len && depth > 0) {
        if (trimmed[pos] === '(') depth++;
        else if (trimmed[pos] === ')') depth--;
        pos++;
      }
      while (pos < len && /\s/.test(trimmed[pos])) pos++;
    }

    if (
      pos + 1 < len &&
      trimmed[pos].toLowerCase() === 'a' &&
      trimmed[pos + 1].toLowerCase() === 's'
    ) {
      pos += 2;
    } else {
      break;
    }

    while (pos < len && /\s/.test(trimmed[pos])) pos++;

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
          pos++;
          while (pos < len) {
            if (trimmed[pos] === "'" && pos + 1 < len && trimmed[pos + 1] === "'") {
              pos += 2;
            } else if (trimmed[pos] === "'") {
              pos++;
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

    while (pos < len && /\s/.test(trimmed[pos])) pos++;

    if (pos < len && trimmed[pos] === ',') {
      pos++;
      while (pos < len && /\s/.test(trimmed[pos])) pos++;
    } else {
      break;
    }
  }

  return { cteNames, remaining: trimmed.slice(pos) };
}

function matchIdentifier(sql: string, pos: number): { ident: string; end: number } | null {
  const start = pos;
  const len = sql.length;
  while (pos < len && /[\p{L}\p{N}_]/u.test(sql[pos])) pos++;
  if (pos === start) return null;
  return { ident: sql.slice(start, pos).toLowerCase(), end: pos };
}

function extractTableRefs(sql: string, exclude: Set<string>): string[] {
  const refs: string[] = [];

  function atKeyword(pos: number, keyword: string): boolean {
    return sql.slice(pos, pos + keyword.length).toUpperCase() === keyword;
  }

  function isWordBoundary(pos: number): boolean {
    if (pos >= sql.length) return true;
    if (/[\s]/.test(sql[pos])) return true;
    return sql[pos] === '(' || sql[pos] === ')' || sql[pos] === ',';
  }

  let i = 0;
  const len = sql.length;

  while (i < len) {
    if (atKeyword(i, 'FROM') && (i === 0 || isWordBoundary(i - 1)) && isWordBoundary(i + 4)) {
      let pos = i + 4;
      while (pos < len && /\s/.test(sql[pos])) pos++;
      const first = matchIdentifier(sql, pos);
      if (first) {
        pos = first.end;
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
        if (!exclude.has(first.ident) && !refs.includes(first.ident)) {
          refs.push(first.ident);
        }
        i = first.end;
        continue;
      }
    }

    let joinMatched = false;
    const prefixes = ['LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL'];
    for (const prefix of prefixes) {
      if (atKeyword(i, prefix) && isWordBoundary(i + prefix.length)) {
        let pos = i + prefix.length;
        while (pos < len && /\s/.test(sql[pos])) pos++;
        if (
          (prefix === 'LEFT' || prefix === 'RIGHT' || prefix === 'FULL') &&
          atKeyword(pos, 'OUTER') &&
          isWordBoundary(pos + 5)
        ) {
          pos += 5;
          while (pos < len && /\s/.test(sql[pos])) pos++;
        }
        if (atKeyword(pos, 'JOIN') && isWordBoundary(pos + 4)) {
          let jpos = pos + 4;
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

    if (!joinMatched && atKeyword(i, 'JOIN') && isWordBoundary(i + 4)) {
      let jpos = i + 4;
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

export function validateSql(sql: string): SqlValidationResult {
  const withoutComments = stripComments(sql);

  const withoutStrings = stripStringContents(withoutComments);

  if (withoutStrings.includes('\0')) {
    return { valid: false, error: 'NULL byte in SQL is not allowed', tableRefs: [] };
  }

  if (withoutStrings.includes(';')) {
    return {
      valid: false,
      error: 'Semicolons are not allowed (single statement only)',
      tableRefs: [],
    };
  }

  if (withoutStrings.includes('"') || withoutStrings.includes('`')) {
    return {
      valid: false,
      error: 'Quoted identifiers (double-quoted or backtick) are not allowed',
      tableRefs: [],
    };
  }

  if (/\bOFFSET\b/i.test(withoutStrings)) {
    return {
      valid: false,
      error: 'OFFSET is not supported (use LIMIT only)',
      tableRefs: [],
    };
  }

  if (hasTopLevelSetOperator(withoutStrings)) {
    return {
      valid: false,
      error:
        'Compound queries (UNION, INTERSECT, EXCEPT) are not supported (use CTEs or subqueries instead)',
      tableRefs: [],
    };
  }

  const cleaned = normalizeWhitespace(withoutStrings);

  if (!cleaned) {
    return { valid: false, error: 'Empty SQL statement', tableRefs: [] };
  }

  const { cteNames, remaining } = extractCtes(cleaned);

  const checkSql = remaining.trimStart();
  if (!/^[Ss][Ee][Ll][Ee][Cc][Tt]\b/.test(checkSql)) {
    return {
      valid: false,
      error: 'Only SELECT statements are allowed',
      tableRefs: [],
    };
  }

  const allRefs = extractTableRefs(cleaned, cteNames);

  return { valid: true, tableRefs: allRefs };
}
