import type { NeoStatusCode } from '@hyperneo/shared/types/neo-ask';

export interface NeoStatusLine {
  status: string;
  statusCodes: NeoStatusCode[];
}

export function neoStatusLine(
  english: Readonly<Record<string, string>>,
  codes: readonly NeoStatusCode[]
): NeoStatusLine {
  return {
    status: codes
      .map(({ code, params }) =>
        (english[code] ?? code).replace(
          /\{(\w+)\}/g,
          (match, name: string) => params[name] ?? match
        )
      )
      .join('; '),
    statusCodes: [...codes],
  };
}

export function neoTextStatus(text: string): NeoStatusLine {
  return { status: text, statusCodes: [] };
}
