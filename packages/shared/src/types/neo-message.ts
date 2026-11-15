export interface NeoMessageOrigin {
  readonly sessionId: string;
  readonly messageId: string;
}

export interface NeoInputOrigin extends NeoMessageOrigin {
  readonly messageDbId?: string | null;
}
