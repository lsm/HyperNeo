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

const TABLE_LIST_STOP_WORDS = new Set([
  'as',
  'on',
  'using',
  'where',
  'group',
  'order',
  'limit',
  'having',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'full',
  'cross',
  'natural',
  'union',
  'except',
  'intersect',
  'window',
]);

function skipWhitespace(sql: string, pos: number): number {
  let i = pos;
  while (i < sql.length && /\s/.test(sql[i])) i++;
  return i;
}

function recordTableRef(
  sql: string,
  pos: number,
  exclude: Set<string>,
  refs: string[],
  spans?: TableRefSpan[]
): number | null {
  const start = skipWhitespace(sql, pos);
  const first = matchIdentifier(sql, start);
  if (!first) return null;

  let name = first.ident;
  let end = first.end;
  let qualified = false;
  const afterFirst = skipWhitespace(sql, first.end);
  if (sql[afterFirst] === '.') {
    const second = matchIdentifier(sql, skipWhitespace(sql, afterFirst + 1));
    if (second) {
      name = second.ident;
      end = second.end;
      qualified = true;
    }
  }

  if (qualified || !exclude.has(name)) {
    if (!refs.includes(name)) refs.push(name);
    spans?.push({ name, start, end });
  }
  return end;
}

const CLAUSE_END_WORDS = new Set([
  'where',
  'group',
  'order',
  'limit',
  'having',
  'union',
  'except',
  'intersect',
  'window',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'full',
  'cross',
  'natural',
]);

function skipJoinConstraint(sql: string, from: number): number | null {
  let depth = 0;
  let i = from;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return null;
      depth--;
    } else if (depth === 0 && ch === ',') return i;
    else if (depth === 0 && /[\p{L}_]/u.test(ch)) {
      const word = matchIdentifier(sql, i);
      if (word) {
        if (CLAUSE_END_WORDS.has(word.ident)) return null;
        i = word.end;
        continue;
      }
    }
    i++;
  }
  return null;
}

function skipQuotedAlias(sql: string, pos: number): number | null {
  const open = sql[pos];
  const close = open === '[' ? ']' : open;
  if (open !== "'" && open !== '[' && open !== '"' && open !== '`') return null;
  let i = pos + 1;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (close === "'" && sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

function consumeCommaTableList(
  sql: string,
  from: number,
  exclude: Set<string>,
  refs: string[],
  spans?: TableRefSpan[]
): number {
  let pos = from;
  for (;;) {
    let probe = skipWhitespace(sql, pos);
    const quoted = skipQuotedAlias(sql, probe);
    if (quoted !== null) {
      pos = quoted;
      continue;
    }
    const alias = matchIdentifier(sql, probe);
    if (alias && alias.ident === 'as') {
      const afterAs = skipWhitespace(sql, alias.end);
      const quotedNamed = skipQuotedAlias(sql, afterAs);
      if (quotedNamed !== null) {
        pos = quotedNamed;
        continue;
      }
      const named = matchIdentifier(sql, afterAs);
      if (named) {
        pos = named.end;
        continue;
      }
    } else if (alias && (alias.ident === 'on' || alias.ident === 'using')) {
      const comma = skipJoinConstraint(sql, alias.end);
      if (comma === null) return pos;
      const next = recordTableRef(sql, comma + 1, exclude, refs, spans);
      if (next === null) return pos;
      pos = next;
      continue;
    } else if (alias && !TABLE_LIST_STOP_WORDS.has(alias.ident)) {
      pos = alias.end;
      continue;
    }
    probe = skipWhitespace(sql, pos);
    if (sql[probe] !== ',') return pos;
    const next = recordTableRef(sql, probe + 1, exclude, refs, spans);
    if (next === null) return pos;
    pos = next;
  }
}

export interface TableRefSpan {
  name: string;
  start: number;
  end: number;
}

export function maskCommentsAndStrings(sql: string): string {
  const out = sql.split('');
  const len = sql.length;
  let i = 0;

  while (i < len) {
    if (sql[i] === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          out[i] = ' ';
          i++;
        }
      }
    } else if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out[i] = ' ';
        i++;
      }
      if (i < len) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
    } else {
      i++;
    }
  }

  return out.join('');
}

export function extractTableRefSpans(sql: string): TableRefSpan[] {
  const positional = maskCommentsAndStrings(sql);
  const { cteNames } = extractCtes(normalizeWhitespace(positional));
  const spans: TableRefSpan[] = [];
  extractTableRefs(positional, cteNames, spans);
  return spans;
}

function extractTableRefs(sql: string, exclude: Set<string>, spans?: TableRefSpan[]): string[] {
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
      const end = recordTableRef(sql, i + 4, exclude, refs, spans);
      if (end !== null) {
        i = consumeCommaTableList(sql, end, exclude, refs, spans);
        continue;
      }
    }

    let joinMatched = false;
    const prefixes = ['LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL'];
    for (const prefix of prefixes) {
      if (atKeyword(i, prefix) && isWordBoundary(i + prefix.length)) {
        let pos = skipWhitespace(sql, i + prefix.length);
        if (
          (prefix === 'LEFT' || prefix === 'RIGHT' || prefix === 'FULL') &&
          atKeyword(pos, 'OUTER') &&
          isWordBoundary(pos + 5)
        ) {
          pos = skipWhitespace(sql, pos + 5);
        }
        if (atKeyword(pos, 'JOIN') && isWordBoundary(pos + 4)) {
          const end = recordTableRef(sql, pos + 4, exclude, refs, spans);
          if (end !== null) {
            i = consumeCommaTableList(sql, end, exclude, refs, spans);
            joinMatched = true;
            break;
          }
        }
        break;
      }
    }

    if (!joinMatched && atKeyword(i, 'JOIN') && isWordBoundary(i + 4)) {
      const end = recordTableRef(sql, i + 4, exclude, refs, spans);
      if (end !== null) {
        i = consumeCommaTableList(sql, end, exclude, refs, spans);
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
