import type { NeoInputOrigin } from './neo-message.ts';

export interface NeoPublicationLink {
  readonly label: string;
  readonly kind: 'project' | 'work' | 'consultation';
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
  readonly triggerId?: string;
  readonly askSummary?: string;
  readonly awaiting?: string;
  readonly editedAt?: string;
  readonly corrects?: string;
  readonly correctedBy?: string;
}

export interface NeoPublication extends NeoPublicationInput {
  readonly sequence: number;
  readonly createdAt: string;
}

export type NeoPublicationAppendResult =
  | { accepted: true; created: boolean; publication: NeoPublication }
  | {
      accepted: false;
      reason: 'invalid_publication' | 'publication_conflict' | 'trigger_already_published';
    };

export type NeoPublicationChangeResult =
  | { accepted: true; created: boolean; publication: NeoPublication }
  | { accepted: false; reason: 'not_found' | 'already_corrected' | 'publication_conflict' };
