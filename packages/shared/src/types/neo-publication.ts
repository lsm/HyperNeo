import type { ArtifactRef, PublicHandoffReference } from './artifact-file.ts';

import type { NeoInputOrigin } from './neo-message.ts';
import type { NeoQuestionSource } from './neo-ask.ts';

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
  readonly shortText?: string;
  readonly fullText: string;
  readonly session?: string;
  readonly sessionSource?: NeoQuestionSource | null;
  readonly createdAt: string;
  readonly producerInput?: NeoInputOrigin;
  readonly askOrigin?: NeoInputOrigin;
  readonly awaiting?: string;
}

export interface NeoPublicationInput {
  readonly artifacts?: readonly (ArtifactRef | PublicHandoffReference)[];
  readonly cardReply?: NeoCardReply;
  readonly conversationId: string;
  readonly publicationId: string;
  readonly askOrigin?: NeoInputOrigin;
  readonly producerInput?: NeoInputOrigin;
  readonly shortText?: string;
  readonly verbatim?: true;
  readonly fullText: string;
  readonly session?: string;
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
  readonly publishedBy?: 'front' | 'neo';
}

export interface NeoPublication extends NeoPublicationInput {
  readonly sessionSource?: NeoQuestionSource | null;
  readonly sequence: number;
  readonly createdAt: string;
}

export type NeoPublicationAppendResult =
  | { accepted: true; created: boolean; publication: NeoPublication }
  | {
      accepted: false;
      reason:
        | 'invalid_publication'
        | 'publication_conflict'
        | 'publication_superseded'
        | 'input_handed_off';
    };
