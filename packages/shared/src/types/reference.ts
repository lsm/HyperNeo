export type ReferenceType = 'file' | 'folder';

export interface ReferenceMention {
  type: ReferenceType;
  id: string;
  displayText: string;
}

export interface ReferenceSearchResult {
  type: ReferenceType;
  id: string;
  shortId?: string;
  displayText: string;
  subtitle?: string;
}

export interface ResolvedReference {
  type: ReferenceType;
  id: string;
  data: unknown;
}

export interface ResolvedFileData {
  path: string;
  content: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
  mtime: string;
}

export interface FolderEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export interface ResolvedFileReference extends ResolvedReference {
  type: 'file';
  data: ResolvedFileData;
}

export interface ResolvedFolderReference extends ResolvedReference {
  type: 'folder';
  data: {
    path: string;
    entries: FolderEntry[];
  };
}

export type ReferenceMetadata = Record<
  string,
  { type: ReferenceType; id: string; displayText: string; status?: string }
>;

export const REFERENCE_PATTERN = /@ref\{([^}:]+):([^}]+)\}/g;
