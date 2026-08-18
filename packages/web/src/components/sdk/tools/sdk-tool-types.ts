export type FileReadOutput =
  | {
      type: 'text';
      file: {
        filePath: string;
        content: string;
        numLines: number;
        startLine: number;
        totalLines: number;
      };
    }
  | {
      type: 'image';
      file: {
        base64: string;
        type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        originalSize: number;
        dimensions?: {
          originalWidth?: number;
          originalHeight?: number;
          displayWidth?: number;
          displayHeight?: number;
        };
      };
    }
  | { type: 'notebook'; file: { filePath: string; cells: unknown[] } }
  | { type: 'pdf'; file: { filePath: string; base64: string; originalSize: number } }
  | {
      type: 'parts';
      file: { filePath: string; originalSize: number; count: number; outputDir: string };
    }
  | { type: 'file_unchanged'; file: { filePath: string } };

export function isFileReadOutput(output: unknown): output is FileReadOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    'type' in output &&
    ['text', 'image', 'notebook', 'pdf', 'parts', 'file_unchanged'].includes(
      (output as Record<string, unknown>).type as string
    )
  );
}

export interface FileEditOutput {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string | null;
  structuredPatch: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }[];
  userModified: boolean;
  replaceAll: boolean;
  gitDiff?: {
    filename: string;
    status: 'modified' | 'added';
    additions: number;
    deletions: number;
    changes: number;
    patch: string;
    repository?: string | null;
  };
}

export function isFileEditOutput(output: unknown): output is FileEditOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    'filePath' in output &&
    'structuredPatch' in output &&
    Array.isArray((output as Record<string, unknown>).structuredPatch)
  );
}

export interface FileWriteOutput {
  type: 'create' | 'update';
  filePath: string;
  content: string;
  structuredPatch: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }[];
  originalFile: string | null;
  gitDiff?: {
    filename: string;
    status: 'modified' | 'added';
    additions: number;
    deletions: number;
    changes: number;
    patch: string;
    repository?: string | null;
  };
  userModified?: boolean;
}

export function isFileWriteOutput(output: unknown): output is FileWriteOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    'type' in output &&
    ['create', 'update'].includes((output as Record<string, unknown>).type as string) &&
    'filePath' in output &&
    'structuredPatch' in output &&
    Array.isArray((output as Record<string, unknown>).structuredPatch)
  );
}
