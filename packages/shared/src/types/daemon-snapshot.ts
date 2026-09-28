export interface DaemonInventoryLink {
  readonly kind: string;
  readonly id: string;
}

export interface DaemonInventoryEntry {
  readonly id: string;
  readonly name: string;
  readonly status: string | null;
  readonly updatedAt: number;
  readonly workspacePath: string | null;
  readonly links: readonly DaemonInventoryLink[];
}

export interface DaemonInventoryPage {
  readonly kind: string;
  readonly total: number;
  readonly entries: readonly DaemonInventoryEntry[];
}

export interface DaemonSnapshot {
  readonly capturedAt: number;
  readonly resources: readonly (DaemonInventoryPage & { readonly truncated: boolean })[];
  readonly capabilities: readonly string[];
}
