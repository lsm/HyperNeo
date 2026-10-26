export interface NeoPreviewContext {
  readonly artifactId: string;
  readonly snapshot: string;
}
export interface NeoPreviewReference extends NeoPreviewContext {
  readonly displayName: string;
  readonly state: 'available' | 'unavailable';
}
