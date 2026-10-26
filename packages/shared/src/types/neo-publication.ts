import type { ArtifactProjection } from './artifact-file.ts';

import type { NeoInputOrigin } from './neo-message.ts';

export interface NeoCardReply {
  readonly sourceMessageIds: readonly string[];
  readonly askId: string;
  readonly questionId: string;
  readonly mutationId: string;
}

export interface NeoPublicationLink {
  readonly label: string;
  readonly kind: 'project' | 'work' | 'consultation';
  readonly id: string;
}

export interface NeoPublicationRevision {
  readonly revisionId: string;
  readonly shortText: string;
  readonly fullText: string;
  readonly createdAt: string;
  readonly producerInput?: NeoInputOrigin;
  readonly askOrigin?: NeoInputOrigin;
  readonly awaiting?: string;
}

export interface NeoPublicationInput extends ArtifactProjection {
  readonly cardReply?: NeoCardReply;
  readonly conversationId: string;
  readonly publicationId: string;
  readonly askOrigin?: NeoInputOrigin;
  readonly producerInput?: NeoInputOrigin;
  readonly verbatim?: true;
  readonly shortText: string;
  readonly fullText: string;
  readonly links: readonly NeoPublicationLink[];
  readonly triggerId?: string;
  readonly replyTo?: readonly string[];
  readonly askSummary?: string;
  readonly awaiting?: string;
  readonly editedAt?: string;
  readonly editedBy?: string;
  readonly answerInput?: NeoInputOrigin;
  readonly answerOrigin?: NeoInputOrigin;
  readonly languageMismatch?: string;
  readonly requestedLanguage?: string;
  readonly revisionId?: string;
  readonly revisions?: readonly NeoPublicationRevision[];
}

export interface NeoPublication extends NeoPublicationInput {
  readonly sequence: number;
  readonly createdAt: string;
}

export type NeoPublicationAppendResult =
  | { accepted: true; created: boolean; publication: NeoPublication }
  | {
      accepted: false;
      reason: 'invalid_publication' | 'publication_conflict';
    };

export type NeoPublicationChangeResult =
  | { accepted: true; created: boolean; publication: NeoPublication }
  | { accepted: false; reason: 'not_found' | 'publication_conflict' };
