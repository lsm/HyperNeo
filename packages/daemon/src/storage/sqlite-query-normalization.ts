import { createHash } from 'node:crypto';

export const SQLITE_QUERY_DISPLAY_MAX_LENGTH = 512;

export interface SQLiteQueryDescriptor {
  fingerprint: string;
  normalizedSql: string;
  normalizedSqlTruncated: boolean;
}

const VALUE_TOKEN = '?';
const IDENTIFIER_TOKEN = '"#"';

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentifierChar(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch) || ch === '$';
}

function consumeSingleQuoted(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function consumeUntil(sql: string, start: number, terminator: string, escape: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (escape && sql[i] === escape && sql[i + 1] === terminator) {
      i += 2;
      continue;
    }
    if (sql[i] === terminator) return i + 1;
    i += 1;
  }
  return i;
}

function consumeNumber(sql: string, start: number): number {
  const n = sql.length;
  let i = start;
  if (
    sql[i] === '0' &&
    (sql[i + 1] === 'x' || sql[i + 1] === 'X') &&
    isHexDigit(sql[i + 2] ?? '')
  ) {
    i += 2;
    while (i < n && isHexDigit(sql[i])) i += 1;
    return i;
  }
  while (i < n && isDigit(sql[i])) i += 1;
  if (sql[i] === '.') {
    i += 1;
    while (i < n && isDigit(sql[i])) i += 1;
  }
  if (sql[i] === 'e' || sql[i] === 'E') {
    const exponentSign = sql[i + 1] === '+' || sql[i + 1] === '-' ? i + 2 : i + 1;
    if (isDigit(sql[exponentSign] ?? '')) {
      i = exponentSign;
      while (i < n && isDigit(sql[i])) i += 1;
    }
  }
  return i;
}

function lexSQLiteQuery(sql: string): string[] {
  const tokens: string[] = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i];

    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }

    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = i >= n ? n : i + 2;
      continue;
    }

    if (ch === "'") {
      i = consumeSingleQuoted(sql, i);
      tokens.push(VALUE_TOKEN);
      continue;
    }

    if (ch === '"') {
      i = consumeUntil(sql, i, '"', '"');
      tokens.push(IDENTIFIER_TOKEN);
      continue;
    }

    if (ch === '`') {
      i = consumeUntil(sql, i, '`', '');
      tokens.push(IDENTIFIER_TOKEN);
      continue;
    }

    if (ch === '[') {
      i = consumeUntil(sql, i, ']', '');
      tokens.push(IDENTIFIER_TOKEN);
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(sql[i + 1] ?? ''))) {
      i = consumeNumber(sql, i);
      tokens.push(VALUE_TOKEN);
      continue;
    }

    if (ch === '?') {
      i += 1;
      while (i < n && isDigit(sql[i])) i += 1;
      tokens.push(VALUE_TOKEN);
      continue;
    }

    if (ch === ':' || ch === '@' || ch === '$') {
      i += 1;
      while (i < n && isIdentifierChar(sql[i])) i += 1;
      tokens.push(VALUE_TOKEN);
      continue;
    }

    if (isIdentifierStart(ch)) {
      let word = '';
      while (i < n && isIdentifierChar(sql[i])) {
        word += sql[i];
        i += 1;
      }
      if ((word === 'x' || word === 'X') && sql[i] === "'") {
        i = consumeSingleQuoted(sql, i);
        tokens.push(VALUE_TOKEN);
        continue;
      }
      const lower = word.toLowerCase();
      tokens.push(lower === 'true' || lower === 'false' || lower === 'null' ? VALUE_TOKEN : lower);
      continue;
    }

    tokens.push(ch);
    i += 1;
  }

  return tokens;
}

export function normalizeSQLiteQuery(sql: string): string {
  return lexSQLiteQuery(sql)
    .join(' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+,/g, ',')
    .replace(/\bin\s*\(\?(?:\s*,\s*\?)+\)/g, 'in ( ?.. )')
    .trim();
}

export function createSQLiteQueryDescriptor(sql: string): SQLiteQueryDescriptor {
  const normalized = normalizeSQLiteQuery(sql);
  const truncated = normalized.length > SQLITE_QUERY_DISPLAY_MAX_LENGTH;
  return {
    fingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 16),
    normalizedSql: truncated ? normalized.slice(0, SQLITE_QUERY_DISPLAY_MAX_LENGTH) : normalized,
    normalizedSqlTruncated: truncated,
  };
}
