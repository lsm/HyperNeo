export interface SQLitePrefixRange {
  lowerBound: string;
  upperBound: string;
}

export function createSQLiteAsciiPrefixRange(prefix: string): SQLitePrefixRange {
  const isAscii = Array.from(prefix).every((character) => character.charCodeAt(0) <= 0x7f);
  if (prefix.length === 0 || !isAscii) {
    throw new Error('SQLite prefix range requires a non-empty ASCII prefix');
  }
  for (let index = prefix.length - 1; index >= 0; index--) {
    const code = prefix.charCodeAt(index);
    if (code < 0x7f) {
      return {
        lowerBound: prefix,
        upperBound: `${prefix.slice(0, index)}${String.fromCharCode(code + 1)}`,
      };
    }
  }
  throw new Error('SQLite prefix range has no finite upper bound');
}
