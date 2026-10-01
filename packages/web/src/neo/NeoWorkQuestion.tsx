import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkQuestionResource } from './NeoWorkQuestionResource.tsx';

export function NeoWorkQuestion({ work }: { work: NeoWork }) {
  return <NeoWorkQuestionResource work={work} />;
}
