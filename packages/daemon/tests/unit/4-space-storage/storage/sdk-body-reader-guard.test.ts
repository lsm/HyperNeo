import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../src', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function directReads(source: string): string[] {
  const literals = source.match(/`(?:\\[\s\S]|[^`])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g) ?? [];
  return literals.filter((literal) => {
    const sql = literal.slice(1, -1).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
    if (!/^\s*\(?(?:SELECT|WITH|INSERT|UPDATE)\b/i.test(sql)) return false;
    if (!/\b(?:FROM|JOIN|UPDATE)\s+sdk_messages\b/i.test(sql)) return false;
    const reads = sql
      .replace(/\bINSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+sdk_message_bodies\s*\([^)]*\)/gi, '')
      .replace(/\bAS\s+["`]?sdk_message["`]?/gi, '')
      .replace(/\bSET\s+sdk_message\s*=/gi, 'SET value=');
    return (
      /\bsdk_message\b/i.test(reads) ||
      /\bSELECT\s+(?:\w+\.)?\*\s+FROM\s+sdk_messages\b/i.test(reads)
    );
  });
}

describe('SDK body reader guard', () => {
  test('recognizes raw projections, JSON expressions, wildcard reads and writer source reads', () => {
    for (const sql of [
      'SELECT sdk_message FROM sdk_messages',
      'SELECT sm.sdk_message AS content FROM sdk_messages sm',
      "SELECT json_extract(sdk_message, '$.result') FROM sdk_messages",
      'SELECT * FROM sdk_messages WHERE id=?',
      "UPDATE sdk_messages SET sdk_message=json_set(sdk_message,'$.resolved',1) WHERE id=?",
      'INSERT OR IGNORE INTO sdk_message_bodies(seq,sdk_message) SELECT seq,sdk_message FROM sdk_messages',
    ])
      expect(directReads('const sql = `' + sql + '`;')).toHaveLength(1);
    expect(directReads('const sql = `SELECT id FROM sdk_messages`;')).toEqual([]);
  });

  test('all runtime readers use the central split body path', () => {
    const violations = files(root).flatMap((file) => {
      const path = relative(root, file);
      if (path.startsWith('storage/schema/')) return [];
      return directReads(readFileSync(file, 'utf8')).flatMap((sql) => {
        if (path === 'storage/repositories/sdk-message-body-read.ts') return [];
        if (
          (path === 'storage/sdk-message-body-copy.ts' ||
            path === 'storage/sdk-message-body-backup-worker.ts') &&
          /COALESCE\((?:octet_length\(b\.sdk_message\),octet_length\(m\.sdk_message\)|b\.sdk_message,m\.sdk_message)\)/.test(
            sql
          )
        )
          return [];
        if (
          path === 'storage/repositories/sdk-message-body-write.ts' &&
          (/INSERT INTO sdk_message_bodies/.test(sql) ||
            /UPDATE sdk_messages SET sdk_message=\(SELECT b.sdk_message/.test(sql))
        )
          return [];
        return [`${path}: ${sql.slice(0, 180)}`];
      });
    });
    expect(violations).toEqual([]);
  });
});
