import type { NeoInputOrigin } from './neo-message.ts';

export interface NeoPublicationLink {
  readonly label: string;
  readonly kind: 'concern' | 'work' | 'consultation';
  readonly id: string;
}

export interface NeoPublicationInput {
  readonly conversationId: string;
  readonly publicationId: string;
  readonly askOrigin: NeoInputOrigin;
  readonly producerInput: NeoInputOrigin;
  readonly shortText: string;
  readonly fullText: string;
  readonly links: readonly NeoPublicationLink[];
  readonly interim?: true;
  readonly askSummary?: string;
  readonly awaiting?: string;
}

export interface NeoPublication extends NeoPublicationInput {
  readonly sequence: number;
  readonly createdAt: string;
}

export type NeoPublicationAppendResult =
  | { accepted: true; created: boolean; publication: NeoPublication }
  | { accepted: false; reason: 'invalid_publication' | 'publication_conflict' };
